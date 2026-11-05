import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

/** A GPU attestation from this host may qualify only a same-host service.
 * Accept literal assigned interface addresses, never a subnet or DNS name
 * that merely looks local. The optional snapshot keeps validation inert in tests. */
export function sameHostInferenceEndpoint(endpoint: URL, localAddresses?: readonly string[]): boolean {
  if (endpoint.protocol !== 'http:' || endpoint.username || endpoint.password) return false;
  const host = endpoint.hostname;
  if (['127.0.0.1', 'localhost', '[::1]'].includes(host)) return true;
  const literal = host.replace(/^\[|\]$/g, '');
  if (!isIP(literal) || ['0.0.0.0', '::'].includes(literal)) return false;
  const addresses = localAddresses ?? Object.values(networkInterfaces()).flatMap(entries => entries?.map(entry => entry.address) ?? []);
  return addresses.some(address => (isIP(address) === 6 ? new URL(`http://[${address}]`).hostname : address) === host);
}
