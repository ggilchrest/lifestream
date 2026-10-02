'use strict';
const {DesktopGameHostSessionBroker,trustedGameHostSender}=require('./game-host-session-broker.cjs');
const DISABLED=Object.freeze({state:'disabled',enabled:false,authenticated:false,scopeCurrent:false,pauseConfirmed:false});
/** Read status and stop only. bindBroker is returned to trusted main, never
 * exposed through IPC. No renderer start, setup, credentials or generic fetch. */
function installGameHostControls({ipcMain,window,origin}){
 let broker=null,unsubscribe=null,closing=false;
 const status=()=>broker?broker.status():DISABLED;
 ipcMain.handle('game-host-status',event=>trustedGameHostSender(event,window,origin)?status():DISABLED);
 ipcMain.handle('game-host-readiness',async event=>trustedGameHostSender(event,window,origin)&&broker?broker.readiness():Object.freeze({authenticated:false,owner:false,administrationCurrent:false,contextCurrent:false,ready:false}));
 ipcMain.handle('game-host-stop',async event=>{if(!trustedGameHostSender(event,window,origin))return DISABLED;return broker?broker.stop('stop'):DISABLED;});
 const publish=value=>{if(!window.isDestroyed())window.webContents.send('game-host-status',value);};
 window.on('close',event=>{if(broker&&broker.status().state!=='disabled'&&broker.status().state!=='stopped'&&!closing){event.preventDefault();closing=true;void broker.stop('closed').finally(()=>window.close());}});
 window.on('closed',()=>{unsubscribe?.();void broker?.stop('closed');ipcMain.removeHandler('game-host-status');ipcMain.removeHandler('game-host-readiness');ipcMain.removeHandler('game-host-stop');});
 return Object.freeze({publish,bindBroker(value){if(broker||!(value instanceof DesktopGameHostSessionBroker))throw Error('game_host_session_unavailable');broker=value;unsubscribe=broker.subscribeStatus(publish);publish(status());}});
}
module.exports={installGameHostControls};
