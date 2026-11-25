/** Locally implemented subset of Google's A2UI v0.8 standard catalog. */
export function renderChatSurface(target, messages, onAction) {
  if (!Array.isArray(messages) || messages.length !== 2) return false;
  const update = messages[0]?.surfaceUpdate,
    start = messages[1]?.beginRendering;
  if (
    !start ||
    typeof start.surfaceId !== 'string' ||
    start.surfaceId !== update?.surfaceId ||
    (start.catalogId &&
      start.catalogId !== 'https://a2ui.org/specification/v0_8/standard_catalog_definition.json') ||
    !Array.isArray(update.components) ||
    update.components.length > 4096 ||
    update.components.some((node) => !node || typeof node.id !== 'string' || !node.component)
  )
    return false;
  const nodes = new Map(update.components.map((node) => [node.id, node.component])),
    seen = new Set(),
    inputs = new Map();
  if (nodes.size !== update.components.length) return false;
  function build(id, depth) {
    const component = nodes.get(id);
    if (!component || depth > 16 || seen.has(id) || Object.keys(component).length !== 1) throw Error();
    seen.add(id);
    if (component.Text) {
      const literal = component.Text.text?.literalString;
      if (typeof literal !== 'string') throw Error();
      const label = document.createElement('span');
      label.textContent = literal;
      return label;
    }
    if (component.Column || component.Row) {
      const row = !!component.Row,
        children = (component.Row ?? component.Column).children?.explicitList;
      if (!Array.isArray(children)) throw Error();
      const group = document.createElement('div');
      for (const child of children) {
        const element = build(child, depth + 1);
        if (row) group.append(element);
        else {
          const line = document.createElement('div');
          line.append(element);
          group.append(line);
        }
      }
      return group;
    }
    if (component.DateTimeInput) {
      const field = component.DateTimeInput;
      if (
        field.value?.path !== '/when' ||
        field.enableDate !== true ||
        field.enableTime !== true ||
        inputs.has('/when')
      )
        throw Error();
      const input = document.createElement('input');
      input.type = 'datetime-local';
      input.required = true;
      input.setAttribute('aria-label', 'Reminder date and time');
      inputs.set('/when', input);
      return input;
    }
    if (component.Button) {
      const { action, child } = component.Button;
      if (!Array.isArray(action?.context) || !nodes.get(child)?.Text) throw Error();
      const literal = (key) => action.context.find((field) => field.key === key)?.value.literalString;
      if (action.name === 'page' || action.name === 'schedule') {
        const button = document.createElement('button');
        button.type = 'button';
        button.append(build(child, depth + 1));
        if (action.name === 'page') {
          const command = literal('command');
          if (
            typeof command !== 'string' ||
            !/^(show my .+ list|what's left(?: on my .+ list)?) page [1-9]\d*$/i.test(command)
          )
            throw Error();
          button.onclick = () => onAction('chat', command);
        } else {
          const title = literal('title'),
            kind = literal('kind');
          if (
            typeof title !== 'string' ||
            !title ||
            title.length > 512 ||
            !['time', 'shop', 'departure'].includes(kind)
          )
            throw Error();
          button.onclick = () => {
            if (kind === 'time') {
              const input = inputs.get('/when');
              if (!input?.reportValidity()) return;
              onAction('chat', 'Remind me at ' + new Date(input.value).toISOString() + ' to ' + title);
            } else
              onAction(
                'chat',
                'Remind me to ' +
                  title +
                  (kind === 'shop' ? ' next time I am in the shop' : ' next time I leave home'),
              );
          };
        }
        return button;
      }
      if (!['done', 'reopen', 'snooze'].includes(action.name)) throw Error();
      const item = action.context.find((f) => f.key === 'item')?.value.literalString;
      const revision = action.context.find((f) => f.key === 'revision')?.value.literalNumber;
      if (
        typeof item !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(item) ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !nodes.get(child)?.Text
      )
        throw Error();
      const button = document.createElement('button');
      button.type = 'button';
      button.append(build(child, depth + 1));
      button.onclick = () => onAction(action.name, item, revision);
      return button;
    }
    throw Error();
  }
  try {
    const surface = build(start.root, 0);
    target.replaceChildren(surface);
    return true;
  } catch {
    return false;
  }
}
