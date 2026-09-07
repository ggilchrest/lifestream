export type EmbodimentFrame = { at: number; speech: "silent" | "speaking" | "interrupted"; attention: "none" | "participant" | "object" | "environment" | "task"; clipped?: boolean };
export type CaptureManifest = { viewport: { width: number; height: number }; audioFormat: string; frames: EmbodimentFrame[] };
export type PerceptualResult = { rubricVersion: string; deterministic: { passed: boolean; failures: string[] }; judge: { status: "unavailable"; reason: string } };

export function capture(manifest: CaptureManifest): CaptureManifest {
  if (manifest.viewport.width < 1 || manifest.viewport.height < 1) throw new Error("viewport must be positive");
  if (!manifest.audioFormat) throw new Error("audio format is required");
  return structuredClone({ ...manifest, frames: manifest.frames.toSorted((a, b) => a.at - b.at) });
}

export function evaluate(manifest: CaptureManifest): PerceptualResult {
  const failures: string[] = [];
  if (manifest.frames.some((frame) => frame.clipped)) failures.push("clipped frame");
  const speakingFrames = manifest.frames.filter((frame) => frame.speech === "speaking");
  if (speakingFrames.length > 0 && manifest.frames.at(-1)?.speech === "speaking") failures.push("stuck speaking");
  if (manifest.frames.some((frame) => frame.speech === "speaking" && frame.attention !== "participant")) failures.push("attention mismatch");
  return { rubricVersion: "deterministic-1", deterministic: { passed: failures.length === 0, failures }, judge: { status: "unavailable", reason: "no approved judge model" } };
}
