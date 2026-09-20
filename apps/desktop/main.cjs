const {app,BrowserWindow,session,powerMonitor,ipcMain}=require('electron');
const {createHash}=require('node:crypto');
const {resolve}=require('node:path');
const args=process.argv.slice(2),flag=args.indexOf('--url');
let endpoint;
try{endpoint=new URL(flag>=0?args[flag+1]:'http://127.0.0.1:43182/control/#conversation');if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||!endpoint.port||endpoint.pathname!=='/control/')throw Error();}catch{console.error('The desktop endpoint requires a loopback /control/ URL.');process.exit(1);}
app.setName('Lifestream');
// The endpoint host is a shell around the same web core. It has no asset filesystem or provider bridge.
app.whenReady().then(async()=>{
 const partition=session.fromPartition('persist:lifestream-local-endpoint');
 partition.setPermissionCheckHandler((_contents,permission,origin,details)=>permission==='media'&&origin===endpoint.origin&&details.mediaType==='audio');
 partition.setPermissionRequestHandler((contents,permission,callback,details)=>callback(permission==='media'&&new URL(contents.getURL()).origin===endpoint.origin&&details.mediaTypes?.length===1&&details.mediaTypes[0]==='audio'));
 partition.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{const url=new URL(details.url);allowed=url.origin===endpoint.origin||url.protocol==='blob:'&&url.origin===endpoint.origin||url.protocol==='data:'||url.protocol==='ws:'&&url.host===endpoint.host;}catch{}callback({cancel:!allowed});});
 const importMapHash=createHash('sha256').update('{"imports":{"three":"./three.module.js"}}').digest('base64');
 partition.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[`default-src 'self'; script-src 'self' 'sha256-${importMapHash}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws://${endpoint.host}; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`]}}));
 const window=new BrowserWindow({width:1260,height:900,minWidth:720,minHeight:560,title:'Lifestream',backgroundColor:'#111f2e',webPreferences:{preload:resolve(__dirname,'preload.cjs'),session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,spellcheck:false}});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==endpoint.origin)event.preventDefault();});window.webContents.on('will-attach-webview',event=>event.preventDefault());
 let locked=false;const privacy=value=>{locked=value;if(!window.isDestroyed())window.webContents.send('privacy-lock',locked);};powerMonitor.on('lock-screen',()=>privacy(true));powerMonitor.on('unlock-screen',()=>privacy(false));powerMonitor.on('suspend',()=>privacy(true));powerMonitor.on('resume',()=>privacy(false));ipcMain.handle('privacy-lock-state',event=>{if(event.sender!==window.webContents||new URL(event.senderFrame.url).origin!==endpoint.origin)return true;return locked;});
 await window.loadURL(endpoint.href);
 if(args.includes('--diagnostic'))console.log(JSON.stringify({host:'Electron',version:process.versions.electron,sandbox:true,contextIsolation:true,nodeIntegration:false,origin:endpoint.origin,rendererPath:resolve(__dirname,'../control-web')}));
});
app.on('window-all-closed',()=>app.quit());
