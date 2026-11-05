export type SpeechSegment = { segmentId: string; sequence: number; text: string };

export class SpeechSafeSegmenter {
  private buffer = ""; private sequence = 0; private cancelled = false;
  private readonly maxChars: number;
  private readonly firstClauseMinChars: number | undefined;
  private readonly deterministicBoundaries:boolean;
  constructor(maxChars = 240, options: {firstClauseMinChars?: number;deterministicBoundaries?:boolean} = {}) {
    this.maxChars = maxChars;
    if(options.deterministicBoundaries!==undefined&&typeof options.deterministicBoundaries!=='boolean')throw Error('Invalid deterministic boundary option');
    this.deterministicBoundaries=options.deterministicBoundaries===true;
    const minimum=options.firstClauseMinChars;
    if(minimum!==undefined&&(!Number.isInteger(minimum)||minimum<32||minimum>maxChars))throw new Error('Invalid first-clause speech bound');
    this.firstClauseMinChars=minimum;
  }
  push(text: string, options:{completeTextUnit?:boolean} = {}): SpeechSegment[] {
    if (this.cancelled) return [];
    // Keep incomplete markup and whitespace intact until a safe boundary.
    this.buffer += text;
    if (this.buffer.length > 16_384) throw new Error("speech projection buffer limit exceeded");
    const segments: SpeechSegment[] = [];
    let boundary = this.boundary(options.completeTextUnit===true);
    while (boundary > 0) {
      const value = projectSpeech(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary);
      if (value) segments.push(this.segment(value));
      boundary = this.boundary(options.completeTextUnit===true);
    }
    return segments;
  }
  flush(): SpeechSegment[] { if (this.cancelled) return []; const value = projectSpeech(this.buffer); this.buffer = ""; return value ? [this.segment(value)] : []; }
  cancel(): void { this.cancelled = true; this.buffer = ""; }
  private boundary(completeTextUnit:boolean): number { return findBoundary(this.buffer,this.maxChars,this.sequence===0?this.firstClauseMinChars:undefined,this.deterministicBoundaries,this.deterministicBoundaries&&completeTextUnit); }
  private segment(text: string): SpeechSegment { return { segmentId: `segment-${this.sequence}`, sequence: this.sequence++, text }; }
}

