export type SpeechSegment = { segmentId: string; sequence: number; text: string };

export class SpeechSafeSegmenter {
  private buffer = ""; private sequence = 0; private cancelled = false;
  private readonly maxChars: number;
  constructor(maxChars = 240) { this.maxChars = maxChars; }
  push(text: string): SpeechSegment[] { if (this.cancelled) return []; this.buffer = normalize(this.buffer + text); const segments: SpeechSegment[] = []; let boundary = findBoundary(this.buffer, this.maxChars); while (boundary > 0) { const value = this.buffer.slice(0, boundary).trim(); this.buffer = this.buffer.slice(boundary).trimStart(); if (value) segments.push(this.segment(value)); boundary = findBoundary(this.buffer, this.maxChars); } return segments; }
  flush(): SpeechSegment[] { if (this.cancelled || !this.buffer.trim()) return []; const value = this.buffer.trim(); this.buffer = ""; return [this.segment(value)]; }
  cancel(): void { this.cancelled = true; this.buffer = ""; }
  private segment(text: string): SpeechSegment { return { segmentId: `segment-${this.sequence}`, sequence: this.sequence++, text }; }
}

function normalize(text: string): string { return text.replace(/\[\[[\s\S]*?\]\]|<\/?[a-z][^>]*>/gi, "").replace(/\s+/g, " "); }
function findBoundary(text: string, maxChars: number): number { const punctuation = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"), text.lastIndexOf(";")); if (punctuation >= 0) return punctuation + 1; if (text.length >= maxChars) { const space = text.lastIndexOf(" ", maxChars); return space > 0 ? space : maxChars; } return 0; }
