import {createSettingsNavigation} from '../web/settings-navigation.js';
import test from 'node:test';import assert from 'node:assert/strict';import {readFile,mkdir} from 'node:fs/promises';
test('phone settings group controls without overflow at narrow and enlarged sizes',{timeout:30000},async t=>{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright'),browser=await chromium.launch({channel:'chrome',headless:true});t.after(()=>browser.close());const css=await readFile(new URL('../web/app.css',import.meta.url),'utf8'),html=await readFile(new URL('../web/index.html',import.meta.url),'utf8');const page=await browser.newPage({viewport:{width:320,height:700}});await page.setContent(html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<link rel="stylesheet"[^>]*>/,`<style>${css}</style>`).replace(/<script type="module"[^>]*><\/script>/,''));await page.evaluate(()=>{document.querySelector('#main-pane').hidden=true;document.querySelector('#settings-pane').hidden=false;document.querySelector('#session-panel').hidden=false;document.querySelector('#session-privacy').hidden=false;});
 await page.evaluate(()=>{for(const id of ['health-inventory-panel','calendar-connections-panel'])document.getElementById(id).hidden=false;});
 await page.addScriptTag({content:`const nav=(${createSettingsNavigation.toString()})();nav.home();`});
 const rows=page.locator('[data-page]>summary');
 assert.deepEqual(await rows.allTextContents(),['Assistant profile','Voice & audio','Appearance','Apple Health','Calendar','Connection & privacy','Diagnostics']);
 for(const [width,height,font,theme] of [[320,700,16,'light'],[375,812,23,'dark'],[844,390,20,'dark']]){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});
  await page.evaluate(size=>{document.documentElement.style.fontSize=size+'px'},font);
  for(const row of await rows.all()){
   assert.ok((await row.boundingBox()).height>=44);
   await row.click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${width}/${font}`);
   await page.locator('#settings-back').click();
  }
  const dir=process.env.SETTINGS_SCREENSHOT_DIR;
  if(dir){await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/settings-${width}-${font}-${theme}.png`});}
 }
});
