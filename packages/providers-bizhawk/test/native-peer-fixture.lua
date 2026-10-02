-- Deterministic simulation of peer.lua; no game/core/RAM/controller APIs.
local cases=0
local function check(value)assert(value,'Native peer fixture failed');cases=cases+1 end
local null={};local registry={}
local function encode(v)
  if v==null then return 'null'end
  if type(v)=='table'then local keys={};for k in pairs(v)do keys[#keys+1]=k end;table.sort(keys,function(a,b)return tostring(a)<tostring(b)end);local parts={};for _,k in ipairs(keys)do parts[#parts+1]=tostring(k)..':'..encode(v[k])end;local raw='{'..table.concat(parts,',')..'}';registry[raw]=v;return raw end
  return tostring(v)
end
local json={null=null,array=function(v)return v end,encode=encode,decode=function(raw)return assert(registry[raw])end}
local function fixture()
  local now,frame,paused,connected=0,10,true,true
  local state={buttons={},advanced=0};local incoming,sent={},{};local count=0
  local config={scope={activityEpoch=1},executionMode='simulation',providerRef='fixture',pinsDigest='pins',scopeDigest='scope',romSha1=string.rep('b',40),emulatorVersion='2.11.1',sessionDurationMs=10000,bounds={maxActionFrames=5,maxActionWallMs=200,maxInputLeaseMs=200,actionBudget=4,frameBudget=20,wallBudgetMs=1000}}
  local api={version=function()return state.version or '2.11.1'end,system=function()return 'SNES'end,romHash=function()return config.romSha1 end,frame=function()return frame end,set=function(v)state.buttons=v end,immediate=function()return state.buttons end,pause=function()paused=true end,paused=function()return paused end,resume=function()paused=false end,speedOne=function()end,yield=function()now=now+1 end,advance=function()frame=frame+1;now=now+20;state.advanced=state.advanced+1;if state.disconnect then connected=false end end}
  local clock={ms=function()return now end,utc=function()return tostring(now)end,before=function(t)return tonumber(t)>now end,issued=function(t)return tonumber(t)<=now end}
  local crypto={uuid=function()count=count+1;return 'fixture-'..count end,hmac=function()return string.rep('d',64)end,equal=function(a,b)return a==b end}
  local channel={connected=function()return connected end,receive=function()return table.remove(incoming,1)end,send=function(raw)sent[#sent+1]=json.decode(raw)end}
  local challenge=encode({type='challenge',protocol='lifestream-game-control/1',providerRef=config.providerRef,pinsDigest=config.pinsDigest,scopeDigest=config.scopeDigest,expiresAt='10000',sessionId='session'})
  incoming[1]=challenge;incoming[2]=encode({type='authenticated',protocol='lifestream-game-control/1',sessionId='session',proof=crypto.hmac()})
  -- Canonical authentication reply is a string handled separately in this mock.
  local send=channel.send;channel.send=function(raw)if raw:match('^%{"type":"authenticate"')then return end;send(raw)end
  local factory=assert(loadfile(assert(os.getenv('LIFESTREAM_NATIVE_PEER_FILE'))))()
  local peer=factory(config,{json=json,api=api,clock=clock,crypto=crypto,channel=channel,store={capture=function(f,t)return {frameNumber=f,capturedAt=t}end}})
  peer.authenticate()
  local function request(operation)
    count=count+1;local vector={up=false,down=false,left=false,right=false,a=true,b=false,x=false,y=false,l=false,r=false,start=false,select=false}
    return {schemaVersion='1.0.0',scope=config.scope,executionMode='simulation',requestId='request-'..count,correlationId='correlation',idempotencyKey='identity',deadlineAt='10000',operation=operation or 'GameActivityAdapter.applyController',payload={actionId='action',inputOwnerLeaseId='lease',expectedPinsDigest=config.pinsDigest,expectedFrameNumber=frame,protectedMenuOperation='none',buttonVector=vector,proposal={scope=config.scope,proposalId='proposal',buttons={'a'},durationFrames=3,maxWallMs=200},admission={expiresAt='10000',issuedAt='0',inputDigest='input',admissionId='admission'},dispatchValidation={preparedContextFreshUntil='10000'}}}
  end
  return {peer=peer,request=request,state=state,incoming=incoming,sent=sent,config=config,paused=api.paused}
end
local out=assert(io.open(assert(os.getenv('LIFESTREAM_NATIVE_FIXTURE_RESULT')),'w'))
local ok=pcall(function()
  local f=fixture();local r=f.request();f.peer.handle(encode(r));local result=f.sent[#f.sent];check(result.outcome.payload.framesApplied==3);check(result.outcome.payload.disposition=='completed');check(result.outcome.payload.buttonsNeutralized==true)
  local release=f.request('GameActivityAdapter.releaseControls');release.payload={targetInputOwnerLeaseId='lease',reason='pause'};f.peer.handle(encode(release));check(f.paused());check(f.sent[#f.sent].outcome.payload.disposition=='neutralizedAndPaused')
  for _,change in ipairs({function(f,r)r.payload.expectedFrameNumber=9 end,function(f,r)r.payload.buttonVector.b=true end,function(f,r)r.payload.protectedMenuOperation='save'end,function(f,r)r.payload.admission.expiresAt='0'end,function(f,r)f.state.version='wrong'end})do local f=fixture();local r=f.request();change(f,r);f.peer.handle(encode(r));check(f.state.advanced==0);check(f.sent[#f.sent].outcome.status=='rejected')end
  local f=fixture();f.state.disconnect=true;f.peer.handle(encode(f.request()));check(f.state.advanced==1);check(f.paused());check(f.sent[#f.sent].outcome.payload.disposition=='cancelled')
  local f=fixture();local r=f.request();local release=f.request('GameActivityAdapter.releaseControls');release.payload={targetInputOwnerLeaseId='lease',reason='pause'};f.incoming[1]=encode(release);f.peer.handle(encode(r));check(f.state.advanced==0);check(f.paused());check(f.sent[#f.sent].outcome.payload.disposition=='cancelled')
  local f=fixture();local r=f.request();f.peer.handle(encode(r));f.peer.handle(encode(r));check(f.state.advanced==3);check(f.paused())
  local f=fixture();f.peer.handle(encode(f.request('GameActivityAdapter.controlSave')));check(f.state.advanced==0);check(f.sent[#f.sent].outcome.error.code=='native.save_not_qualified')
  local f=fixture();f.peer.handle(encode(f.request()));for _=1,100 do if not f.peer.idle()then break end end;check(f.paused());check(f.state.advanced<=20)
end)
out:write('simulation=true\nrom_loaded=false\npassed='..tostring(ok)..'\nassertions='..cases..'\n');out:close()
client.pause();client.exit()
