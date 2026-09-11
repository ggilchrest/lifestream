export type SpeechSegment = { segmentId: string; sequence: number; text: string };

export class SpeechSafeSegmenter {
  private buffer = ""; private sequence = 0; private cancelled = false;
  private readonly maxChars: number;
  constructor(maxChars = 240) { this.maxChars = maxChars; }
  push(text: string): SpeechSegment[] {
    if (this.cancelled) return [];
    // Keep incomplete markup and whitespace intact until a safe boundary.
    this.buffer += text;
    if (this.buffer.length > 16_384) throw new Error("speech projection buffer limit exceeded");
    const segments: SpeechSegment[] = [];
    let boundary = findBoundary(this.buffer, this.maxChars);
    while (boundary > 0) {
      const value = projectSpeech(this.buffer.slice(0, boundary));
      this.buffer = this.buffer.slice(boundary);
      if (value) segments.push(this.segment(value));
      boundary = findBoundary(this.buffer, this.maxChars);
    }
    return segments;
  }
  flush(): SpeechSegment[] { if (this.cancelled) return []; const value = projectSpeech(this.buffer); this.buffer = ""; return value ? [this.segment(value)] : []; }
  cancel(): void { this.cancelled = true; this.buffer = ""; }
  private segment(text: string): SpeechSegment { return { segmentId: `segment-${this.sequence}`, sequence: this.sequence++, text }; }
}

export function projectSpeech(raw: string): string {
  return raw.replace(/<(think|analysis|tool_call)\b[^>]*>[\s\S]*?(?:<\/\1>|$)/giu, "")
    .replace(/\{\s*"[\s\S]*\}/gu, value => { try { JSON.parse(value); return " Structured details are shown on screen. "; } catch { return ""; } })
    .replace(/```[\s\S]*?(?:```|$)/gu, " Code is shown on screen. ")
    .replace(/`[^`]*(?:`|$)/gu, " code shown on screen ")
    .replace(/\[\[[\s\S]*?(?:\]\]|$)/gu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replace(/<\/?[a-z][^>]*(?:>|$)/giu, "")
    .replace(/https?:\/\/\S+/gu, "link shown on screen")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gmu, "")
    .replace(/(?<![\p{L}\p{N}])_+([^_]+)_+(?![\p{L}\p{N}])/gu, "$1")
    .replace(/[*~]/gu, "")
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu, "")
    .replace(/\s+/gu, " ").trim();
}
function findBoundary(text: string, maxChars: number): number {
  let bracket = 0, angle = false, ticks = 0, lastSpace = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
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
    if (/[.!?;]/u.test(character) && !inAddress) {
      if (character === "." && (/\d\.$/u.test(token) || /^(?:Dr|Mr|Mrs|Ms|Prof|St|vs|etc|e\.g|i\.e)\.$/iu.test(token) || /^[A-Z]\.$/u.test(token))) continue;
      const following = text[index + 1];
      // A delta ending in a dot might continue as a filename or abbreviation.
      // Wait for one character of lookahead; flush handles actual response EOF.
      if (!following && character === ".") return 0;
      if (following && !/[\s"'”’*_]/u.test(following)) continue;
      return index + 1;
    }
    if (/\s/u.test(character) && !inAddress) {
      if (index >= maxChars && lastSpace) return index;
      lastSpace = index;
    }
  }
  if (text.length >= maxChars && !ticks && !bracket && !angle && lastSpace > 0) return lastSpace;
  return 0;
}
