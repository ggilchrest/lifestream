-- Factory shared by the real graphical entrypoint and isolated Lua fixtures.
-- Native callbacks are supplied by entry.lua, never by a model or socket message.
return function(config, deps)
  local json, api, clock, crypto, channel, store = deps.json, deps.api, deps.clock, deps.crypto, deps.channel, deps.store
  local names={up='Up',down='Down',left='Left',right='Right',a='A',b='B',x='X',y='Y',l='L',r='R',start='Start',select='Select'}
  local neutral={}; for _,name in pairs(names) do neutral[name]=false end
  local lease, retired, ready, currentAction = nil, false, false, nil
  local seen, receipts, requestCount = {}, {}, 0
  local began, runBegan, runFrame, actions = clock.ms(), nil, nil, 0
  local protocol='lifestream-game-control/1'
  local function same(a,b) return json.encode(a)==json.encode(b) end
  local function live() return ready and not retired and clock.ms()-began<config.sessionDurationMs and channel.connected() end
  local function available()
    return live() and api.version()==config.emulatorVersion and api.system()=='SNES' and api.romHash():lower()==config.romSha1
  end
  local function neutralize()
    api.set(neutral)
    local state=api.immediate()
    for _,name in pairs(names) do if state[name]~=false then return false end end
    return true
  end
  local function halt()
    local ok, result=pcall(neutralize); api.pause()
    return ok and result==true
  end
  local function send(request,status,payload,code)
    local error=json.null
    if status~='succeeded' then error={code=code or 'native.unavailable',message='Native game operation unavailable.',retryable=false,correlationId=request.correlationId,details=json.array({})} end
    channel.send(json.encode({schemaVersion='1.0.0',operation=request.operation,requestId=request.requestId,correlationId=request.correlationId,providerRef=config.providerRef,completedAt=clock.utc(),outcome={status=status,payload=payload or json.null,error=error}}))
  end
  local function fresh(request)
    return type(request)=='table' and request.schemaVersion=='1.0.0' and same(request.scope,config.scope) and clock.before(request.deadlineAt) and request.executionMode==config.executionMode
  end
  local function release(request)
    local p=request.payload
    if p.targetInputOwnerLeaseId~=lease then
      send(request,'succeeded',{targetInputOwnerLeaseId=p.targetInputOwnerLeaseId,disposition='successorPreserved',confirmedAt=json.null,emulatorPaused=json.null,buttonsNeutralized=json.null,pauseFrameNumber=json.null,verifiedFrameNumber=json.null,pauseConfirmedMonotonicMs=json.null,verifiedMonotonicMs=json.null,activityEpochAfterFence=json.null,confirmationSource='notApplicable',resumeRequiresFreshObservation=true})
      return false
    end
    retired=true
    if currentAction then currentAction.cancelled=true end
    local cleared, first, second=halt()
    local at=math.floor(clock.ms()); first=api.frame(); api.yield(); second=api.frame()
    local later=math.floor(clock.ms())
    local confirmed=cleared and api.paused() and first==second and later>at
    send(request,'succeeded',{targetInputOwnerLeaseId=p.targetInputOwnerLeaseId,disposition=confirmed and 'neutralizedAndPaused' or 'outcomeUnknown',confirmedAt=confirmed and clock.utc() or json.null,emulatorPaused=api.paused(),buttonsNeutralized=cleared,pauseFrameNumber=first,verifiedFrameNumber=second,pauseConfirmedMonotonicMs=at,verifiedMonotonicMs=later,activityEpochAfterFence=config.scope.activityEpoch+1,confirmationSource=confirmed and 'adapterObserved' or 'unconfirmed',resumeRequiresFreshObservation=true})
    return true
  end
  local function budgetAvailable()
    return not runBegan or clock.ms()-runBegan<config.bounds.wallBudgetMs and api.frame()-runFrame<config.bounds.frameBudget
  end
  local function action(request)
    local p=request.payload; local proposal=p.proposal; local admission=p.admission
    if not available() or not budgetAvailable() or actions>=config.bounds.actionBudget or p.expectedPinsDigest~=config.pinsDigest or p.protectedMenuOperation~='none' or p.expectedFrameNumber~=api.frame() or not same(proposal.scope,config.scope) or not clock.before(admission.expiresAt) or not clock.issued(admission.issuedAt) or not clock.before(p.dispatchValidation.preparedContextFreshUntil) or proposal.durationFrames<1 or proposal.durationFrames>config.bounds.maxActionFrames or proposal.maxWallMs<1 or proposal.maxWallMs>config.bounds.maxActionWallMs then send(request,'rejected',nil,'native.stale_or_unavailable');return end
    -- A reviewed visible-field decoder remains a host prerequisite. This native
    -- layer never invents field values or substitutes model assertions for it.
    local vector={};local proposed={};for _,button in ipairs(proposal.buttons)do proposed[button]=true end
    local count=0;for button,pressed in pairs(p.buttonVector)do if not names[button] or type(pressed)~='boolean' or pressed~=(proposed[button]==true)then send(request,'rejected',nil,'native.invalid_vector');return end;vector[names[button]]=pressed;count=count+1 end
    if count~=12 then send(request,'rejected',nil,'native.invalid_vector');return end
    for button in pairs(proposed)do if not names[button]then send(request,'rejected',nil,'native.invalid_vector');return end end
    if not runBegan then runBegan=clock.ms();runFrame=api.frame() end
    actions=actions+1;lease=p.inputOwnerLeaseId
    local before=api.frame();local started=clock.utc();local startMs=clock.ms();local deadlineMs=startMs+math.min(proposal.maxWallMs,config.bounds.maxInputLeaseMs)
    currentAction={cancelled=false};local disposition='completed'
    api.speedOne();api.resume()
    for _=1,proposal.durationFrames do
      if not live() or not budgetAvailable() or not clock.before(request.deadlineAt) or not clock.before(admission.expiresAt) or clock.ms()>=deadlineMs then disposition='cancelled';break end
      local incoming=channel.receive()
      if incoming then
        local other=json.decode(incoming)
        if fresh(other) and other.operation=='GameActivityAdapter.releaseControls' and not seen[other.requestId] then seen[other.requestId]=true;requestCount=requestCount+1;release(other)
        elseif fresh(other)then send(other,'rejected',nil,'native.busy') end
      end
      if currentAction.cancelled then disposition='cancelled';break end
      api.set(vector);local prior=api.frame();api.advance();if api.frame()~=prior+1 then disposition='failed';break end
    end
    local after=api.frame();local completed=clock.utc();local cleared=neutralize()
    if not cleared then disposition='outcomeUnknown';retired=true;api.pause() end
    if disposition~='completed' then retired=true;halt() end
    local receipt={schemaVersion='1.0.0',recordType='gameActionReceipt',scope=config.scope,actionId=p.actionId,proposalId=proposal.proposalId,idempotencyKey=request.idempotencyKey,inputDigest=admission.inputDigest,admissionId=admission.admissionId,disposition=disposition,beforeFrame=before,afterFrame=after,framesApplied=after-before,buttonsNeutralized=cleared,startedAt=started,completedAt=completed,resultingObservationIds=json.array({}),recordedAt=clock.utc(),reason='Native frame and effective-controller readback; no gameplay competence claim.'}
    receipts[p.actionId]=receipt;currentAction=nil;send(request,'succeeded',receipt)
  end
  local function observe(request)
    if not available() or not budgetAvailable() or request.payload.expectedPinsDigest~=config.pinsDigest or request.payload.maxScreenshots<1 then send(request,'rejected',nil,'native.unavailable');return end
    local previous=request.payload.afterActionId
    if previous~=json.null and previous~=nil and not receipts[previous]then send(request,'rejected',nil,'native.unreconciled');return end
    local frame=api.frame();local captured=clock.utc();local shot=store.capture(frame,captured)
    if frame~=api.frame()then send(request,'rejected',nil,'native.capture_changed');return end
    local observation={schemaVersion='1.0.0',recordType='gameObservation',scope=config.scope,observationId=crypto.uuid(),revision=1,pinsDigest=config.pinsDigest,frameNumber=frame,capturedAt=captured,receivedAt=clock.utc(),interpretedAt=json.null,providerConfigurationRef=json.null,screenshots=json.array({shot}),facts=json.array({}),visibleState=json.array({}),previousActionId=previous or json.null,untrusted=true}
    send(request,'succeeded',{observation=observation,reconciledAction=receipts[previous]or json.null})
  end
  local function handle(raw)
    if #raw>131072 then retired=true;halt();return end
    local request=json.decode(raw)
    if not fresh(request) or seen[request.requestId] or requestCount>=257 or requestCount>=256 and request.operation~='GameActivityAdapter.releaseControls' then retired=true;halt();return end
    seen[request.requestId]=true;requestCount=requestCount+1
    if request.operation=='GameActivityAdapter.releaseControls'then release(request)
    elseif request.operation=='GameActivityAdapter.applyController'then action(request)
    elseif request.operation=='GameActivityAdapter.observe'then observe(request)
    elseif request.operation=='GameActivityAdapter.controlSave'then send(request,'rejected',nil,'native.save_not_qualified')
    else retired=true;halt() end
  end
  local function authenticate()
    local raw=channel.receive(1000);assert(raw and #raw<=131072,'Native pairing unavailable')
    local challenge=json.decode(raw)
    assert(challenge.type=='challenge'and challenge.protocol==protocol and challenge.providerRef==config.providerRef and challenge.pinsDigest==config.pinsDigest and challenge.scopeDigest==config.scopeDigest and clock.before(challenge.expiresAt),'Native pairing unavailable')
    channel.send('{"type":"authenticate","proof":'..json.encode(crypto.hmac(raw))..'}')
    local confirmed=json.decode(assert(channel.receive(1000),'Native pairing unavailable'))
    assert(confirmed.type=='authenticated'and confirmed.protocol==protocol and confirmed.sessionId==challenge.sessionId and crypto.equal(confirmed.proof,crypto.hmac(protocol..' host '..raw)),'Native host authentication unavailable')
    ready=true;began=clock.ms()
  end
  local function idle()
    if not live() or not budgetAvailable()then retired=true;halt();return false end
    if runBegan then neutralize();api.advance() else api.pause();api.yield() end
    return true
  end
  return {authenticate=authenticate,handle=handle,idle=idle,halt=function()retired=true;halt()end}
end
