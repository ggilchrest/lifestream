const {contextBridge,ipcRenderer}=require('electron');
// Renderer receives one read-only restriction signal. No filesystem/provider API.
contextBridge.exposeInMainWorld('lifestreamDesktop',Object.freeze({onPrivacyLock(callback){if(typeof callback!=='function')return;const listener=(_event,locked)=>callback(locked===true);ipcRenderer.on('privacy-lock',listener);ipcRenderer.invoke('privacy-lock-state').then(locked=>callback(locked===true));return ()=>ipcRenderer.removeListener('privacy-lock',listener);}}));
