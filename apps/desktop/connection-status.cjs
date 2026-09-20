const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function endpointFromArguments(argv,defaultApp=false){
 const args=argv.slice(defaultApp?2:1),flag=args.indexOf('--url');
 const endpoint=new URL(flag>=0?args[flag+1]:'http://127.0.0.1:43182/control/#conversation');
 if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||!endpoint.port||endpoint.pathname!=='/control/'||endpoint.search)throw Error('The desktop endpoint requires a loopback /control/ URL.');
 return {endpoint,args};
}
function connectionPage(endpoint){
 return 'data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Lifestream · Connection unavailable</title><style>body{margin:0;background:#f2f8fc;color:#16364d;font:18px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}main{box-sizing:border-box;max-width:650px;margin:24px;padding:36px;background:white;border:1px solid #bed5e5;border-radius:20px}h1{font-size:30px;line-height:1.2}a{display:inline-block;background:#076f8c;color:white;font-weight:650;text-decoration:none;padding:12px 20px;border-radius:12px}a:focus-visible{outline:3px solid #223dce;outline-offset:4px}code{overflow-wrap:anywhere;font-size:15px}</style><main><p>Lifestream</p><h1>The local server is unavailable</h1><p>Start your configured Lifestream server, then retry. Your selected endpoint and saved data have not changed.</p><p><code>${escape(endpoint.origin)}</code></p><a href="${escape(endpoint.href)}">Retry connection</a><p>You can also close this window and reopen Lifestream later.</p></main></html>`);
}
module.exports={endpointFromArguments,connectionPage};
