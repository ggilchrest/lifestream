import type { Database } from '@lifestream/storage-sqlite';
import { reminderSurface } from './list-surface.ts';
import type { ListItem } from './personal-lists.ts';
import type { ReminderEndpoint } from './reminder-host.ts';

export type DisplayBinding = {
  owner: string;
  assistantId: string;
  endpointId: string;
  place: string;
  personal: boolean;
  fallback: boolean;
};
type Disclosure = 'generic' | 'private' | 'denied';
type Connection = { binding: DisplayBinding; expires: number; policy: () => Disclosure };
type Offer = { endpointId: string; current: () => boolean; disclosure: Disclosure };

/** Only an authenticated poll of the configured logical endpoint establishes reachability. */
export class ReminderDisplays {
  private connections = new Map<string, Connection>();
  private offers = new Map<string, Offer>();
  private bindings: readonly DisplayBinding[];
  private now: () => number;
  constructor(bindings: readonly DisplayBinding[], now = Date.now) {
    this.bindings = structuredClone(bindings);
    this.now = now;
    if (
      bindings.length > 128 ||
      new Set(bindings.map((b) => b.endpointId)).size !== bindings.length ||
      bindings.some(
        (b) =>
          ![b.owner, b.assistantId, b.endpointId, b.place].every(
            (x) => typeof x === 'string' && x.length > 0 && x.length <= 256,
          ) ||
          typeof b.personal !== 'boolean' ||
          typeof b.fallback !== 'boolean',
      )
    )
      throw Error('Invalid reminder display binding.');
  }
  binding(owner: string, id: string) {
    return this.bindings.find((b) => b.owner === owner && b.endpointId === id);
  }
  endpoints(owner: string): ReminderEndpoint[] {
    const endpoints: ReminderEndpoint[] = [];
    for (const [id, connection] of this.connections) {
      const b = connection.binding;
      if (connection.expires <= this.now()) {
        this.connections.delete(id);
        continue;
      }
      if (b.owner !== owner) continue;
      const disclosure = () => {
        const latest = this.connections.get(id);
        return latest && latest.expires > this.now() ? latest.policy() : 'denied';
      };
      endpoints.push({
        id,
        place: b.place,
        personal: b.personal,
        fallback: b.fallback,
        disclosure,
        present: async (key, _surface, current) => {
          if (current()) this.offers.set(key, { endpointId: id, current, disclosure: disclosure() });
          return false; // Only the subsequent renderer receipt can record delivery.
        },
      });
    }
    return endpoints;
  }
  poll(db: Database, b: DisplayBinding, policy: () => Disclosure, shown?: string) {
    const disclosure = policy();
    if (disclosure === 'denied') throw Error('Display unavailable.');
    this.connections.set(b.endpointId, { binding: b, expires: this.now() + 6000, policy });
    for (const [key, offer] of this.offers) if (!offer.current()) this.offers.delete(key);
    if (shown) {
      const offer = this.offers.get(shown),
        [id, revision] = shown.split('/');
      if (offer?.endpointId === b.endpointId && offer.disclosure === disclosure && offer.current()) {
        db.connection
          .prepare(
            "UPDATE personal_list_items SET delivery='delivered',delivered_at=?,delivered_to=? WHERE owner=? AND id=? AND revision=? AND delivery='pending' AND target_endpoint=?",
          )
          .run(this.now(), b.endpointId, b.owner, id!, Number(revision), b.endpointId);
        this.offers.delete(shown);
      }
    }
    const items = db.connection
      .prepare(
        "SELECT * FROM personal_list_items WHERE owner=? AND target_endpoint=? AND delivery IN ('pending','delivered') AND done=0 ORDER BY rowid",
      )
      .all(b.owner, b.endpointId) as unknown as ListItem[];
    return items.flatMap((item) => {
      const key = item.id + '/' + item.revision,
        offer = this.offers.get(key);
      if (
        item.delivery !== 'delivered' &&
        (!offer || offer.disclosure !== disclosure || !offer.current())
      )
        return [];
      return [
        {
          key,
          disclosure,
          delivered: item.delivery === 'delivered',
          surface: reminderSurface(item, disclosure),
        },
      ];
    });
  }
}
