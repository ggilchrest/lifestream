import {randomUUID} from 'node:crypto';
import type {Database} from './database.ts';
export type SavedVoice = {voiceRef:string;assistantId:string;revision:number;label:string;language:string;settings:Record<string,unknown>;providerBinding:string;createdAt:string};
export class SavedVoiceRepository {
  private readonly database:Database;
  constructor(database:Database) {this.database=database;}
  list(assistantId:string):SavedVoice[] {return (this.database.connection.prepare('SELECT definition_json AS json FROM saved_voice_definitions WHERE assistant_id=? ORDER BY revision DESC').all(assistantId) as {json:string}[]).map(row=>JSON.parse(row.json));}
  get(assistantId:string,voiceRef:string):SavedVoice|undefined {const row=this.database.connection.prepare('SELECT definition_json AS json FROM saved_voice_definitions WHERE assistant_id=? AND voice_ref=?').get(assistantId,voiceRef) as {json:string}|undefined;return row?JSON.parse(row.json):undefined;}
  create(input:Omit<SavedVoice,'voiceRef'|'revision'>):SavedVoice {
    return this.database.transaction(tx=>{
      const count=tx.get<{count:number}>('SELECT count(*) AS count FROM saved_voice_definitions WHERE assistant_id=?',input.assistantId)!.count;
      if(count>=16||JSON.stringify(input).length>900000)throw new Error('Saved voice candidate capacity reached.');
      const revision=(tx.get<{revision:number}>('SELECT max(revision) AS revision FROM saved_voice_definitions WHERE assistant_id=?',input.assistantId)?.revision??0)+1;
      const value={...structuredClone(input),voiceRef:'saved-voice:'+randomUUID(),revision};
      tx.run('INSERT INTO saved_voice_definitions VALUES (?,?,?,?)',value.voiceRef,value.assistantId,revision,JSON.stringify(value));return value;
    });
  }
  recordPreview(input:{voiceRef:string;principalId:string;sessionId:string;providerBinding:string},now=new Date()):string {
    const id=randomUUID(),at=now.toISOString(),expires=new Date(now.getTime()+30*60_000).toISOString();
    this.database.transaction(tx=>{tx.run('DELETE FROM saved_voice_previews WHERE expires_at<=? OR (voice_ref=? AND principal_id=? AND session_id=?)',at,input.voiceRef,input.principalId,input.sessionId);tx.run('INSERT INTO saved_voice_previews VALUES (?,?,?,?,?,?,?)',id,input.voiceRef,input.principalId,input.sessionId,input.providerBinding,at,expires);});return id;
  }
  reviewed(input:{previewId:string;voiceRef:string;principalId:string;sessionId:string;providerBinding:string},now=new Date()):boolean {
    return !!this.database.connection.prepare('SELECT 1 FROM saved_voice_previews WHERE preview_id=? AND voice_ref=? AND principal_id=? AND session_id=? AND provider_binding=? AND expires_at>?').get(input.previewId,input.voiceRef,input.principalId,input.sessionId,input.providerBinding,now.toISOString());
  }
  remove(assistantId:string,voiceRef:string,expectedRevision:number):void {
    this.database.transaction(tx=>{
      const voice=tx.get<{revision:number}>('SELECT revision FROM saved_voice_definitions WHERE assistant_id=? AND voice_ref=?',assistantId,voiceRef);
      if(!voice||voice.revision!==expectedRevision)throw new Error('Voice candidate changed or is unavailable.');
      if(tx.get("SELECT 1 FROM assistant_profiles WHERE assistant_id=? AND status='active' AND json_extract(profile_json,'$.voiceProfile')=?",assistantId,voiceRef))throw new Error('Activate another voice before removing the active definition.');
      tx.run('DELETE FROM saved_voice_previews WHERE voice_ref=?',voiceRef);tx.run('DELETE FROM saved_voice_definitions WHERE voice_ref=? AND assistant_id=?',voiceRef,assistantId);
    });
  }
}
