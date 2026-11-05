import { VOICE_RESPONSE_VERSION, voiceResponseBounds, type VoiceResponseUnit } from "@lifestream/contracts/voice-response";

/** Diagnostic reasons are minted only by this parser, never inferred from messages. */
export const voiceResponseFramingReasons = ['wire_limit', 'frame_limit', 'missing_speech', 'malformed_record', 'invalid_record', 'unsupported_framing', 'invalid_unit', 'text_limit', 'speech_after_display', 'invalid_speech_prose', 'display_before_speech'] as const;
export type VoiceResponseFramingReason = typeof voiceResponseFramingReasons[number];
export type VoiceResponseFramingDetail = Readonly<{subreason:'json_parse'|'speech_length'|'speech_linebreak'|'speech_formatting';recordOrdinal:number;recordBytes:number;headerSeen:boolean;speechCharacters?:number}>;
const framingDetails = new WeakMap<object, VoiceResponseFramingDetail>();
const framingErrors = new WeakMap<object, VoiceResponseFramingReason>();
class VoiceResponseFramingError extends Error {
  constructor(reason: VoiceResponseFramingReason, message: string, detail?:VoiceResponseFramingDetail) {
    super(message);
    framingErrors.set(this, reason);
    if(detail)framingDetails.set(this,Object.freeze({...detail}));
  }
}
export function voiceResponseFramingReason(error: unknown): VoiceResponseFramingReason | undefined {
  return error instanceof Error ? framingErrors.get(error) : undefined;
}

/** Parser-minted scalar metadata only; copied/forged errors cannot carry it. */
export function voiceResponseFramingDetail(error:unknown):VoiceResponseFramingDetail|undefined {
  return error instanceof Error?framingDetails.get(error):undefined;
}

/** One bounded JSON record per line: header, speech units, optional display tail.
 * Unclassified bytes never enter speech/history. No repair/model call occurs.
 * JSON string escaping makes literal routing examples ordinary content.
 */
export class VoiceResponseRouter {
  private buffer = "";
  private header = false;
  private display = false;
  private speech = false;
  private ended = false;
  private wireBytes = 0;
  private characters = 0;
  private units = 0;
  private recordOrdinal = 0;
  push(delta: string): VoiceResponseUnit[] {
    if (this.ended) return [];
    try {
      this.wireBytes += Buffer.byteLength(delta);
      if (this.wireBytes > voiceResponseBounds.wireBytes) throw new VoiceResponseFramingError("wire_limit", "Voice response wire limit exceeded");
      const records = (this.buffer + delta).split("\n");
      this.buffer = records.pop()!;
      const output = records.flatMap(record => this.record(record));
      if (Buffer.byteLength(this.buffer) > voiceResponseBounds.frameBytes) throw new VoiceResponseFramingError("frame_limit", "Voice response frame limit exceeded");
      return output;
    } catch (error) { this.cancel(); throw error; }
  }
  finish(): VoiceResponseUnit[] {
    if (this.ended) return [];
    try {
      const output = this.buffer.trim() ? this.record(this.buffer) : [];
      if (!this.header || !this.speech) throw new VoiceResponseFramingError("missing_speech", "Voice response has no framed speech");
      this.cancel(); return output;
    } catch (error) { this.cancel(); throw error; }
  }
  cancel(): void { this.ended = true; this.buffer = ""; }
  private record(raw: string): VoiceResponseUnit[] {
    if (!raw.trim()) return [];
    this.recordOrdinal=Math.min(255,this.recordOrdinal+1);
    if (Buffer.byteLength(raw) > voiceResponseBounds.frameBytes) throw new VoiceResponseFramingError("frame_limit", "Voice response frame limit exceeded");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new VoiceResponseFramingError("malformed_record", "Malformed voice response record",{subreason:"json_parse",recordOrdinal:this.recordOrdinal,recordBytes:Math.min(4096,Buffer.byteLength(raw)),headerSeen:this.header}); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new VoiceResponseFramingError("invalid_record", "Invalid voice response record");
    const record = value as Record<string, unknown>;
    if (!this.header) {
      if (Object.keys(record).join() !== "version" || record.version !== VOICE_RESPONSE_VERSION) throw new VoiceResponseFramingError("unsupported_framing", "Unsupported voice response framing");
      this.header = true; return [];
    }
    if (Object.keys(record).sort().join() !== "channel,text" || !["speech", "display"].includes(String(record.channel)) || typeof record.text !== "string" || !record.text.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(record.text)) throw new VoiceResponseFramingError("invalid_unit", "Invalid voice response unit");
    const unit = record as VoiceResponseUnit;
    if (++this.units > voiceResponseBounds.units || (this.characters += unit.text.length) > voiceResponseBounds.textCharacters) throw new VoiceResponseFramingError("text_limit", "Voice response text limit exceeded");
    if (unit.channel === "speech") {
      if (this.display) throw new VoiceResponseFramingError("speech_after_display", "Speech cannot follow a display-only supplement");
      if (unit.text.length > voiceResponseBounds.speechCharacters || /[\r\n`|]|\[\[|<\/?[a-z][^>]*>|\[\/?voice-ignore\]|^\s*(?:\||#{1,6}\s|[-*+]\s)/iu.test(unit.text)) throw new VoiceResponseFramingError("invalid_speech_prose", "Speech unit must be bounded plain prose",{subreason:unit.text.length>voiceResponseBounds.speechCharacters?"speech_length":/[\r\n]/u.test(unit.text)?"speech_linebreak":"speech_formatting",recordOrdinal:this.recordOrdinal,recordBytes:Math.min(4096,Buffer.byteLength(raw)),headerSeen:this.header,speechCharacters:Math.min(16384,unit.text.length)});
      this.speech = true;
    } else {
      if (!this.speech) throw new VoiceResponseFramingError("display_before_speech", "Display supplement must follow speech");
      this.display = true;
    }
    return [{ channel: unit.channel, text: unit.channel === "speech" ? unit.text.trim() : unit.text }];
  }
}

/** Join user-facing text once; supplemental chunks concatenate verbatim. */
export function voiceUnitText(unit: VoiceResponseUnit, previous: VoiceResponseUnit["channel"] | undefined): string {
  return (previous === undefined ? "" : unit.channel === "speech" ? " " : previous === "speech" ? "\n\n" : "") + unit.text;
}
