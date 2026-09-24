import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,mkdir,chmod,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadTelegramConfiguration,parseTelegramConfiguration,telegramHostConfiguration} from '../src/channels/telegram-configuration.ts';
const config={schemaVersion:'1.0.0',botId:'9999',enabled:false,tokenRef:{kind:'env',name:'LIFESTREAM_TELEGRAM_TOKEN'}};
test('host defaults remain off; enabling requires matching environment credentials and never creates authority',()=>{
 const disabled=telegramHostConfiguration(config,{});assert.equal(disabled.enabled(),false);assert.equal(disabled.token(),undefined);assert.equal(disabled.alerts,undefined);assert.equal(disabled.transport,undefined);
 const environment={LIFESTREAM_TELEGRAM_TOKEN:'9999:'+'x'.repeat(24)},enabled=telegramHostConfiguration({...config,enabled:true},environment);assert.equal(enabled.enabled(),true);assert.equal(enabled.token(),environment.LIFESTREAM_TELEGRAM_TOKEN);environment.LIFESTREAM_TELEGRAM_TOKEN='changed';assert.equal(enabled.token(),undefined);
 for(const token of [undefined,'9998:'+'x'.repeat(24),'9999:short','9999:'+'x'.repeat(24)+'\n'])assert.throws(()=>telegramHostConfiguration({...config,enabled:true},{LIFESTREAM_TELEGRAM_TOKEN:token}),/matching bot token/);
});
test('strict host schema rejects inline secrets, extra authority or destinations and arbitrary transport origins',()=>{
 for(const value of [null,[],{...config,token:'SECRET_CANARY'},{...config,baseUrl:'https://elsewhere.invalid'},{...config,alerts:{dispatch:'admitted'}},{...config,subscriptions:[]},{...config,enabled:'true'},{...config,tokenRef:{kind:'env',name:'HOME'}},{...config,tokenRef:{kind:'file',name:'LIFESTREAM_TELEGRAM_TOKEN'}},{...config,botId:'9999/secret'},{...config,botId:'9999999999999999'}])assert.throws(()=>parseTelegramConfiguration(value),e=>e instanceof Error&&!e.message.includes('SECRET_CANARY'));
});
test('configuration file must be bounded, private, outside Git and not a symlink; failures redact content',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ls-telegram-config-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'telegram.json');await writeFile(file,JSON.stringify(config),{mode:0o600});assert.equal((await loadTelegramConfiguration(file,{})).enabled(),false);
 await chmod(file,0o644);await assert.rejects(loadTelegramConfiguration(file,{}));await chmod(file,0o600);await symlink(file,join(dir,'link'));await assert.rejects(loadTelegramConfiguration(join(dir,'link'),{}));await assert.rejects(loadTelegramConfiguration('relative.json',{}));
 await mkdir(join(dir,'.git'));await assert.rejects(loadTelegramConfiguration(file,{}));await rm(join(dir,'.git'),{recursive:true});await writeFile(file,'SECRET_CANARY');await assert.rejects(loadTelegramConfiguration(file,{}),e=>e instanceof Error&&!e.message.includes('SECRET_CANARY'));await writeFile(file,' '.repeat(8193));await assert.rejects(loadTelegramConfiguration(file,{}));
});
