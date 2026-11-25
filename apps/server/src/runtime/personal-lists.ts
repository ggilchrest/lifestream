import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@lifestream/storage-sqlite';

export type ListItem = {
  id: string;
  list: string;
  title: string;
  revision: number;
  done: number;
  delivery: string | null;
  due_at: number | null;
  trigger_kind: string | null;
  cue: string | null;
};
type Command =
  | { kind: 'show' | 'left' | 'create'; list?: string; page?: number }
  | { kind: 'add'; list: string; title: string }
  | { kind: 'remind'; title: string; clock?: string; cue?: string | undefined }
  | {
      kind: 'done' | 'reopen' | 'cancel' | 'edit' | 'snooze' | 'reschedule';
      target: string;
      revision?: number;
      value?: string;
    };

export class ListCommandError extends Error {}

export function listCommand(input: unknown): Command | undefined {
  if (typeof input !== 'string' || input.length > 4000) return;
  const text = input.trim().replace(/[.!?]$/, '');
  let m;
  if ((m = /^(.*) page ([1-9]\d{0,5})$/i.exec(text))) {
    const base = m[1]!;
    if (!base.toLowerCase().includes(' page ')) {
      const cmd = listCommand(base);
      if (cmd?.kind === 'left' || cmd?.kind === 'show') return { ...cmd, page: Number(m[2]) };
    }
  }
  if ((m = /^what['\u2019]?s left (?:on|in) (?:my |the )?(.+?) list$/i.exec(text)))
    return { kind: 'left', list: m[1]! };
  if (/^what['’]?s left$/i.test(text)) return { kind: 'left' };
  if ((m = /^(?:show|open|display) (?:my |the )?(.+?) list$/i.exec(text)))
    return { kind: 'show', list: m[1]! };
  if ((m = /^create (?:a |the )?(.+?) list$/i.exec(text))) return { kind: 'create', list: m[1]! };
  if ((m = /^add (.+?) to (?:my |the |a )?(.+?) list$/i.exec(text)))
    return { kind: 'add', title: m[1]!, list: m[2]! };
  if ((m = /^set (?:a |an )?(.+?) reminder to (.+)$/i.exec(text)))
    return { kind: 'remind', clock: m[1]!, title: m[2]! };
  if ((m = /^set (?:a )?reminder (?:for|at) (.+?) to (.+)$/i.exec(text)))
    return { kind: 'remind', clock: m[1]!, title: m[2]! };
  if ((m = /^remind me at (.+?) to (.+)$/i.exec(text)))
    return { kind: 'remind', clock: m[1]!, title: m[2]! };

  const timedPlace =
    /^remind me to (.+?) (?:((?:today|tomorrow)) )?at (\d{1,2}(?::\d{2})?(?:\s*[ap]m)?|noon|midnight)(?: (?:when|next time) I.+)?$/i.exec(
      text,
    );
  if (timedPlace) {
    const title = timedPlace[1]!.replace(/ (?:when|next time) I(?:['\u2019]m| am) (?:in|at) .+$/i, '');
    return { kind: 'remind', title, clock: [timedPlace[2], timedPlace[3]].filter(Boolean).join(' ') };
  }
  if ((m = /^remind me to (.+?) (?:when|next time) I(?:'m| am) (?:in|at) (?:the )?(.+)$/i.exec(text)))
    return { kind: 'remind', title: m[1]!, cue: m[2]! };
  if ((m = /^remind me to (.+?) (?:when|next time) I leave home$/i.exec(text)))
    return { kind: 'remind', title: m[1]!, cue: 'leave home' };
  if ((m = /^remind me to (.+?) (today|tomorrow) at (.+)$/i.exec(text)))
    return { kind: 'remind', clock: m[2]! + ' ' + m[3]!, title: m[1]! };
  if ((m = /^remind me to (.+?) at (.+)$/i.exec(text)))
    return { kind: 'remind', clock: m[2]!, title: m[1]! };
  if ((m = /^remind me to (.+)$/i.exec(text)))
    return {
      kind: 'remind',
      title: m[1]!,
      cue: /post office/i.test(m[1]!) ? 'leave home' : /glue|shop/i.test(m[1]!) ? 'shop' : undefined,
    };
  if ((m = /^mark (.+?) done$/i.exec(text))) return { kind: 'done', target: m[1]! };
  if ((m = /^(done|reopen|cancel) (.+)$/i.exec(text)))
    return { kind: m[1]!.toLowerCase() as 'done' | 'reopen' | 'cancel', target: m[2]! };
  if ((m = /^edit (.+?) to (.+)$/i.exec(text))) return { kind: 'edit', target: m[1]!, value: m[2]! };
  if ((m = /^snooze (.+?) (?:for )?(\d+) minutes?$/i.exec(text)))
    return { kind: 'snooze', target: m[1]!, value: m[2]! };
  if ((m = /^reschedule (.+?) (?:to|at) (.+)$/i.exec(text)))
    return { kind: 'reschedule', target: m[1]!, value: m[2]! };
}

function nextTime(clock: string, zone: string, now: number) {
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(clock)) {
    const time = Date.parse(clock);
    if (!Number.isFinite(time) || time <= now || new Date(time).toISOString() !== clock)
      throw new ListCommandError('Choose a future date and time.');
    return time;
  }
  const relative = /^(today|tomorrow) (.+)$/i.exec(clock);
  if (relative) clock = relative[2]!;
  if (/^noon$/i.test(clock)) clock = '12 PM';
  if (/^midnight$/i.test(clock)) clock = '12 AM';
  const m = /^(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?$/i.exec(clock);
  if (!m) throw new ListCommandError('Use a time such as 4:00 PM.');
  let hour = Number(m[1]!);
  if (m[3]) {
    if (hour < 1 || hour > 12) throw new ListCommandError('Invalid hour.');
    hour = (hour % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23 || (!m[2]! && hour <= 12)) throw new ListCommandError('Specify AM or PM.');
  if (!zone) throw new ListCommandError('A time zone is required.');
  const format = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: zone,
  });
  const wanted = String(hour).padStart(2, '0') + ':' + (m[2]! ?? '00');
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const today = day.format(now);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const wantedDay = relative ? (relative[1]!.toLowerCase() === 'today' ? today : tomorrow) : undefined;
  for (let t = now - (now % 60000) + 60000; t <= now + 172800000; t += 60000)
    if (format.format(t) === wanted && (!wantedDay || day.format(t) === wantedDay)) return t;
  throw new ListCommandError('Time unavailable.');
}

export function describeItem(item: ListItem, zone = 'UTC') {
  if (item.done) return item.title + ' (done)';
  if (item.delivery === 'cancelled') return item.title + ' (cancelled)';
  if (item.delivery === 'delivered') return item.title + ' (delivered)';
  if (item.due_at !== null) {
    let formatted = new Date(item.due_at).toISOString();
    try {
      formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(item.due_at);
    } catch {
      /* Keep the absolute time on text-only endpoints. */
    }
    return item.title + ' - ' + formatted;
  }
  if (item.cue)
    return (
      item.title +
      (item.trigger_kind === 'departure'
        ? ' - next time you leave home'
        : ' - next time you are in ' + item.cue)
    );
  return item.title;
}

export function executeList(
  db: Database,
  owner: string,
  cmd: Command,
  key: string,
  zone: string,
  now: number,
) {
  if (!owner || !key || key.length > 128) throw new ListCommandError('Invalid request identity.');
  const digest = createHash('sha256')
    .update(JSON.stringify([cmd, zone]))
    .digest('hex');
  return db.transaction((tx) => {
    const prior = tx.get<{ digest: string; list: string }>(
      'SELECT digest,list FROM personal_list_commands WHERE owner=? AND request_id=?',
      owner,
      key,
    );
    if (prior && prior.digest !== digest) throw new ListCommandError('Request ID conflict.');
    let list = 'list' in cmd ? cmd.list : undefined;
    if (list && list.length > 100) throw new ListCommandError('List name too long.');
    if ('title' in cmd && cmd.title.length > 512) throw new ListCommandError('Item title too long.');
    if (cmd.kind === 'remind') list = 'reminders';
    if (!prior && (cmd.kind === 'create' || cmd.kind === 'add' || cmd.kind === 'remind')) {
      tx.run('INSERT OR IGNORE INTO personal_lists VALUES (?,?)', owner, list);
      if (cmd.kind === 'add' || cmd.kind === 'remind') {
        const timed = cmd.kind === 'remind' && cmd.clock;
        if (cmd.kind === 'remind' && !timed && !cmd.cue)
          throw new ListCommandError('Specify a time for this reminder.');
        tx.run(
          'INSERT INTO personal_list_items(id,owner,list,title,trigger_kind,cue,due_at,delivery) VALUES (?,?,?,?,?,?,?,?)',
          randomUUID(),
          owner,
          list,
          cmd.title,
          cmd.kind === 'remind'
            ? timed
              ? 'time'
              : cmd.cue === 'leave home'
                ? 'departure'
                : 'place'
            : null,
          cmd.kind === 'remind' ? (cmd.cue ?? null) : null,
          timed ? nextTime(timed, zone, now) : null,
          cmd.kind === 'remind' ? 'pending' : null,
        );
      }
    }
    if (prior) list = prior.list;
    if ('target' in cmd && !prior) {
      const qualified = /^(.+) (?:in|on) (?:my |the )?(.+) list$/i.exec(cmd.target);
      const target = qualified?.[1] ?? cmd.target;
      const items = tx.all<ListItem>(
        'SELECT * FROM personal_list_items WHERE owner=? AND (? IS NULL OR list=?) AND (id=? OR title=? COLLATE NOCASE) LIMIT 2',
        owner,
        qualified?.[2] ?? null,
        qualified?.[2] ?? null,
        target,
        target,
      );
      const item = items[0];
      if (!item || items.length !== 1) throw new ListCommandError('Choose one item from its list.');
      list = item.list;
      if (cmd.revision !== undefined && cmd.revision !== item.revision)
        throw new ListCommandError('This item changed. Open the list again.');
      let { title, done, delivery, due_at, trigger_kind, cue } = item;
      if (cmd.kind === 'done') {
        done = 1;
        if (delivery === 'delivered') delivery = 'acknowledged';
        else if (delivery && delivery !== 'acknowledged') delivery = 'cancelled';
      }
      if (cmd.kind === 'reopen') {
        if (done && delivery) {
          delivery = 'inactive';
          due_at = null;
          cue = null;
          trigger_kind = null;
        }
        done = 0;
      }
      if (cmd.kind === 'edit') {
        title = cmd.value ?? '';
        if (!title || title.length > 512) throw new ListCommandError('Invalid title.');
      }
      if (['snooze', 'reschedule', 'cancel'].includes(cmd.kind)) {
        if (!delivery || done || (cmd.kind === 'snooze' && delivery === 'cancelled'))
          throw new ListCommandError('Choose an open reminder.');
        if (cmd.kind === 'cancel') delivery = 'cancelled';
        else {
          const minutes = Number(cmd.value);
          if (
            cmd.kind === 'snooze' &&
            (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600)
          )
            throw new ListCommandError('Invalid snooze duration.');
          const location =
            cmd.kind === 'reschedule' &&
            /^(?:next time (?:in|at) (?:the )?(.+)|next departure from home)$/i.exec(cmd.value!);
          if (location) {
            due_at = null;
            cue = location[1] ?? 'leave home';
            trigger_kind = location[1] ? 'place' : 'departure';
          } else {
            due_at = cmd.kind === 'snooze' ? now + minutes * 60000 : nextTime(cmd.value!, zone, now);
            trigger_kind = 'time';
            cue = null;
          }
          delivery = 'pending';
        }
      }
      tx.run(
        `UPDATE personal_list_items SET target_endpoint=NULL,eligible=0,seen_home_at=NULL,title=?,done=?,delivery=?,due_at=?,trigger_kind=?,cue=?,revision=revision+1,
          delivered_at=CASE WHEN ?='pending' THEN NULL ELSE delivered_at END, delivered_to=CASE WHEN ?='pending' THEN NULL ELSE delivered_to END,
          acknowledged_at=CASE WHEN ?='pending' THEN NULL WHEN ?='acknowledged' THEN COALESCE(acknowledged_at,?) ELSE acknowledged_at END WHERE owner=? AND id=?`,
        title,
        done,
        delivery,
        due_at,
        trigger_kind,
        cue,
        delivery,
        delivery,
        delivery,
        delivery,
        now,
        owner,
        item.id,
      );
    }
    if (!prior && cmd.kind !== 'show' && cmd.kind !== 'left')
      tx.run('INSERT INTO personal_list_commands VALUES (?,?,?,?)', owner, key, digest, list);
    const page = 'page' in cmd ? (cmd.page ?? 1) : 1;
    const items = tx.all<ListItem>(
      `SELECT id,list,title,revision,done,delivery,due_at,trigger_kind,cue FROM personal_list_items
      WHERE owner=? AND (? IS NULL OR list=?) AND (?=0 OR (done=0 AND delivery IS NOT 'cancelled')) ORDER BY rowid LIMIT 21 OFFSET ?`,
      owner,
      list ?? null,
      list ?? null,
      cmd.kind === 'left' ? 1 : 0,
      (page - 1) * 20,
    );
    const heading = list ?? "What's left";
    const next =
      items.length > 20
        ? (cmd.kind === 'left'
            ? "What's left" + (list ? ' on my ' + list + ' list' : '')
            : 'Show my ' + list + ' list') +
          ' page ' +
          (page + 1)
        : undefined;
    if (next) items.pop();
    const summary = items.map((item) => describeItem(item, zone));
    return {
      text:
        heading +
        ' - ' +
        (summary.join(', ') || 'No items.') +
        (next ? ' More items: ' + next + '.' : ''),
      items,
      heading,
      next,
    };
  });
}
