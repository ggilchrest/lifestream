import {VOICE_RESPONSE_VERSION,voiceResponseBounds} from '@lifestream/contracts/voice-response';

// Mirrors the unchanged strict router's full prose exclusion, BEFORE any cuts.
// This is not sanitation: every invalid record passes unchanged to that router.
const excludedProse=/[\r\n`|]|\[\[|<\/?[a-z][^>]*>|\[\/?voice-ignore\]|^\s*(?:\||#{1,6}\s|[-*+]\s)/iu;
const controls=/[\x00-\x08\x0b\x0c\x0e-\x1f]/u;
const whitespace=/\s/u;
const graphemes=new Intl.Segmenter('en',{granularity:'grapheme'});

/** Producer-boundary normalization only. The default strict router is unchanged
 * and remains the final authority. Input and normalized budgets are independent.
 * No malformed JSON, markup or ambiguous text boundary is repaired. */
export class VoiceProducerFramer {
  private buffer='';
  private pendingHigh='';
  private inputBytes=0;
  private outputBytes=0;
  private inputCharacters=0;
  private inputUnits=0;
  private outputUnits=0;
  private header=false;
  private speech=false;
  private display=false;
  private ended=false;

  push(delta:string):string {
    if(this.ended)return '';
    try{
      this.chargeInput(delta,false);
      const lines=(this.buffer+delta).split('\n');this.buffer=lines.pop()!;
      let output='';
      for(const line of lines)output+=this.record(line,'\n');
      // A high surrogate split between deltas is not yet an encoded character.
      const pendingBytes=this.buffer.length&&isHigh(this.buffer.charCodeAt(this.buffer.length-1))?3:0;
      if(Buffer.byteLength(this.buffer)-pendingBytes>voiceResponseBounds.frameBytes)throw Error('Voice producer frame limit exceeded');
      return output;
    }catch(error){this.cancel();throw error;}
  }
  finish():string {
    if(this.ended)return '';
    try{this.chargeInput('',true);const output=this.buffer?this.record(this.buffer,''):'';this.cancel();return output;}
    catch(error){this.cancel();throw error;}
  }
  cancel():void {this.ended=true;this.buffer='';this.pendingHigh='';}
  private chargeInput(delta:string,finish:boolean):void {
    let value=this.pendingHigh+delta;this.pendingHigh='';
    if(!finish&&value.length&&isHigh(value.charCodeAt(value.length-1))){this.pendingHigh=value.slice(-1);value=value.slice(0,-1);}
    this.inputBytes+=Buffer.byteLength(value);
    if(this.inputBytes>voiceResponseBounds.wireBytes)throw Error('Voice producer wire limit exceeded');
  }
  private record(raw:string,end:string):string {
    if(Buffer.byteLength(raw)>voiceResponseBounds.frameBytes)throw Error('Voice producer frame limit exceeded');
    if(!raw.trim())return this.emit(raw+end,0);
    let value:unknown;
    try{value=JSON.parse(raw);}catch{return this.emit(raw+end,0);}
    if(!value||typeof value!=='object'||Array.isArray(value))return this.emit(raw+end,0);
    const row=value as Record<string,unknown>;
    if(!this.header){
      if(Object.keys(row).join()==='version'&&row.version===VOICE_RESPONSE_VERSION)this.header=true;
      return this.emit(raw+end,0);
    }
    if(Object.keys(row).sort().join()!=='channel,text'||!['speech','display'].includes(String(row.channel))||typeof row.text!=='string'||!row.text.trim()||controls.test(row.text))return this.emit(raw+end,0);
    this.inputUnits++;this.inputCharacters+=row.text.length;
    if(this.inputUnits>voiceResponseBounds.units||this.inputCharacters>voiceResponseBounds.textCharacters)throw Error('Voice producer text limit exceeded');
    if(row.channel==='display'){
      if(this.speech)this.display=true;
      return this.emit(raw+end,1);
    }
    if(this.display||excludedProse.test(row.text))return this.emit(raw+end,1);
    if(row.text.length<=voiceResponseBounds.speechCharacters){this.speech=true;return this.emit(raw+end,1);}
    const parts=partition(row.text);
    if(!parts)return this.emit(raw+end,1);
    // Whole expansion is validated and charged before any part is published.
    const records=parts.map(text=>JSON.stringify({channel:'speech',text}));
    if(records.some(record=>Buffer.byteLength(record)>voiceResponseBounds.frameBytes))return this.emit(raw+end,1);
    const normalized=records.join('\n')+end;
    const output=this.emit(normalized,parts.length);this.speech=true;return output;
  }
  private emit(wire:string,units:number):string {
    const bytes=Buffer.byteLength(wire);
    if(this.outputBytes+bytes>voiceResponseBounds.wireBytes)throw Error('Normalized voice wire limit exceeded');
    if(this.outputUnits+units>voiceResponseBounds.units)throw Error('Normalized voice unit limit exceeded');
    this.outputBytes+=bytes;this.outputUnits+=units;return wire;
  }
}
function isHigh(value:number):boolean{return value>=0xd800&&value<=0xdbff;}
function partition(text:string):string[]|undefined {
  // Default router trims and joins units with one ASCII space. Only accept an
  // expansion that reconstructs the original string exactly under that rule.
  if(text!==text.trim()||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))return;
  const boundaries=new Set([...graphemes.segment(text)].map(part=>part.index));boundaries.add(text.length);
  const parts:string[]=[];let start=0;
  while(text.length-start>voiceResponseBounds.speechCharacters){
    let cut=Math.min(start+voiceResponseBounds.speechCharacters,text.length-1);
    for(;cut>start;cut--)if(text[cut]===' '&&boundaries.has(cut)&&boundaries.has(cut+1)&&!whitespace.test(text[cut-1]!)&&!whitespace.test(text[cut+1]!))break;
    if(cut===start)return;
    parts.push(text.slice(start,cut));start=cut+1;
  }
  parts.push(text.slice(start));
  if(parts.some(part=>!part||part.length>voiceResponseBounds.speechCharacters||part!==part.trim())||parts.join(' ')!==text)return;
  return parts;
}
