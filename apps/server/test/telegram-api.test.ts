import assert from 'node:assert/strict';
import test from 'node:test';
import {TelegramBotApi,telegramPrivateMessage} from '../src/channels/telegram-api.ts';
const signal=()=>new AbortController().signal;
const message=(overrides={})=>({update_id:17,message:{message_id:31,date:Math.floor(Date.now()/1000),chat:{id:1234,type:'private'},from:{id:1234,is_bot:false},text:'Synthetic question',...overrides}});
const response=(result:unknown)=>new Response(JSON.stringify({ok:true,result}),{status:200});
const token='9999:synthetic_credential_not_for_live_use';
test('strict private message ingress rejects groups, impersonation, old updates and forwarded content',()=>{
 assert.equal(telegramPrivateMessage(message())!.userId,'1234');assert.equal(telegramPrivateMessage(message({reply_to_message:{text:'untrusted quoted content'}}))!.text,'Synthetic question');for(const bad of [{chat:{id:-1234,type:'group'}},{from:{id:1234,is_bot:true}},{from:{id:9999,is_bot:false}},{date:Math.floor(Date.now()/1000)-301},{forward_origin:{}},{via_bot:{}},{text:'x'.repeat(4097)}])assert.equal(telegramPrivateMessage(message(bad)),undefined);assert.equal(telegramPrivateMessage({...message(),edited_message:message().message,message:undefined}),undefined);
});
test('disabled construction and sends do no network IO; identity and updates use outbound bounded requests',async()=>{
 const calls:{url:string;body:Record<string,unknown>}[]=[];let enabled=false;const api=new TelegramBotApi({botId:'9999',token:()=>token,enabled:()=>enabled,fetch:async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body))});assert.equal(init?.redirect,'error');assert.equal(new URL(String(url)).hostname,'api.telegram.org');return String(url).endsWith('getMe')?response({id:9999,is_bot:true}):response([message(),{update_id:18,edited_message:{}}]);}});
 assert.deepEqual(await api.send('1234','Hello',signal()),{status:'notStarted'});assert.equal(calls.length,0);enabled=true;await api.verify(signal());const updates=await api.updates(17,signal());assert.equal(updates.nextOffset,19);assert.equal(updates.messages.length,1);assert.deepEqual(calls[1]!.body,{offset:17,limit:100,timeout:20,allowed_updates:['message']});
});
test('outgoing text uses fixed private destination, no formatting, previews or paid broadcasts; acceptance is not receipt',async()=>{
 let body!:Record<string,unknown>;const api=new TelegramBotApi({botId:'9999',token:()=>token,enabled:()=>true,fetch:async(_url,init)=>{body=JSON.parse(String(init?.body));return response({message_id:42,chat:{id:1234,type:'private'}});}});assert.deepEqual(await api.send('1234','<script>literal</script>',signal()),{status:'accepted',messageId:42});assert.deepEqual(body,{chat_id:'1234',text:'<script>literal</script>',protect_content:true,link_preview_options:{is_disabled:true},allow_paid_broadcast:false});assert.deepEqual(await api.send('-1234','no',signal()),{status:'notStarted'});
});
test('network ambiguity never retries or leaks credentials; response validation rejects false success',async()=>{
 let count=0;const options={botId:'9999',token:()=>token,enabled:()=>true};const api=new TelegramBotApi({...options,fetch:async()=>{count++;throw Error('https://api.telegram.org/bot'+token);}});assert.deepEqual(await api.send('1234','Synthetic',signal()),{status:'unknown'});assert.equal(count,1);await assert.rejects(api.verify(signal()),error=>error instanceof Error&&error.message==='Telegram transport unavailable');
 const rejected=new TelegramBotApi({...options,fetch:async()=>new Response(JSON.stringify({ok:false,description:token}),{status:403})});assert.deepEqual(await rejected.send('1234','Synthetic',signal()),{status:'rejected'});
 const wrong=new TelegramBotApi({...options,fetch:async()=>response({message_id:1,chat:{id:7777,type:'private'}})});assert.deepEqual(await wrong.send('1234','Synthetic',signal()),{status:'unknown'});
 const huge=new TelegramBotApi({...options,fetch:async()=>new Response('x'.repeat(1_048_577))});assert.deepEqual(await huge.send('1234','Synthetic',signal()),{status:'unknown'});
});
