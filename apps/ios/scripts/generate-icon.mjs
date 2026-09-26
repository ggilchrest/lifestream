import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const browser=await chromium.launch({channel:'chrome',headless:true});
try {const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});await page.setContent('<style>body{margin:0}</style>'+await readFile(new URL('../web/icon.svg',import.meta.url),'utf8'));await page.screenshot({path:fileURLToPath(new URL('../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png',import.meta.url))});}finally{await browser.close();}
