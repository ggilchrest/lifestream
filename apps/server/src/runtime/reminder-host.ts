import type { Database } from '@lifestream/storage-sqlite';
import type { PwceContextSession } from '@lifestream/providers-pwce';
import type { ListItem } from './personal-lists.ts';
import { reminderSurface } from './list-surface.ts';

export type Presence = {
  place: string;
  home?: 'home' | 'away';
  observed: number;
  current: () => boolean;
};
/** The composition supplies the published property and its opaque zone/value mapping. */
export async function personPlace(
  session: PwceContextSession,
  person: string,
  site: string,
  property: string,
  zones: ReadonlyMap<string, string>,
  maxAgeMs: number,
  now: () => number,
  signal?: AbortSignal,
  homeStates: Readonly<Record<string, 'home' | 'away'>> = {},
): Promise<Presence | undefined> {
  const read = await session.queryContext(
    { mode: 'current', externalEntityId: person, property, maxAgeMs, allowStale: false },
    signal,
  );
  const matches = read.value.items.filter(
    (i) => i.subjectRef === site + '::' + person && i.siteRef === site && i.property === property,
  );
  const item = matches[0];
  if (
    read.value.hasMore ||
    matches.length !== 1 ||
    !item ||
    item.knowledgeState !== 'current' ||
    item.freshnessAccepted === false ||
    item.freshnessState !== 'current' ||
    item.contradictions?.length ||
    typeof item.value !== 'string'
  )
    return;
  const place = zones.get(item.value),
    observed = Date.parse(item.eventTime ?? '');
  const current = () =>
    read.isCurrent() &&
    observed <= now() &&
    now() - observed <= maxAgeMs &&
    Date.parse(read.expiresAt) > now();
  if (place && current())
    return {
      place,
      observed,
      current,
      ...(Object.hasOwn(homeStates, item.value) ? { home: homeStates[item.value]! } : {}),
    };
}

export type ReminderEndpoint = {
  id: string;
  place?: string;
  personal: boolean;
  fallback: boolean;
  disclosure: () => 'private' | 'generic' | 'denied';
  // Render idempotently by key and return true only after display. Adapters recheck
  // the fence immediately before display, including when reconnecting or retrying.
  present: (
    key: string,
    surface: ReturnType<typeof reminderSurface>,
    current: () => boolean,
  ) => Promise<boolean>;
};
export type ReminderHostPorts = {
  now: () => number;
  presence: (owner: string, signal: AbortSignal) => Promise<Presence | undefined>;
  endpoints: (owner: string) => readonly ReminderEndpoint[];
  close?: () => void;
};
type Pending = ListItem & {
  owner: string;
  eligible: number;
  seen_home_at: number | null;
  target_endpoint: string | null;
};

export class ReminderHost {
  private timer?: ReturnType<typeof setInterval>;
  private controller = new AbortController();
  private afterRow = 0;
  private running: Promise<void> | undefined;
  private db: Database;
  private ports: ReminderHostPorts;
  constructor(db: Database, ports: ReminderHostPorts) {
    this.db = db;
    this.ports = ports;
  }
  start() {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.controller.abort();
    this.ports.close?.();
  }
  tick() {
    this.running ??= this.scan().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async scan() {
    const { signal } = this.controller;
    if (signal.aborted) return;
    const rows = this.db.connection
      .prepare(
        "SELECT rowid,* FROM personal_list_items WHERE rowid>? AND delivery='pending' AND done=0 AND (due_at IS NULL OR due_at<=?) ORDER BY rowid LIMIT 32",
      )
      .all(this.afterRow, this.ports.now()) as unknown as (Pending & { rowid: number })[];
    this.afterRow = rows.length === 32 ? rows[31]!.rowid : 0;
    const locations = new Map<string, Presence | undefined>();
    for (const item of rows) {
      if (signal.aborted) return;
      try {
        if (!locations.has(item.owner))
          locations.set(
            item.owner,
            await this.ports.presence(item.owner, signal).catch(() => undefined),
          );
        await this.route(item, signal, locations.get(item.owner));
      } catch {
        /* Leave the same revision pending for retry. */
      }
    }
  }
  private async route(item: Pending, signal: AbortSignal, presence: Presence | undefined) {
    if (signal.aborted) return;
    const place = presence?.current() ? presence.place : undefined;
    const update = (set: string, ...args: (string | number)[]) =>
      this.db.connection
        .prepare(
          'UPDATE personal_list_items SET ' +
            set +
            " WHERE id=? AND revision=? AND delivery='pending' AND done=0",
        )
        .run(...args, item.id, item.revision).changes === 1;
    if (!item.eligible) {
      if (item.trigger_kind === 'departure' && place && presence?.home === 'home') {
        update('seen_home_at=MAX(COALESCE(seen_home_at,0),?)', presence.observed);
        return;
      }
      if (
        item.trigger_kind === 'departure' &&
        (!place ||
          presence?.home !== 'away' ||
          item.seen_home_at === null ||
          presence!.observed <= item.seen_home_at)
      )
        return;
      if (item.trigger_kind === 'place' && place !== item.cue) return;
      if (!update('eligible=1')) return;
    }
    const endpoints = this.ports.endpoints(item.owner).filter((e) => e.disclosure() !== 'denied');
    const preferred =
      item.trigger_kind === 'departure'
        ? endpoints.find((e) => e.personal)
        : place
          ? endpoints.find((e) => e.place === place)
          : undefined;
    const endpoint = item.target_endpoint
      ? endpoints.find((e) => e.id === item.target_endpoint)
      : (preferred ?? endpoints.find((e) => e.fallback));
    if (!endpoint) return;
    const disclosure = endpoint.disclosure();
    if (disclosure === 'denied') return;
    const current = () =>
      !signal.aborted &&
      endpoint.disclosure() === disclosure &&
      this.ports
        .endpoints(item.owner)
        .some((e) => e.id === endpoint.id && e.disclosure() === disclosure) &&
      (endpoint.fallback ||
        (endpoint.personal && item.trigger_kind === 'departure') ||
        (!!presence?.current() && endpoint.place === presence.place)) &&
      !!this.db.connection
        .prepare(
          "SELECT 1 FROM personal_list_items WHERE id=? AND revision=? AND target_endpoint=? AND delivery='pending'",
        )
        .get(item.id, item.revision, endpoint.id);
    const claimed = this.db.connection
      .prepare(
        "UPDATE personal_list_items SET target_endpoint=? WHERE id=? AND revision=? AND delivery='pending' AND (target_endpoint IS NULL OR target_endpoint=?)",
      )
      .run(endpoint.id, item.id, item.revision, endpoint.id);
    if (!claimed.changes || !current()) return;
    const surface = reminderSurface(item, disclosure);
    if ((await endpoint.present(item.id + '/' + item.revision, surface, current)) && current())
      update("delivery='delivered',delivered_to=?,delivered_at=?", endpoint.id, this.ports.now());
  }
}
