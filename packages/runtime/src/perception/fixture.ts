import type {VisualPerceptionProvider, VisualPerceptionRequest, VisualPerceptionResult} from './port.ts';

/** Deterministic plumbing fixture; it never infers scene content from pixels. */
export function fixtureVisualProvider(
  result: (request: VisualPerceptionRequest) => VisualPerceptionResult
): VisualPerceptionProvider {
  return {
    id: 'fixture-visual', version: '1.0.0', mediaTypes: ['image/jpeg', 'image/png'],
    supportsMultipleFrames: true, supportsTemporalInput: true,
    supportsCancellation: true, dataEgressClass: 'localOnly', healthy: () => true,
    async interpret(request, signal) {
      if (signal.aborted) return {requestId: request.requestId, status: 'cancelled', observations: [], reason: 'cancelled'};
      return result(request);
    }
  };
}
