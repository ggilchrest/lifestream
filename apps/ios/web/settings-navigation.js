// The same controls stay mounted while moving between Settings and its detail pages.
export function createSettingsNavigation() {
  const pane = document.getElementById('settings-pane');
  const title = document.getElementById('settings-title');
  const back = document.getElementById('settings-back');
  const summary = page => page.querySelector(':scope > summary');
  let path = [];

  function show(next, focus) {
    for (const page of path) {
      page.open = next.includes(page);
      page.classList.toggle('current-page', page.open);
    }
    path = next;
    for (const page of path) {
      page.open = true;
      page.classList.add('current-page');
    }
    const current = path.at(-1);
    title.textContent = current ? summary(current).textContent : 'Settings';
    back.hidden = !current;
    back.textContent = path.length > 1 ? '‹ Calendar' : '‹ Settings';
    pane.classList.toggle('in-detail', !!current);
    document.getElementById('status-settings').hidden = current?.dataset.page !== 'account';
    window.scrollTo(0, 0);
    (focus || title).focus({preventScroll:true});
  }
  pane.addEventListener('click', event => {
    const row = event.target.closest('summary');
    const page = row?.parentElement;
    if (!page?.matches('details[data-page],details[data-task]')) return;
    event.preventDefault();
    show(page.hasAttribute('data-task') ? [page.closest('[data-page]'), page] : [page]);
  });
  function up() {
    const previous = path.at(-1);
    if (previous) show(path.slice(0, -1), summary(previous));
  }
  back.addEventListener('click', up);
  pane.addEventListener('keydown', event => {
    if (event.key === 'Escape' && path.length) { event.preventDefault(); up(); }
  });
  new MutationObserver(() => {
    if (path.length && !pane.hidden && path[0].closest('[hidden]')) show([]);
  }).observe(pane, {subtree:true,attributes:true,attributeFilter:['hidden']});
  return {home:() => show([]), account:() => show([pane.querySelector('[data-page="account"]')])};
}
