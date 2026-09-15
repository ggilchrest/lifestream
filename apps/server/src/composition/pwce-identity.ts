import { createHash } from 'node:crypto';

export function pwceIdentity(environmentId: string, owner: { assistantId: string; endpointId: string; principalId: string; sessionId: string; revision: string }) {
  const reference = (kind: string, values: string[]) => `lifestream.${kind}.${createHash('sha256').update(JSON.stringify([environmentId, ...values])).digest('hex')}`;
  return { assistantRef: reference('assistant', [owner.assistantId]), endpointRef: reference('endpoint', [owner.endpointId]), participantRefs: [reference('participant', [owner.principalId])], audienceRef: reference('audience', [owner.sessionId, owner.endpointId, owner.revision]) };
}
