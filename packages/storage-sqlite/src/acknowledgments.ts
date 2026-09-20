import type {Database} from './database.ts';

export type AcknowledgmentArtifact = {sha256:string;bytes:number;format:'pcm_s16le';sampleRateHz:48000;channels:1;durationMs:number};
export type AcknowledgmentTrack = {schemaVersion:'1.0.0';cueSet:string;analysisRevision:string;timeUnit:'ms';timeOrigin:'audio-start';audioSha256:string;durationMs:number;cues:{startMs:number;endMs:number;cue:string}[]};
export type AcknowledgmentClip = {id:string;revision:number;text:string;createdAt:string;expiresAt:string|null;audio:AcknowledgmentArtifact;visemes?:{sha256:string;bytes:number;cueSet:string;analysisRevision:string}};
export type AcknowledgmentCatalog = {assistantId:string;revision:number;enabled:boolean;defaultTtlDays:number;binding:string;clips:AcknowledgmentClip[];lastSweepDay:string|null};
export const acknowledgmentTtl=(value:unknown):number=>{if(!Number.isInteger(value)||Number(value)<1||Number(value)>365)throw new Error('Use a whole number of days from 1 to 365.');return Number(value);};

/** One CAS document owns membership, preferences and the daily rotation marker.
 * Immutable artifacts live separately; only committed membership grants access. */
export class AcknowledgmentRepository {
  private readonly database:Database;
  constructor(database:Database){this.database=database;}
  get(assistantId:string):AcknowledgmentCatalog|undefined {
    const row=this.database.connection.prepare('SELECT catalog_json AS json FROM acknowledgment_catalogs WHERE assistant_id=?').get(assistantId) as {json:string}|undefined;
    return row?JSON.parse(row.json):undefined;
  }
  enabled():string[]{return (this.database.connection.prepare("SELECT assistant_id AS id FROM acknowledgment_catalogs WHERE json_extract(catalog_json,'$.enabled')=1 ORDER BY assistant_id LIMIT 128").all() as {id:string}[]).map(x=>x.id);}
  artifacts():string[]{const catalogs=this.database.connection.prepare('SELECT catalog_json AS json FROM acknowledgment_catalogs').all() as {json:string}[];return catalogs.flatMap(row=>(JSON.parse(row.json) as AcknowledgmentCatalog).clips.flatMap(c=>[c.audio.sha256,...(c.visemes?[c.visemes.sha256]:[])]));}
  ensure(assistantId:string,binding:string):AcknowledgmentCatalog {
    return this.database.transaction(tx=>{
      const found=tx.get<{json:string}>('SELECT catalog_json AS json FROM acknowledgment_catalogs WHERE assistant_id=?',assistantId);
      if(found){const catalog: AcknowledgmentCatalog=JSON.parse(found.json);if(catalog.binding===binding)return catalog;catalog.binding=binding;catalog.clips=[];catalog.revision++;tx.run('UPDATE acknowledgment_catalogs SET revision=?,catalog_json=? WHERE assistant_id=?',catalog.revision,JSON.stringify(catalog),assistantId);return catalog;}
      const catalog:AcknowledgmentCatalog={assistantId,binding,revision:1,enabled:false,defaultTtlDays:5,clips:[],lastSweepDay:null};
      tx.run('INSERT INTO acknowledgment_catalogs VALUES (?,?,?)',assistantId,catalog.revision,JSON.stringify(catalog));return catalog;
    });
  }
  update(assistantId:string,expectedRevision:number,change:(catalog:AcknowledgmentCatalog)=>void):AcknowledgmentCatalog {
    return this.database.transaction(tx=>{
      const row=tx.get<{json:string}>('SELECT catalog_json AS json FROM acknowledgment_catalogs WHERE assistant_id=? AND revision=?',assistantId,expectedRevision);
      if(!row)throw new Error('Acknowledgment catalog changed; refresh before editing.');
      const catalog:AcknowledgmentCatalog=JSON.parse(row.json);change(catalog);catalog.revision++;
      if(catalog.clips.length>5||new Set(catalog.clips.map(x=>x.id)).size!==catalog.clips.length||new Set(catalog.clips.map(x=>x.text.toLocaleLowerCase('en'))).size!==catalog.clips.length)throw new Error('Invalid acknowledgment membership.');
      acknowledgmentTtl(catalog.defaultTtlDays);tx.run('UPDATE acknowledgment_catalogs SET revision=?,catalog_json=? WHERE assistant_id=?',catalog.revision,JSON.stringify(catalog),assistantId);return catalog;
    });
  }
  configure(assistantId:string,expectedRevision:number,enabled:boolean,defaultTtlDays:number){if(typeof enabled!=='boolean')throw new Error('Choose enabled or disabled.');return this.update(assistantId,expectedRevision,c=>{c.enabled=enabled;c.defaultTtlDays=acknowledgmentTtl(defaultTtlDays);});}
  edit(assistantId:string,expectedRevision:number,id:string,clipRevision:number,expiresAt:string|null|'remove',now=Date.now()){
    return this.update(assistantId,expectedRevision,c=>{const clip=c.clips.find(x=>x.id===id);if(!clip||clip.revision!==clipRevision)throw new Error('Acknowledgment clip changed; refresh before editing.');
      if(expiresAt==='remove'){c.clips=c.clips.filter(x=>x!==clip);return;}
      if(expiresAt!==null&&(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=now||Date.parse(expiresAt)>now+365*86400000))throw new Error('Choose a future expiry within 365 days, or keep indefinitely.');
      clip.expiresAt=expiresAt;clip.revision++;
    });
  }
}
