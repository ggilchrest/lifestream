// Legacy journey tests now follow the real navigation before using a control.
// No forced clicks, hidden-view overrides or application test modes.
export function followWorkspace(page) {
  const wrap=locator=>new Proxy(locator,{get(target,key){
    if(['click','fill','check','uncheck','selectOption','setInputFiles','press'].includes(key))return async(...args)=>{
      if(new URL(page.url()).pathname==='/control/'){
        await page.waitForFunction(()=>!!window.lifestreamUI);
        await target.first().waitFor({state:'attached'});
        const route=await target.first().evaluate(el=>el.closest('[data-view]')?.dataset.view);
        if(route&&!(await target.first().isVisible())){
          const nav=page.locator(`[data-destination="${route}"]`);
          if(await nav.count()&&await nav.getAttribute('aria-current')!=='page'){
            if(!await nav.isVisible())await page.locator('.nav-toggle').click();
            await nav.click();
          }
        }
        const pane=await target.first().evaluate(el=>el.closest('.tool-pane,[data-pane].workflow-step')?.dataset.pane);
        if(pane&&!await target.first().isVisible())await page.locator(`.subnav [data-pane="${pane}"]`).click();
        const lens=await target.first().evaluate(el=>el.closest('[data-lens]')?.dataset.lens);if(lens&&!await target.first().isVisible())await page.locator(`[data-lens-select="${lens}"]`).click();
        const record=await target.first().evaluate(el=>el.closest('.record-detail[hidden]')?.dataset.record);
        if(record)await page.locator(`[data-expand="${record}"]`).click();
        // Open ancestors using their actual summary controls, outermost first.
        const closed=await target.first().evaluate(el=>{const list=[];for(let n=el.parentElement;n;n=n.parentElement)if(n.tagName==='DETAILS'&&!n.open)list.unshift(n.id);return list;});
        for(const id of closed){if(id)await page.locator(`#${id} > summary`).click();else {const detail=target.locator('xpath=ancestor::details[not(@open)]').first();await detail.locator('summary').first().click();}}
      }
      return target[key](...args);
    };
    if(['locator','getByRole','getByText','getByLabel','filter','first','last','nth'].includes(key))return(...args)=>wrap(target[key](...(key==='getByRole'?[args[0],{...args[1],includeHidden:true}]:args)));
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(page,{get(target,key){if(['locator','getByRole','getByText','getByLabel'].includes(key))return(...args)=>wrap(target[key](...(key==='getByRole'?[args[0],{...args[1],includeHidden:true}]:args)));const value=target[key];return typeof value==='function'?value.bind(target):value;}});
}
