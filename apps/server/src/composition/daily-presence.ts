import type {IncomingMessage, ServerResponse} from 'node:http';
import {createUbuntuPresenceHost, type UbuntuPresenceHostConfiguration, type UbuntuPresenceHostPorts} from '../runtime/ubuntu-presence-host-factory.ts';
import {handleUbuntuPresenceHttp, isUbuntuPresencePath, type UbuntuPresenceHttpPorts} from '../runtime/ubuntu-presence-http.ts';

export type DailyPresenceOptions = UbuntuPresenceHostConfiguration;
export type DailyPresencePorts = Omit<UbuntuPresenceHostPorts, 'configuration'> & {
  configuration?: DailyPresenceOptions;
};

/** Optional connection to the existing owner. Construction never starts a
 * source, requests permission, enrolls an identity or makes a destination ready. */
export function createDailyPresence(ports: DailyPresencePorts) {
  if (!ports.configuration) return null;
  const host = createUbuntuPresenceHost(ports);
  if (!host) return null;
  return Object.freeze({
    host,
    // Ordinary Initiative HTTP and qualified presence must share this owner.
    initiative: host.lifecycle.initiative,
    invalidate() { host.withdraw(); },
    close() { host.close(); },
  });
}
export type DailyPresence = NonNullable<ReturnType<typeof createDailyPresence>>;
export const isDailyPresencePath = isUbuntuPresencePath;

/** The original server retains Host/Origin checks, request context and CSRF.
 * Its authenticate callback rejects ended sessions. The existing host repeats
 * original authentication/currentness after body reads and owner callbacks. */
export function handleDailyPresenceHttp(
  ports: Omit<UbuntuPresenceHttpPorts, 'host'> & {presence: DailyPresence | null | undefined},
  request: IncomingMessage, response: ServerResponse, path: string,
): Promise<void> {
  return handleUbuntuPresenceHttp({
    host: () => ports.presence?.host ?? null,
    ...(ports.configurationSupplied===undefined?{}:{configurationSupplied:ports.configurationSupplied}),
    authenticate: ports.authenticate,
    csrf: ports.csrf,
  }, request, response, path);
}
