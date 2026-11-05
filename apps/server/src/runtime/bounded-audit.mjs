import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, readFileSync, writeSync, mkdirSync, lstatSync, readdirSync, rmSync, constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { channel } from 'node:diagnostics_channel';
import { DatabaseSync } from 'node:sqlite';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const routes = new Map([['/api/runtime/v1/audience', 'audience'], ['/api/runtime/v1/audience/personal-session','personal_session'], ['/api/runtime/v1/audience/lease', 'audience_lease'], ['/api/runtime/v1/audio', 'audio']]);
const stages = new Set(['database_summary','database_slow','pcm_summary','audit_decision','session_start', 'session_stop', 'request_received', 'request_finished', 'request_closed', 'turn_start', 'asr_begin', 'asr_end', 'prepare_begin', 'prepare_end', 'memory_begin', 'memory_end', 'world_begin', 'world_end', 'admission', 'generation_begin', 'generation_end', 'generation_error', 'tts_begin', 'tts_pre_audio', 'tts_pcm', 'tts_terminal', 'tts_error', 'server_pcm', 'socket_terminal', 'socket_stop', 'socket_closed', 'playback_settlement', 'lease_acquired', 'lease_released', 'turn_finally', 'currentness_failed', 'currentness_reported', 'database', 'event_loop', 'provider_request', 'provider_response', 'provider_error', 'input_audio', 'speech_text', 'output_audio']);
const enums = new Set(['discovery','request_enrollment','socket_enrollment','turn_enrollment','discovery_eligible','auth_required','owner_required','endpoint_missing','personal_phone_required','private_disclosure_required','endpoint_not_owned','endpoint_unhealthy','private_audience_required','endpoint_binding_missing','selection_missing','selected_user_mismatch','scope_check_unavailable','labels_missing','labels_malformed','session_mismatch','foreign_pinned_scope','assistant_mismatch','preview_excluded','consent_missing','socket_provisional','scope_ready','turn_enrolled','capture_off','voice', 'text', 'freshUntil', 'sourceValidUntil', 'none', 'true', 'false', 'unavailable', 'succeeded', 'completed', 'failed', 'interrupted', 'cancelled', 'timedOut', 'rejected', 'exhausted', 'stopped', 'deadline', 'disconnected', 'invalidated', 'audio_turn_failed', 'audio_interrupted', 'audio_deadline_exceeded', 'audio_stalled', 'runtime_input_stale', 'audio_input_scope_changed', 'endpoint_playback_stopped_or_expired', 'turn_source_expiry', 'authorization', 'lifecycle', 'context_fingerprint', 'pending_help', 'experience_boundary', 'prepared_context_expiry', 'asr', 'preparation', 'memory', 'world', 'generation', 'synthesis', 'delivery', 'settlement', 'GET', 'POST', 'audience', 'audience_lease', 'personal_session', 'audio', 'inference', 'speech', 'run', 'get', 'all', 'prepare', 'exec', 'transport_error', 'unclassified', 'providerUnavailable', 'deadlineExceeded', 'retryableProviderFailure', 'nonRetryableProviderFailure', 'malformedRequest', 'unsupportedRequest', 'preAudio', 'data', 'terminal', 'capture_limit', 'operator_off', 'expired', 'capture_error', 'client_off', 'client_inactive']);
const nums = new Set(['count','totalElapsedMs','maxElapsedMs','slowCount','first','ttsFrames','ttsSamples','serverFrames','serverSamples','elapsedMs', 'status', 'frames', 'samples', 'receivedSamples', 'characters', 'checkedAtMs', 'deadlineMs', 'freshUntilMs', 'sourceValidUntilMs', 'remainingMs', 'lagMs', 'activeTurn', 'terminalSeen', 'emitted', 'sequence', 'sampleRateHz', 'channels', 'providerRequest']);
export const auditRoot = '/srv/lifestream/private-diagnostics';
const MAX_BYTES = 32 * 1024 * 1024, MAX_EVENTS = 12000, MAX_REQUESTS = 160, MAX_TURNS = 4, RETENTION_MS = 24 * 3600 * 1000;
export function redactText(value) { return String(value).slice(0, 32768).replace(/\b(?:https?:\/\/|wss?:\/\/)[^\s]+/gi, '[redacted-url]').replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, '[redacted-auth]').replace(/\b(?:password|passwd|token|secret|api[_ -]?key|cookie|authorization)\b\s*[:=]\s*[^\s,;]+/gi, '[redacted-secret]').replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, '[redacted-key]'); }
function privateFile(path) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0 || s.size > 2048)
    throw Error('unsafe_control'); return s; }
