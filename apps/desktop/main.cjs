const {app,BrowserWindow,session,powerMonitor,ipcMain,net,Menu,dialog}=require('electron');
const {createHash}=require('node:crypto');
const {readFileSync,existsSync}=require('node:fs');
const {resolve}=require('node:path');
const {endpointFromArguments,connectionPage}=require('./connection-status.cjs');
const {installGameHostControls}=require('./game-host-controls.cjs');
const {createDesktopGameHostComposition}=require('./game-host-composition.cjs');
let endpoint,args,gameHostControls;
// This binding is a trusted-main module hook, never a renderer IPC channel.
module.exports.bindGameHostBroker=broker=>{if(!gameHostControls)throw Error('game_host_session_unavailable');gameHostControls.bindBroker(broker);};
try{({endpoint,args}=endpointFromArguments(process.argv,process.defaultApp===true));}catch{console.error('The desktop endpoint requires a loopback /control/ URL.');process.exit(1);}
app.setName('Lifestream');
// The endpoint host is a shell around the same web core. It has no asset filesystem or provider bridge.
app.whenReady().then(async()=>{
 const partition=session.fromPartition('persist:lifestream-local-endpoint');
 partition.setPermissionCheckHandler((_contents,permission,origin,details)=>permission==='media'&&origin===endpoint.origin&&details.mediaType==='audio');
 partition.setPermissionRequestHandler((contents,permission,callback,details)=>callback(permission==='media'&&new URL(contents.getURL()).origin===endpoint.origin&&details.mediaTypes?.length===1&&details.mediaTypes[0]==='audio'));
 partition.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{const url=new URL(details.url);allowed=url.origin===endpoint.origin||url.protocol==='blob:'&&url.origin===endpoint.origin||url.protocol==='data:'||url.protocol==='ws:'&&url.host===endpoint.host;}catch{}callback({cancel:!allowed});});
 const importMapHash=createHash('sha256').update('{"imports":{"three":"./three.module.js"}}').digest('base64');
 partition.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[`default-src 'self'; script-src 'self' 'sha256-${importMapHash}' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' blob: ws://${endpoint.host}; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'`]}}));
 const window=new BrowserWindow({width:1260,height:900,minWidth:720,minHeight:560,title:'Lifestream',backgroundColor:'#111f2e',webPreferences:{preload:resolve(__dirname,'preload.cjs'),session:partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,spellcheck:false}});
 gameHostControls=installGameHostControls({ipcMain,window,origin:endpoint.origin});
 let gameHost;
 if(process.platform==='win32'&&endpoint.origin==='http://127.0.0.1:43182'){
  const flag='--game-host-setup',pin='--game-host-setup-sha256',pathAt=args.indexOf(flag),pinAt=args.indexOf(pin);
  if(args.filter(x=>x===flag).length>1||args.filter(x=>x===pin).length>1||(pathAt>=0)!==(pinAt>=0))throw Error('game_host_setup_unavailable');
  const setupSource=pathAt>=0?{path:args[pathAt+1],sha256:args[pinAt+1]}:null;
  const [nativeSdk,contracts]=await Promise.all([import('@lifestream/providers-bizhawk'),import('@lifestream/contracts/game-host')]);
  const buildFile=resolve(__dirname,'build.json'),sourceRevision=existsSync(buildFile)?JSON.parse(readFileSync(buildFile,'utf8')).sourceRevision:null;
  const nativeDirectory=app.isPackaged?resolve(__dirname,'native'):resolve(__dirname,'../../packages/providers-bizhawk/native');
  gameHost=createDesktopGameHostComposition({controls:gameHostControls,net,partition,sdk:{...nativeSdk,...contracts},sourceRevision,nativeDirectory,setupSource});
  // Trusted-main callable API; never exposed through renderer IPC.
  module.exports.gameHostComposition=gameHost;
 }
 const report=async()=>{const value=gameHost?await gameHost.readiness():{ready:false,authenticated:false,nativeConfigured:false};
  console.log(JSON.stringify({kind:'onDemandDesktopGameHostReadiness',checkedAt:new Date().toISOString(),...value}));
  await dialog.showMessageBox(window,{type:'info',title:'Game host connection',message:value.ready?'Native session is ready.':'Native session is not ready.',detail:!value.authenticated?'Sign in in this native window.':!value.administrationCurrent?'Native administration has expired.':!value.contextCurrent?'Review Session disclosure in this native window.':value.attached?'The approved native game host is attached.':value.nativeConfigured?'Approved native setup is supplied; the game session has not started.':'No approved native game setup is supplied. Readiness does not start gameplay.'});};
 const startApproved=async()=>{try{await gameHost.startApprovedSession();}catch{await dialog.showMessageBox(window,{type:'warning',title:'Game host connection',message:'The approved game session could not start.',detail:'The native session, finite setup and independently qualified backend must all be current. No automatic retry is performed.'});}};
 Menu.setApplicationMenu(Menu.buildFromTemplate([{role:'fileMenu'},{role:'editMenu'},{role:'viewMenu'},{label:'Game',submenu:[{id:'game-host-readiness',label:'Check game host connection',click:()=>void report().catch(()=>{})},{id:'game-host-start',label:'Start approved game session',enabled:gameHost?.configured===true,click:()=>void startApproved()},{id:'game-host-stop',label:'Stop game session',click:()=>void gameHost?.stop('stop')}]}]));
 window.on('closed',()=>{void gameHost?.stop('closed');});
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==endpoint.origin)event.preventDefault();});window.webContents.on('will-attach-webview',event=>event.preventDefault());
 let locked=false;const privacy=value=>{locked=value;if(!window.isDestroyed())window.webContents.send('privacy-lock',locked);};powerMonitor.on('lock-screen',()=>privacy(true));powerMonitor.on('unlock-screen',()=>privacy(false));powerMonitor.on('suspend',()=>privacy(true));powerMonitor.on('resume',()=>privacy(false));ipcMain.handle('privacy-lock-state',event=>{if(event.sender!==window.webContents||new URL(event.senderFrame.url).origin!==endpoint.origin)return true;return locked;});
 window.webContents.on('did-fail-load',(_event,code,_description,url,mainFrame)=>{
  if(!mainFrame||code===-3||window.isDestroyed())return;
  try{if(new URL(url).origin!==endpoint.origin)return;}catch{return;}
  void window.loadURL(connectionPage(endpoint)).catch(()=>{});
 });
 await window.loadURL(endpoint.href).catch(()=>{});
 window.show();
 // Optional trusted launch diagnostic. It uses this real window's partition,
 // never a disposable profile, cookie getter or renderer-supplied request.
 if(args.includes('--game-host-readiness')){
  const {DesktopGameHostSessionBroker}=require('./game-host-session-broker.cjs');
  const inspector=new DesktopGameHostSessionBroker({net,partition,gameHostMessage:()=>null});
  const deadline=Date.now()+120000;let previous=null,busy=false;
  const inspect=async()=>{if(busy||window.isDestroyed()||Date.now()>=deadline)return;busy=true;try{const value=await inspector.readiness(),text=JSON.stringify(value);if(text!==previous){previous=text;console.log(JSON.stringify({kind:'actualDesktopGameHostReadiness',checkedAt:new Date().toISOString(),...value}));}}finally{busy=false;}};
  await inspect();const timer=setInterval(()=>{if(window.isDestroyed()||Date.now()>=deadline)clearInterval(timer);else void inspect();},5000);timer.unref();window.once('closed',()=>clearInterval(timer));
 }
 if(args.includes('--diagnostic'))console.log(JSON.stringify({host:'Electron',version:process.versions.electron,packaged:app.isPackaged,sandbox:true,contextIsolation:true,nodeIntegration:false,origin:endpoint.origin}));
});
app.on('window-all-closed',()=>app.quit());
