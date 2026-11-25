import { randomUUID } from 'node:crypto';
import { describeItem, type ListItem } from './personal-lists.ts';

export function listSurface(
  heading: string,
  items: ListItem[],
  zone?: string,
  next?: string,
  surfaceId: string = randomUUID(),
) {
  const children = ['heading'];
  const text = (id: string, literalString: string) => ({
    id,
    component: { Text: { text: { literalString } } },
  });
  const components: Array<{ id: string; component: object }> = [text('heading', heading)];
  for (const item of items) {
    children.push(item.id);
    components.push(text(item.id, describeItem(item, zone)));
    for (const name of [
      item.done ? 'reopen' : 'done',
      ...(!item.done && item.delivery === 'delivered' ? ['snooze'] : []),
    ]) {
      const id = name + '-' + item.id,
        child = id + '-label';
      children.push(id);
      components.push(
        text(child, name === 'done' ? 'Done' : name === 'reopen' ? 'Reopen' : 'Snooze 10 minutes'),
        {
          id,
          component: {
            Button: {
              child,
              action: {
                name,
                context: [
                  { key: 'item', value: { literalString: item.id } },
                  { key: 'revision', value: { literalNumber: item.revision } },
                ],
              },
            },
          },
        },
      );
    }
  }
  if (!items.length) {
    children.push('empty');
    components.push(text('empty', 'No items.'));
  }
  if (next) {
    children.push('next');
    components.push(text('next-label', 'Next page'), {
      id: 'next',
      component: {
        Button: {
          child: 'next-label',
          action: { name: 'page', context: [{ key: 'command', value: { literalString: next } }] },
        },
      },
    });
  }
  components.push({ id: 'root', component: { Column: { children: { explicitList: children } } } });
  return [{ surfaceUpdate: { surfaceId, components } }, { beginRendering: { surfaceId, root: 'root' } }];
}

export function reminderSurface(item: ListItem, disclosure: 'private' | 'generic') {
  const surfaceId = 'reminder-' + item.id + '-' + item.revision;
  if (disclosure === 'private')
    return listSurface(
      'Reminder',
      [{ ...item, delivery: 'delivered' }],
      undefined,
      undefined,
      surfaceId,
    );
  const components = [
    { id: 'notice', component: { Text: { text: { literalString: 'A personal reminder is ready' } } } },
  ];
  return [
    { surfaceUpdate: { surfaceId, components } },
    { beginRendering: { surfaceId, root: 'notice' } },
  ];
}

export function reminderForm(title: string) {
  const surfaceId = randomUUID();
  const text = (id: string, literalString: string) => ({
    id,
    component: { Text: { text: { literalString } } },
  });
  const components = [
    text('title', 'When should I remind you to ' + title + '?'),
    text('time-label', 'Date and time'),
    text('save-time', 'Set reminder'),
    text('shop-label', 'Next time in the shop'),
    text('away-label', 'Next departure from home'),
    {
      id: 'time',
      component: { DateTimeInput: { value: { path: '/when' }, enableDate: true, enableTime: true } },
    },
    ...[
      ['save', 'save-time', 'time'],
      ['shop', 'shop-label', 'shop'],
      ['away', 'away-label', 'departure'],
    ].map(([id, child, kind]) => ({
      id,
      component: {
        Button: {
          child,
          action: {
            name: 'schedule',
            context: [
              { key: 'title', value: { literalString: title } },
              { key: 'kind', value: { literalString: kind } },
              ...(kind === 'time' ? [{ key: 'when', value: { path: '/when' } }] : []),
            ],
          },
        },
      },
    })),
    {
      id: 'root',
      component: {
        Column: { children: { explicitList: ['title', 'time-label', 'time', 'save', 'shop', 'away'] } },
      },
    },
  ];
  return [{ surfaceUpdate: { surfaceId, components } }, { beginRendering: { surfaceId, root: 'root' } }];
}
