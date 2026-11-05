import type {IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
import {AuthenticationError} from '../auth/local-auth.ts';

const exactOrigin=/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})$/;
const dynamicPortOrigin=/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\*$/;
function validExactOrigin(value:string):boolean{
 const match=exactOrigin.exec(value);
 return !!match&&match[0]===value&&Number(match[2])<=65535;
}

/** An explicit loopback browser authority. A port-only wildcard opts one literal
 * hostname into changing local forwards; it never permits cross-origin requests
 * or trusts forwarding headers. Exact origins retain their prior behavior. */
export function captureLoopbackBrowserOrigin(value:unknown):string|undefined{
 if(value===undefined)return undefined;
 if(typeof value!=='string')throw Error('Explicit loopback browser origin required');
 const dynamic=dynamicPortOrigin.exec(value);
 if(!validExactOrigin(value)&&dynamic?.[0]!==value)throw Error('Explicit loopback browser origin required');
 return value;
}
const loopbackPeer=(address:string|undefined)=>address==='::1'||typeof address==='string'&&(
 isIP(address)===4&&address.startsWith('127.')||address.startsWith('::ffff:')&&isIP(address.slice(7))===4&&address.slice(7).startsWith('127.'));

/** Normalize only the configured browser authority, checking the socket and both
 * browser headers. Existing authentication/session/CSRF owners see their original
 * canonical origin. Returns the alias solely for WebSocket query-origin checks. */
export function normalizeLoopbackBrowserRequest(request:IncomingMessage,canonicalOrigin:string,alias:string|undefined,mutation:boolean):string|undefined{
 if(alias===undefined||request.headers.host===new URL(canonicalOrigin).host)return undefined;
 let browserOrigin=alias;
 if(alias.endsWith(':*')){
  browserOrigin=`http://${request.headers.host}`;
  if(!validExactOrigin(browserOrigin)||browserOrigin.slice(0,browserOrigin.lastIndexOf(':')+1)!==alias.slice(0,-1))throw new AuthenticationError(403,'origin_rejected');
 }
 const host=browserOrigin.slice('http://'.length),origin=request.headers.origin;
 const counts={host:0,origin:0};
 for(let i=0;i<request.rawHeaders.length;i+=2){const name=request.rawHeaders[i]!.toLowerCase();if(name==='host'||name==='origin')counts[name]++;}
 if(!loopbackPeer(request.socket.remoteAddress)||request.headers.host!==host||counts.host!==1||counts.origin>1||origin!==undefined&&origin!==browserOrigin||mutation&&origin!==browserOrigin)throw new AuthenticationError(403,'origin_rejected');
 request.headers.host=new URL(canonicalOrigin).host;
 if(origin!==undefined)request.headers.origin=canonicalOrigin;
 return browserOrigin;
}