function safeRead(path) { privateFile(path); const f = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try {
    return JSON.parse(readFileSync(f, 'utf8'));
}
finally {
    closeSync(f);
} }
function privateDir(path) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) !== 0)
    throw Error('unsafe_directory'); }
export function createAudit({ root = auditRoot, now = Date.now, monotonic = () => performance.now(), timers = true } = {}) {
    root = resolve(root);
    const als = new AsyncLocalStorage(), sockets = new WeakMap(), prepared = new WeakMap(), traces = new Map();
    let session = null, denied = new Set(), fd, bytes = 0, events = 0, requests = 0, turns = 0, loopLast = now(), timer, cleanupTimer, pinnedScope, monotonicEnd = 0;
    const enrolledSockets = [];
    // Reserve 4,000 existing events / 4 MiB for lifecycle and first/final PCM evidence.
    const criticalStages=new Set(['session_start','audit_decision','request_received','request_finished','request_closed','turn_start','asr_begin','asr_end','prepare_begin','prepare_end','memory_begin','memory_end','world_begin','world_end','admission','generation_begin','generation_end','generation_error','tts_begin','tts_pre_audio','tts_terminal','tts_error','socket_terminal','socket_stop','socket_closed','playback_settlement','lease_acquired','lease_released','turn_finally','currentness_failed','currentness_reported','provider_request','provider_response','provider_error','database_slow','pcm_summary']);
    const phaseByStage={turn_start:'asr',asr_begin:'asr',prepare_begin:'preparation',memory_begin:'memory',world_begin:'world',admission:'generation',generation_begin:'generation',tts_begin:'synthesis',socket_terminal:'settlement',turn_finally:'settlement'};
    const dbBoundaries=new Set(['asr_end','prepare_begin','prepare_end','memory_begin','memory_end','world_begin','world_end','admission','generation_end','generation_error','tts_begin','tts_terminal','tts_error','socket_terminal','socket_stop','turn_finally','lease_released','request_finished','request_closed']);
    const dbBuckets=new Map();let lastDbFlush=now(),slowRecords=0,droppedDiagnostics=0;

    const control = join(root, 'control.json');
    function write(row){const critical=criticalStages.has(row.stage)||(['tts_pcm','server_pcm'].includes(row.stage)&&row.first===1);
        if(critical&&droppedDiagnostics)row={...row,droppedDiagnosticEvents:droppedDiagnostics};
        const data=Buffer.from(JSON.stringify(row)+'\n');
        if(!critical&&(events>=MAX_EVENTS-4000||bytes+data.length>MAX_BYTES-4*1024*1024)){droppedDiagnostics++;return true;}
        if(bytes+data.length>MAX_BYTES||events>=MAX_EVENTS)return false;
        writeSync(fd,data);bytes+=data.length;events++;return true;
    }
    function flushDatabase(context){const pending=[];for(const [key,bucket]of dbBuckets){if(!context||bucket.context===context){dbBuckets.delete(key);pending.push(bucket);}}
        for(const bucket of pending)emit('database_summary',{operation:bucket.operation,phase:bucket.phase,count:bucket.count,totalElapsedMs:bucket.totalElapsedMs,maxElapsedMs:bucket.maxElapsedMs,slowCount:bucket.slowCount},bucket.context);
    }
    function recordDatabase(fields,context){
        // Primitive counters only: no filesystem, SQL or arbitrary payloads per ordinary operation.
        if(!context||!session||context.session!==session.id||now()>=session.expiresAtMs||monotonic()>=monotonicEnd||(context.consent&&monotonic()>=context.consent.until))return;
        const operation=fields.operation,elapsed=fields.elapsedMs;if(!['prepare','get','all','run','exec'].includes(operation)||typeof elapsed!=='number'||!Number.isFinite(elapsed)||elapsed<0)return;
        const phase=context.databasePhase??'unclassified',key=String(context.turn?'t'+context.turn:'r'+(context.request??0))+'|'+phase+'|'+operation;
        if(!dbBuckets.has(key)&&dbBuckets.size>=512)flushDatabase();
        let bucket=dbBuckets.get(key);if(!bucket){bucket={context,operation,phase,count:0,totalElapsedMs:0,maxElapsedMs:0,slowCount:0};dbBuckets.set(key,bucket);}
        bucket.count++;bucket.totalElapsedMs+=elapsed;bucket.maxElapsedMs=Math.max(bucket.maxElapsedMs,elapsed);if(elapsed>=25){bucket.slowCount++;if(slowRecords<16){slowRecords++;emit('database_slow',{operation,phase,elapsedMs:elapsed},context);}}
    }
    function state(active, reason, id, expiresAtMs) { try {
        privateDir(root);
        const f = openSync(join(root, 'state.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try {
            writeSync(f, JSON.stringify({ version: 1, active, reason, session: id, expiresAtMs, atMs: now() }) + '\n');
        }
        finally {
            closeSync(f);
        }
    }
    catch { } }
    function stop(reason) { if (session) {
        const retired = session;
        session = null;
        state(false, reason, retired.id, retired.expiresAtMs);
        pinnedScope = undefined;
        denied.add(retired.id);
        if (denied.size > 64)
            denied.delete(denied.values().next().value);
        for (const entry of enrolledSockets.splice(0)) {
            try {
                const socket = entry.socket.deref();
                if (socket?.readyState === 1)
                    socket.send(JSON.stringify({ type: 'diagnosticsStopped', diagnostics: { version: 1, session: retired.id, attempt: entry.attempt, reason } }));
            }
            catch { }
        }
    } if (fd !== undefined) {
        try {
            closeSync(fd);
        }
        catch { }
        fd = undefined;
    } traces.clear();dbBuckets.clear(); }
    function refresh() { try {
        privateDir(root);
        const c = safeRead(control);
        if (c.version !== 1 || !UUID.test(c.id) || !Number.isSafeInteger(c.startedAtMs) || !Number.isSafeInteger(c.expiresAtMs) || c.expiresAtMs <= now() || c.startedAtMs > now() + 1000 || c.expiresAtMs - c.startedAtMs > 300000 || c.expiresAtMs <= c.startedAtMs || !['metadata', 'content'].includes(c.mode) || denied.has(c.id)) {
            stop('expired');
            return null;
        }
        if (session?.id === c.id) {
            if (enrolledSockets.some(e => monotonic() >= e.consent.until)) {
                stop('client_inactive');
                return null;
            }
            if (monotonic() >= monotonicEnd) {
                stop('expired');
                return null;
            }
            if (c.expiresAtMs !== session.expiresAtMs || c.mode !== session.mode) {
                stop('capture_error');
                return null;
            }
            return session;
        }
        stop('operator_off');
        if (!cleanup(1))
            return null;
        const dir = join(root, c.id);
        mkdirSync(dir, { mode: 0o700 });
        privateDir(dir);
        fd = openSync(join(dir, 'capture.jsonl'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        session = c;
        monotonicEnd = monotonic() + Math.min(300000, c.expiresAtMs - now());
        bytes = events = requests = turns = 0;slowRecords=droppedDiagnostics=0;dbBuckets.clear();lastDbFlush=now();
        state(true, 'armed', c.id, c.expiresAtMs);
        write({ stage: 'session_start', atMs: now(), session: c.id, expiresAtMs: c.expiresAtMs, contentEnabled: c.mode === 'content' });
        return session;
    }
    catch {
        stop('operator_off');
        return null;
    } }
    // Assessment results carry private scope only in memory. Only a closed reason is recorded.
    function assessment(read) {try {const value=typeof read==='function'?read():read;
        if(value?.scope?.key)return value;
        if(value?.key)return {scope:value,reason:'scope_ready'};
        return {reason:value?.reason??'scope_check_unavailable'};
    }catch{return {reason:'scope_check_unavailable'};}}
    function discoveryKey(scope){return scope?.discoveryKey??scope?.key;}
    function decision(phase,reason,context){const current=refresh();if(!current)return;
        emit('audit_decision',{phase,reason},context??{session:current.id,attempt:'00000000-0000-4000-8000-000000000000'});
    }
    function status(scopeRead) {const c=refresh();if(!c)return undefined;
        const result=assessment(scopeRead),scope=result.scope;
        if(!scope?.key){decision('discovery',result.reason);return undefined;}
        if(pinnedScope&&discoveryKey(pinnedScope)!==discoveryKey(scope)){decision('discovery','foreign_pinned_scope');return undefined;}
        decision('discovery','discovery_eligible');
        return {version:1,active:true,session:c.id,expiresAt:new Date(c.expiresAtMs).toISOString(),contentEnabled:c.mode==='content'};
    }
    function matches(ctx) { return ctx && refresh()?.id === ctx.session && (!ctx.consent || monotonic() < ctx.consent.until); }
    function emit(stage, fields = {}, ctx = als.getStore()) {
        if(stage==='database'){try{recordDatabase(fields,ctx);}catch{}return;}
        try {
        if (!stages.has(stage) || !matches(ctx))
            return;
        if(dbBoundaries.has(stage))flushDatabase(ctx);
        if(phaseByStage[stage])ctx.databasePhase=phaseByStage[stage];
        if(ctx.turn&&['tts_pcm','server_pcm'].includes(stage)){
            const counts=ctx.pcmCounts??={ttsFrames:0,ttsSamples:0,serverFrames:0,serverSamples:0};const prefix=stage==='tts_pcm'?'tts':'server';counts[prefix+'Frames']++;if(typeof fields.samples==='number'&&Number.isFinite(fields.samples))counts[prefix+'Samples']+=fields.samples;fields={...fields,first:counts[prefix+'Frames']===1?1:0};
        }
        if(ctx.turn&&['socket_terminal','turn_finally'].includes(stage)&&ctx.pcmCounts)emit('pcm_summary',ctx.pcmCounts,ctx);

        if (stage === 'admission' && [0, 1].includes(fields.activeTurn))
            ctx.activeTurn = fields.activeTurn;
        const row = { stage, atMs: now(), session: ctx.session, attempt: ctx.attempt, ...(ctx.request ? { request: ctx.request } : {}), ...(ctx.turn ? { turn: ctx.turn } : {}) };
        for (const [k, v] of Object.entries(fields)) {
            if (nums.has(k) && typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER)
                row[k] = v;
            else if (['reason', 'outcome', 'predicate', 'result', 'modality', 'expirySource', 'phase', 'route', 'method', 'provider', 'operation'].includes(k) && enums.has(v))
                row[k] = v;
        }
        if (!write(row))
            stop('capture_limit');
    }
    catch {
        stop('capture_error');
    } }
    // Correlation labels never pin a scope or authorize a turn.
    function labels(request,phase) {const c=refresh(),h=request?.headers;if(!c)return undefined;
        if(!h?.['x-lfs-audit-session']||!h?.['x-lfs-audit-attempt']){decision(phase,'labels_missing');return undefined;}
        if(h['x-lfs-audit-session']!==c.id){decision(phase,'session_mismatch');return undefined;}
        if(typeof h['x-lfs-audit-attempt']!=='string'||!UUID.test(h['x-lfs-audit-attempt'])){decision(phase,'labels_malformed');return undefined;}
        return {session:c.id,attempt:h['x-lfs-audit-attempt'],contentOptIn:h['x-lfs-audit-content']==='speech-v1'};
    }
    function compatible(scope){return !pinnedScope||(scope.key===pinnedScope.key&&scope.assistantId===pinnedScope.assistantId);}
    function request(req,res,work,scopeRead) {let ctx;try{
        const route=routes.get(String(req.url??'').split('?')[0]);
        if(route&&refresh()&&req?.headers?.['x-lfs-audit-session']){
            const l=labels(req,'request_enrollment'),result=l?assessment(scopeRead):undefined;
            if(l&&!result?.scope?.assistantId)decision('request_enrollment',result?.reason??'selection_missing',l);
            else if(l&&!compatible(result.scope))decision('request_enrollment','foreign_pinned_scope',l);
            else if(l){if(requests>=MAX_REQUESTS)stop('capture_limit');
                if(session){ctx={...l,request:++requests};res.setHeader('x-lfs-audit-request',String(ctx.request));res.setHeader('x-lfs-audit-session',ctx.session);
                    const began=now();emit('request_received',{route,method:req.method},ctx);
                    res.once('finish',()=>emit('request_finished',{route,status:res.statusCode,elapsedMs:now()-began},ctx));
                    res.once('close',()=>emit('request_closed',{route,status:res.statusCode,elapsedMs:now()-began},ctx));}}
        }
    }catch{}return als.run(ctx,work);}
    function bindSocket(socket,req,scopeRead,discoveryRead=scopeRead){try{
        const l=labels(req,'socket_enrollment');if(!l)return;
        const phone=assessment(discoveryRead),strict=assessment(scopeRead);
        if(!phone.scope?.key){decision('socket_enrollment',phone.reason,l);return;}
        if(!strict.scope?.assistantId&&strict.reason!=='selection_missing'){decision('socket_enrollment',strict.reason,l);return;}
        if(pinnedScope&&discoveryKey(pinnedScope)!==discoveryKey(phone.scope)){decision('socket_enrollment','foreign_pinned_scope',l);return;}
        if(enrolledSockets.length>=MAX_TURNS){decision('socket_enrollment','capture_limit',l);return;}
        const consent={until:monotonic()+3000,sequence:0,nextTurn:false};
        sockets.set(socket,{...l,scopeRead,discoveryRead,phoneKey:discoveryKey(phone.scope),consent});
        enrolledSockets.push({socket:new WeakRef(socket),attempt:l.attempt,consent});
        decision('socket_enrollment',strict.scope?.assistantId?'scope_ready':'socket_provisional',l);
    }catch{decision('socket_enrollment','scope_check_unavailable');}}
    function runTurn(socket,input,work){const prior=sockets.get(socket);const l=prior?{session:prior.session,attempt:prior.attempt,contentOptIn:prior.contentOptIn,scopeRead:prior.scopeRead,discoveryRead:prior.discoveryRead,phoneKey:prior.phoneKey,consent:prior.consent}:undefined;if(l)sockets.set(socket,l);let c;
        if(!matches(l)){decision('turn_enrollment',l?'consent_missing':'labels_missing');return als.run(undefined,work);}
        try{
        const consent=l.consent?.nextTurn===true;l.consent.nextTurn=false;
        const phone=assessment(l.discoveryRead),strict=assessment(l.scopeRead),scope=strict.scope;
        let refusal;
        if(!phone.scope?.key)refusal=phone.reason;
        else if(discoveryKey(phone.scope)!==l.phoneKey)refusal='foreign_pinned_scope';
        else if(!scope?.assistantId)refusal=strict.reason??'selection_missing';
        else if(discoveryKey(scope)!==l.phoneKey||!compatible(scope))refusal='foreign_pinned_scope';
        else if(input?.assistantId!==scope.assistantId)refusal='assistant_mismatch';
        else if(input?.voiceSettings!==undefined)refusal='preview_excluded';
        else if(!consent)refusal='consent_missing';
        else if(turns>=MAX_TURNS){stop('capture_limit');refusal='capture_limit';}
        if(refusal)decision('turn_enrollment',refusal,l);
        else if(matches(l)){
            // The first pin happens only here, after current real scope, Assistant and consent.
            pinnedScope={...scope};const admittedScopeKey=scope.key,admittedAssistantId=scope.assistantId;
            c={session:l.session,attempt:l.attempt,contentOptIn:l.contentOptIn,consent:l.consent,turn:++turns,admitted:true,revalidate:()=>{const latest=assessment(l.scopeRead);if(!latest.scope?.assistantId)return latest.reason??'selection_missing';if(latest.scope.key!==admittedScopeKey||latest.scope.assistantId!==admittedAssistantId)return 'foreign_pinned_scope';return undefined;}};
            sockets.set(socket,{...l,...c});decision('turn_enrollment','turn_enrolled',c);
        }
    }catch{decision('turn_enrollment','scope_check_unavailable',l);}
        return als.run(c,()=>{emit('turn_start',{modality:'voice'},c);return work();});
    }
    function controlMessage(socket, message) { if (!['diagnosticsStop', 'diagnosticsConsent'].includes(message?.type))
        return false; try {
        const c = sockets.get(socket), d = message.diagnostics;
        if (!matches(c) || !d || d.version !== 1 || d.session !== c.session || d.attempt !== c.attempt)
            return true;
        if (message.type === 'diagnosticsStop') {
            stop('client_off');
            return true;
        }
        if (!Number.isSafeInteger(d.sequence) || d.sequence <= c.consent.sequence || d.sequence > 1000 || !['heartbeat', 'turn'].includes(d.kind))
            return true;
        c.consent.sequence = d.sequence;
        c.consent.until = monotonic() + 3000;
        if (d.kind === 'turn')
            c.consent.nextTurn = true;
    }
    catch { } return true; }
    function socketClosed(socket) { const c = sockets.get(socket); if (matches(c))
        stop('client_off'); sockets.delete(socket); }
    function bindTrace(id) { const c = als.getStore(); if (matches(c) && typeof id === 'string' && traces.size < MAX_TURNS)
        traces.set(id, c); }
    function bindPrepared(input) { const c = als.getStore(); if (input && matches(c))
        prepared.set(input, c); }
    function currentness(input, fields) {const c=prepared.get(input);emit('currentness_reported',fields,c);}

    function contentCurrent(context){try{const refusal=context.revalidate?.();if(refusal){if(context.lastContentRefusal!==refusal){context.lastContentRefusal=refusal;decision('turn_enrollment',refusal,context);}return false;}return matches(context);}catch{decision('turn_enrollment','scope_check_unavailable',context);return false;}}
    function suppressContent(){const c=als.getStore();if(c)c.contentOptIn=false;}
    function suppressSocketContent(socket){const c=sockets.get(socket);if(c)c.contentOptIn=false;}
    function content(stage, text, role) { const c = als.getStore(); try {
        if (!matches(c) || session.mode !== 'content' || !c.contentOptIn || !c.admitted || !c.turn || !contentCurrent(c) || !['speech_text'].includes(stage))
            return;
        const row = { stage, atMs: now(), session: c.session, attempt: c.attempt, turn: c.turn, ...(['input', 'output'].includes(role) ? { role } : {}), text: redactText(text) };
        if (!write(row))
            stop('capture_limit');
    }
    catch {
        stop('capture_error');
    } }
    function pcm(stage, frame) { const c = als.getStore(); try {
        if (!matches(c) || session.mode !== 'content' || !c.contentOptIn || !c.admitted || !contentCurrent(c) || !['input_audio', 'output_audio'].includes(stage) || !c.turn)
            return;
        if (!frame || !Number.isSafeInteger(frame.sampleCount) || frame.sampleCount < 1 || frame.sampleCount > 48000 || frame.format?.encoding !== 'pcm_s16le' || frame.format?.channels !== 1 || ![16000, 24000, 48000].includes(frame.format?.sampleRateHz))
            return;
        const b64 = frame.dataBase64;
        if (typeof b64 !== 'string' || b64.length > 128000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || Buffer.from(b64, 'base64').length !== frame.sampleCount * 2)
            return;
        if (!write({ stage, atMs: now(), session: c.session, attempt: c.attempt, turn: c.turn, sampleRateHz: frame.format.sampleRateHz, samples: frame.sampleCount, pcmBase64: b64 }))
            stop('capture_limit');
    }
    catch {
        stop('capture_error');
    } }
    function socketMessage(socket, message) { try {
        const c = traces.get(message?.interactionTraceId ?? message?.event?.interactionTraceId) ?? sockets.get(socket);
        if (!matches(c) || !c.turn)
            return message;
        const p = message.type === 'response' ? message.event?.payload : message;
        if (message.type === 'turnStarted')
            return { ...message, diagnostics: { version: 1, session: c.session, attempt: c.attempt, turn: c.turn } };
        return message;
    }
    catch {
        return message;
    } }
    function socketSent(socket, message) { try {
        const c = traces.get(message?.interactionTraceId ?? message?.event?.interactionTraceId) ?? sockets.get(socket);
        if (!matches(c) || !c.turn)
            return;
        const p = message.type === 'response' ? message.event?.payload : message;
        if (p?.type === 'terminal')
            emit('socket_terminal', { outcome: p.state, reason: p.error?.code, emitted: 1 }, c);
        if (message.type === 'stopPlayback')
            emit('socket_stop', { reason: message.reason, emitted: 1 }, c);
        if (message.type === 'audio')
            emit('server_pcm', { samples: message.chunk?.frame?.sampleCount, emitted: 1 }, c);
    }
    catch { } }
    function forTrace(id, stage, fields) { emit(stage, fields, traces.get(id)); }
    function cleanup(reserve = 0) { try {
        privateDir(root);
        const retained = [];
        for (const name of readdirSync(root)) {
            if (!UUID.test(name) || name === session?.id)
                continue;
            const path = join(root, name), s = lstatSync(path);
            if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid())
                continue;
            if (now() - s.mtimeMs >= RETENTION_MS)
                rmSync(path, { recursive: true, force: true });
            else
                retained.push({ path, time: s.mtimeMs });
        }
        retained.sort((a, b) => b.time - a.time);
        for (const item of retained.slice(Math.max(0, 8 - (session ? 1 : 0) - reserve)))
            rmSync(item.path, { recursive: true, force: true });
        return true;
    }
    catch {
        return false;
    } }
    function start() { if (timer)
        return; timer = setInterval(() => { const c = refresh(), t = now(); if(c&&t-lastDbFlush>=1000){lastDbFlush=t;flushDatabase();}if (c)
        emit('event_loop', { lagMs: Math.max(0, t - loopLast - 250) }, { session: c.id, attempt: '00000000-0000-4000-8000-000000000000' }); loopLast = t; }, 250); timer.unref(); cleanupTimer = setInterval(cleanup, 60000); cleanupTimer.unref(); cleanup(); }
    if (timers)
        start();
    return { suppressContent, suppressSocketContent, start, status, request, bindSocket, runTurn, controlMessage, socketClosed, socketMessage, socketSent, bindTrace, bindPrepared, currentness, event: emit, forTrace, content, pcm, context: () => als.getStore(), runContext: (c, f) => als.run(c, f), cleanup, close: () => { if (timer)
            clearInterval(timer); if (cleanupTimer)
            clearInterval(cleanupTimer); stop('operator_off'); } };
}
export const audit = createAudit({ timers: false });
// Explicit construction only: neither diagnostic channel URLs nor headers/errors enter storage.
const providerRequests = new WeakMap();
let providerOrdinal = 0;
for (const [name, stage] of [['undici:request:create', 'provider_request'], ['undici:request:headers', 'provider_response'], ['undici:request:error', 'provider_error']])
    channel(name).subscribe(message => { try {
        let r = providerRequests.get(message.request);
        if (stage === 'provider_request') {
            const c = audit.context();
            const origin = String(message.request?.origin ?? '');
            const provider = origin === 'http://127.0.0.1:8787' ? 'speech' : origin === 'http://192.168.2.15:30000' ? 'inference' : undefined;
            if (c && provider) {
                r = { context: c, provider, ordinal: ++providerOrdinal };
                providerRequests.set(message.request, r);
            }
        }
        if (r)
            audit.event(stage, { provider: r.provider, providerRequest: r.ordinal, status: message.response?.statusCode, ...(stage === 'provider_error' ? { reason: 'transport_error' } : {}) }, r.context);
    }
    catch { } });
// Measure existing SQLite calls without copying SQL, parameter values, returned rows or errors.
const originalPrepare = DatabaseSync.prototype.prepare, originalExec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.prepare = function (...args) { if (!audit.context())
    return Reflect.apply(originalPrepare, this, args); const started = performance.now(); let statement; try {
    statement = Reflect.apply(originalPrepare, this, args);
    return new Proxy(statement, { get(target, key) { const value = Reflect.get(target, key, target); if (typeof value !== 'function')
            return value; if (!['run', 'get', 'all'].includes(key))
            return value.bind(target); return (...values) => { const began = performance.now(); try {
            return Reflect.apply(value, target, values);
        }
        finally {
            audit.event('database', { operation: key, elapsedMs: performance.now() - began });
        } }; } });
}
finally {
    audit.event('database', { operation: 'prepare', elapsedMs: performance.now() - started });
} };
DatabaseSync.prototype.exec = function (...args) { if (!audit.context())
    return Reflect.apply(originalExec, this, args); const began = performance.now(); try {
    return Reflect.apply(originalExec, this, args);
}
finally {
    audit.event('database', { operation: 'exec', elapsedMs: performance.now() - began });
} };
