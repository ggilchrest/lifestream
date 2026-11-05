import {randomUUID} from 'node:crypto';
import {SglangGameFrameProvider, type GameFrameProviderReceipt, type GameFrameRefusal} from '@lifestream/providers-sglang';
import type {GameFrameDecoder} from './game-frame-interpretation.ts';

/** Purpose-bound VLM bridge. It contributes uncertain screen-pixel facts only;
 * menu safety, typed visible-state extraction and controller authority remain
 * separate reviewed mechanisms. Use through createGameObservationReader. */
export function createSglangGameFrameDecoder(options: {
  provider: SglangGameFrameProvider;
  configurationRef: string; decoderRevision: string; manifestDigest: string;
  current: GameFrameDecoder['current'];
  onRefusal?: (observation:Parameters<GameFrameDecoder['current']>[0],value:GameFrameRefusal)=>void;
  onReceipt?: (observation: Parameters<GameFrameDecoder['current']>[0], receipt: GameFrameProviderReceipt) => void;
}): GameFrameDecoder {
  const {provider, configurationRef, decoderRevision, manifestDigest, current, onReceipt, onRefusal} = options;
  if (!configurationRef.trim() || Buffer.byteLength(configurationRef) > 2048 || !/^\d+\.\d+\.\d+$/u.test(decoderRevision) || !/^[a-f0-9]{64}$/u.test(manifestDigest) || typeof current !== 'function') throw Error('Invalid game frame decoder configuration');
  const isCurrent: GameFrameDecoder['current'] = observation => {
    try {return provider.healthy() && current(observation) === true;} catch {return false;}
  };
  return Object.freeze({purpose: 'simulatedGame/gameFramebuffer', configurationRef, decoderRevision, manifestDigest,
    allowedVisibleFieldIds: Object.freeze([]),
    capability: Object.freeze({kind: 'gameVision', vision: true, loadedProjectorSha256: provider.loadedProjectorSha256}),
    current: isCurrent,
    async decode(input, signal, onUsage) {
      const shot = input.screenshot;
      if (input.purpose !== 'simulatedGame/gameFramebuffer' || input.observation.screenshots.length !== 1 || input.observation.screenshots[0] !== shot || !isCurrent(input.observation)) return null;
      const result = await provider.interpret({...(input.priorScene?{priorScene:input.priorScene}:{}),purpose: input.purpose, screenshot: shot, bytes: input.bytes,
        deadlineAtMs: Math.min(Date.parse(shot.expiresAt), Date.now() + provider.maximumDurationMs), isCurrent: () => isCurrent(input.observation),...(onRefusal?{onRefusal:(value:GameFrameRefusal)=>onRefusal(input.observation,value)}:{})}, signal);
      if (!result || !isCurrent(input.observation)) return null;
      onUsage?.(Object.freeze({inputTokens: result.usageReceipt.inputTokens, outputTokens: result.usageReceipt.outputTokens,
        providerRevision: provider.version, completionRef: result.usageReceipt.completionRef}));
      if (!isCurrent(input.observation)) return null;
      onReceipt?.(input.observation, result.usageReceipt);
      if (!isCurrent(input.observation)) return null;
      const provenance = `Untrusted VLM pixels: model=${result.provenance.model}; revision=${result.provenance.modelRevision}; projector=${result.provenance.loadedProjectorSha256}.`;
      return {visibleState: [], facts: result.observations.flatMap(item => [item,...(item.sceneKey&&item.sceneKind?[{...item,appearance:'Model scene: '+JSON.stringify({key:item.sceneKey,kind:item.sceneKind,comparison:item.sceneCompatibility,comparedObservationId:input.priorScene?.observationId??null}),visibleText:null}]:[])].map(item=>({factId: randomUUID(),
        description: item.appearance + (item.visibleText === null ? '' : `\nVisible text (untrusted OCR): ${item.visibleText}`),
        epistemicKind: 'visibleFeature' as const, sourceScreenshotIds: [shot.screenshotId], extractionKind: 'screenPixels' as const,
        extractorRef: configurationRef, uncertainty: item.uncertainty,
        limitations: [...item.limitations, provenance, 'Single frame; no hidden state, inferred coordinates, menu safety or control authority.'],
        sourceKind: 'playerVisibleGameObservation' as const, untrusted: true as const
      }))) };
    }
  } satisfies GameFrameDecoder);
}