export function projectSpeech(raw: string): string {
  return projectTables(raw).replace(/<(think|analysis|tool_call)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/giu, "")
    .replace(/\{\s*"[\s\S]*\}/gu, value => { try { JSON.parse(value); return " Structured details are shown on screen. "; } catch { return ""; } })
    .replace(/```[\s\S]*?(?:```|$)/gu, " Code is shown on screen. ")
    .replace(/`[^`]*(?:`|$)/gu, " code shown on screen ")
    .replace(/\[\[[\s\S]*?(?:\]\]|$)/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replace(/<\/?[a-z][^>]*(?:>|$)/giu, "")
    .replace(/https?:\/\/\S+/gu, "link shown on screen")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?![\d+-])|\d+\.\s+)/gmu, "")
    .replace(/(?<![\p{L}\p{N}])_+([^_]+)_+(?![\p{L}\p{N}])/gu, "$1")
    .replace(/(?<=\d)\s*\*\s*(?=[+-]?\d)/gu, " times ")
    .replace(/~~([^~]+)~~/gu, "$1")
    .replace(/~\s*(?=[+-]?\d)/gu, "approximately ")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/(?<![\p{L}\p{N}])\*([^*\n]+)\*(?![\p{L}\p{N}])/gu, "$1")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu, "")
    .replace(/\s+/gu, " ").trim();
}
function projectTables(raw:string):string {
  const lines=raw.split("\n"),output:string[]=[];
  const divider=(line:string)=>/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
  for(let i=0;i<lines.length;i++){
    if((lines[i]!.includes("|")&&divider(lines[i+1]??""))||/^\s*\|.+\|\s*$/u.test(lines[i]!)){
      output.push(" Table details are available in the conversation text. ");
      while(i+1<lines.length&&lines[i+1]!.trim()&&lines[i+1]!.includes("|"))i++;
    }else output.push(lines[i]!);
  }
  return output.join("\n");
}
function findBoundary(text: string, maxChars: number, firstClauseMinChars?: number,deterministicBoundaries=false,completeTextUnit=false): number {
  let bracket = 0, angle = false, ticks = 0, lastSpace = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    const tableCandidate=(index===0||text[index-1]==="\n")?text.slice(index).split("\n",2):[];
    if(tableCandidate.length&&(/^\s*\|/u.test(tableCandidate[0]!)||(tableCandidate[0]!.includes("|")&&/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(tableCandidate[1]??"")))){
      const end=text.indexOf("\n\n",index);
      if(end<0)return 0;
      return end+2;
    }
    if (character === "`") {
      const count = text.slice(index).match(/^`+/u)![0].length;
      if (!ticks) ticks = count; else if (ticks === count) ticks = 0;
      index += count - 1; continue;
    }
    if (ticks) continue;
    if (character === "{") {
      const rest=text.slice(index);
      if (/^\{\s*$/u.test(rest)) return 0;
      if (/^\{\s*"/u.test(rest)) {
        let depth=0,quoted=false,escaped=false;
        for(let cursor=index;cursor<text.length;cursor++){
          const c=text[cursor]!;
          if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
          if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0)return cursor+1;
        }
        return 0;
      }
    }
    if (character === "<") {
      const hidden = text.slice(index).match(/^<(think|analysis|tool_call)\b[^>]*>/iu);
      if (hidden) {
        const close = text.toLowerCase().indexOf(`</${hidden[1]!.toLowerCase()}>`, index + hidden[0].length);
        if (close < 0) return 0;
        index = close + hidden[1]!.length + 2; continue;
      }
    }
    if (character === "<" && (/^<(?:\/?[a-z]|!)/iu.test(text.slice(index)) || index === text.length-1)) angle = true;
    if (angle) { if (character === ">") angle = false; continue; }
    if (character === "[") bracket++;
    if (character === "]") bracket = Math.max(0, bracket - 1);
    if (bracket) continue;
    const tokenStart = text.lastIndexOf(" ", index - 1) + 1;
    const token = text.slice(tokenStart, index + 1);
    const inAddress = /https?:\/\/|[/\\@]|\]\(/u.test(token);
    // Only the first substantial spoken clause may use a comma pause. Wait for
    // whitespace so numeric separators and unfinished tokens remain intact;
    // measure projected text so hidden markup cannot satisfy the minimum.
    if(firstClauseMinChars!==undefined&&character===','&&!inAddress&&/\s/u.test(text[index+1]??(completeTextUnit?' ':''))&&projectSpeech(text.slice(0,index)).length>=firstClauseMinChars)return index+1;
    if (/[.!?;]/u.test(character) && !inAddress) {
      if (character === "." && (/\d\.$/u.test(token) || /^(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|e\.g|i\.e)\.$/iu.test(token) || /^[A-Z]\.$/u.test(token))) continue;
      // The publisher's complete validated text unit is followed by a canonical
      // separator or lawful EOF/display flush, so a virtual space is sound
      // lookahead. It does not flush an unfinished sentence or add text.
      const following = text[index + 1] ?? (completeTextUnit?' ':undefined);
      // A delta ending in a dot might continue as a filename or abbreviation.
      // Wait for one character of lookahead; flush handles actual response EOF.
      if (!following && (deterministicBoundaries || character === ".")) return 0;
      if (following && !/[\s"'”’*_]/u.test(following)) continue;
      return index + 1;
    }
    if (/\s/u.test(character) && !inAddress) {
      if (index >= maxChars && lastSpace) return index;
      lastSpace = index;
    }
  }
  if (completeTextUnit && text.length >= maxChars && !ticks && !bracket && !angle && lastSpace > 0) return text.length;
  if (!deterministicBoundaries && text.length >= maxChars && !ticks && !bracket && !angle && lastSpace > 0) return lastSpace;
  return 0;
}
