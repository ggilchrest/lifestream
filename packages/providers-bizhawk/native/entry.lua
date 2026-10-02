-- BizHawk 2.11.1 / bundled Lua 5.4 and Newtonsoft.Json. No LuaSocket, memory
-- writes, game cheats, savestates, rewind, arbitrary commands or outbound HTTP.
local api
local peer
local closeChannel
local function main()
  client.pause()
  local clr=luanet or require('luanet');clr.load_assembly('System');clr.load_assembly('Newtonsoft.Json')
  local JSON=clr.import_type('Newtonsoft.Json.JsonConvert')
  local Reader=clr.import_type('Newtonsoft.Json.JsonTextReader')
  local StringReader=clr.import_type('System.IO.StringReader')
  local TokenType=clr.import_type('Newtonsoft.Json.JsonToken')
  local DateParse=clr.import_type('Newtonsoft.Json.DateParseHandling')
  local Encoding=clr.import_type('System.Text.Encoding')
  local BitConverter=clr.import_type('System.BitConverter')
  local HMAC=clr.import_type('System.Security.Cryptography.HMACSHA256')
  local SHA=clr.import_type('System.Security.Cryptography.SHA256')
  local Convert=clr.import_type('System.Convert')
  local Array=clr.import_type('System.Array')
  local Guid=clr.import_type('System.Guid')
  local DateTime=clr.import_type('System.DateTime')
  local Stopwatch=clr.import_type('System.Diagnostics.Stopwatch')
  local File=clr.import_type('System.IO.File')
  local FileInfo=clr.import_type('System.IO.FileInfo')
  local Path=clr.import_type('System.IO.Path')
  local TcpClient=clr.import_type('System.Net.Sockets.TcpClient')
  local Type=clr.import_type('System.Type')
  local UTF8=clr.import_type('System.Text.UTF8Encoding')
  local json={null={}};local arrayTag={}
  local tokenNames={};for _,name in ipairs({'Null','String','Integer','Float','Boolean','StartArray','EndArray','StartObject','EndObject','PropertyName'})do tokenNames[tostring(TokenType[name])]=name end
  function json.array(v)return setmetatable(v,arrayTag)end
  function json.decode(raw)
    assert(type(raw)=='string'and #raw>0 and #raw<=131072,'Native JSON bounds exceeded')
    local reader=Reader(StringReader(raw));reader.MaxDepth=32;reader.DateParseHandling=DateParse.None
    local function kind()return tokenNames[tostring(reader.TokenType)]end
    local function value(depth)
      assert(depth<=32,'Native JSON depth exceeded');local k=kind()
      if k=='Null'then return json.null elseif k=='String'then return tostring(reader.Value)
      elseif k=='Integer'or k=='Float'then local n=assert(tonumber(reader.Value));assert(n==n and math.abs(n)<1e19);return n
      elseif k=='Boolean'then return tostring(reader.Value):lower()=='true'
      elseif k=='StartArray'then local out=json.array({});while reader:Read()and kind()~='EndArray'do out[#out+1]=value(depth+1)end;assert(kind()=='EndArray');return out
      elseif k=='StartObject'then local out,seen={},{};while reader:Read()and kind()~='EndObject'do assert(kind()=='PropertyName');local key=tostring(reader.Value);assert(not seen[key],'Native duplicate JSON property');seen[key]=true;assert(reader:Read());out[key]=value(depth+1)end;assert(kind()=='EndObject');return out end
      error('Native JSON type unavailable')
    end
    local ok,result=pcall(function()assert(reader:Read());local v=value(0);assert(not reader:Read(),'Native trailing JSON');return v end);reader:Close();assert(ok,'Native JSON unavailable');return result
  end
  local function encode(value,depth)
    assert(depth<=32,'Native JSON depth exceeded')
    if value==json.null then return 'null' end
    local kind=type(value)
    if kind=='string'then return JSON.SerializeObject(value)elseif kind=='boolean'then return value and 'true'or 'false'
    elseif kind=='number'then assert(value==value and math.abs(value)<1e19);return tostring(value)
    elseif kind=='table'then
      local parts={};if getmetatable(value)==arrayTag then for _,v in ipairs(value)do parts[#parts+1]=encode(v,depth+1)end;return '['..table.concat(parts,',')..']'end
      local keys={};for k in pairs(value)do assert(type(k)=='string');keys[#keys+1]=k end;table.sort(keys)
      for _,k in ipairs(keys)do parts[#parts+1]=JSON.SerializeObject(k)..':'..encode(value[k],depth+1)end
      return '{'..table.concat(parts,',')..'}'
    end
    error('Native JSON value unavailable')
  end
  function json.encode(v)return encode(v,0)end
  local config=json.decode(assert(os.getenv('LIFESTREAM_BIZHAWK_OPTIONS'),'Native options required'))
  assert(config.protocol=='lifestream-game-control/1'and config.emulatorVersion=='2.11.1'and type(config.frameDirectory)=='string'and config.sessionDurationMs>=1 and config.sessionDurationMs<=600000 and config.authenticationTimeoutMs>=1 and config.authenticationTimeoutMs<=10000 and config.bounds.maxActionFrames>=1 and config.bounds.maxActionFrames<=120 and config.bounds.maxActionWallMs>=1 and config.bounds.maxActionWallMs<=5000 and config.bounds.renderedSpeedFactor==1 and config.bounds.fastForwardEnabled==false and config.bounds.rewindEnabled==false and config.bounds.planningClockPolicy=='continuesNormally','Native configuration unavailable')
  local key=Convert.FromBase64String((assert(os.getenv('LIFESTREAM_BIZHAWK_PAIRING_SECRET'),'Explicit pairing required')))
  assert(type(key)=='string'and #key>=32 and #key<=128,'Native pairing unavailable')
  local mac=HMAC(key);key=nil -- NLua marshals byte[] as binary Lua strings; dispose the HMAC after pairing.
  local function hex(bytes)return BitConverter.ToString(bytes):gsub('-',''):lower()end
  local crypto={uuid=function()return Guid.NewGuid():ToString()end,hmac=function(text)return hex(mac:ComputeHash(Encoding.UTF8:GetBytes(text)))end}
  function crypto.equal(a,b)
    if type(a)~='string'or type(b)~='string'or #a~=64 or #b~=64 or not a:match('^[a-f0-9]+$')or not b:match('^[a-f0-9]+$')then return false end
    local difference=0;for i=1,64 do difference=difference | (a:byte(i) ~ b:byte(i))end;return difference==0
  end
  local watch=Stopwatch.StartNew()
  local clock={ms=function()return watch.Elapsed.TotalMilliseconds end,utc=function()return DateTime.UtcNow:ToString('o')end,before=function(time)return DateTime.Parse(time):ToUniversalTime().Ticks>DateTime.UtcNow.Ticks end,issued=function(time)return DateTime.Parse(time):ToUniversalTime().Ticks<=DateTime.UtcNow.Ticks end}
  api={version=function()return client.getversion()end,system=function()return emu.getsystemid()end,romHash=function()return gameinfo.getromhash()end,frame=function()return emu.framecount()end,set=function(v)joypad.set(v,1)end,immediate=function()return joypad.getimmediate(1)end,pause=function()client.pause()end,paused=function()return client.ispaused()end,resume=function()client.unpause()end,speedOne=function()client.speedmode(100)end,advance=function()emu.frameadvance()end,yield=function()emu.yield()end}
  -- The bundled comm receive loop loses partial headers on timeout and does
  -- not check header EOF. Use ordinary .NET sockets with bounded incremental
  -- framing instead; no LuaSocket, unbounded allocation or reconnect.
  assert(type(config.port)=='number'and config.port>=1024 and config.port<=65535 and config.port%1==0,'Native loopback port required')
  local clientSocket=TcpClient();closeChannel=function()clientSocket:Close()end
  assert(clientSocket:ConnectAsync('127.0.0.1',config.port):Wait(config.authenticationTimeoutMs),'Native connect deadline')
  local socket=clientSocket.Client;socket.SendTimeout=1000
  local stream=clientSocket:GetStream();stream.ReadTimeout=1;stream.WriteTimeout=1000
  -- Box the exact CLR parameter types; the bundled NLua enum method binder
  -- does not accept a Lua number or imported enum directly for Socket.Poll.
  local pollArguments=Array.CreateInstance(Type.GetType('System.Object'),2)
  local pollZero=Array.CreateInstance(Type.GetType('System.Int32'),1)
  local pollMode=Array.CreateInstance(socket:GetType().Assembly:GetType('System.Net.Sockets.SelectMode'),1)
  Array.Copy(pollZero,pollArguments,1);Array.Copy(pollMode,0,pollArguments,1,1)
  local pollMethod=socket:GetType():GetMethod('Poll')
  local header,length,payload='',nil,{};local received=0;local messages={};local channel={}
  function channel.connected()
    return not(pollMethod:Invoke(socket,pollArguments)and socket.Available==0)
  end
  function channel.send(raw)
    assert(type(raw)=='string'and #raw>=1 and #raw<=131072 and utf8.len(raw),'Native send bounds')
    local framed=tostring(#raw)..' '..raw
    stream:Write(Encoding.UTF8:GetBytes(framed),0,#framed)
  end
  function channel.receive(timeout)
    local untilMs=clock.ms()+(timeout or 1)
    repeat
      if #messages>0 then return table.remove(messages,1)end
      assert(channel.connected(),'Native socket disconnected')
      local count=math.min(4096,socket.Available)
      if count>0 then
        for _=1,count do
          local byte=stream:ReadByte();assert(byte>=0,'Native socket disconnected')
          if length then
            received=received+1;payload[received]=string.char(byte)
            if received==length then
              local raw=table.concat(payload);assert(utf8.len(raw),'Native UTF-8 unavailable');assert(#messages<8,'Native receive capacity');messages[#messages+1]=raw;length=nil;payload={};received=0
            end
          elseif byte==32 then
            local size=tonumber(header);assert(header:match('^[1-9][0-9]*$')and size<=131072,'Native frame bounds');length=size;header=''
          else assert(byte>=48 and byte<=57 and #header<6,'Native frame prefix');header=header..string.char(byte)end
        end
      end
    until clock.ms()>=untilMs
    if #messages>0 then return table.remove(messages,1)end
    return nil
  end
  local files,bytesHeld={},0
  local store={}
  function store.capture(frame,captured)
    local now=clock.ms()
    for id,entry in pairs(files)do if now>=entry.expires then if File.Exists(entry.path)then File.Delete(entry.path)end;bytesHeld=bytesHeld-entry.bytes;files[id]=nil end end
    local count=0;for _ in pairs(files)do count=count+1 end;assert(count<config.maximumCustodyFrames,'Native frame capacity exceeded')
    local id=crypto.uuid();local path=Path.Combine(config.frameDirectory,id..'.png');assert(not File.Exists(path),'Native frame collision')
    client.screenshot(path)
    local size=FileInfo(path).Length
    if size<57 or size>config.bounds.maxScreenshotBytes or bytesHeld+size>config.bounds.screenshotQueueByteBudget then File.Delete(path);error('Native frame bounds exceeded')end
    local bytes=File.ReadAllBytes(path)
    assert(type(bytes)=='string'and bytes:byte(1)==137 and bytes:sub(2,4)=='PNG','Native PNG unavailable')
    local width=bytes:byte(17)*16777216+bytes:byte(18)*65536+bytes:byte(19)*256+bytes:byte(20)
    local height=bytes:byte(21)*16777216+bytes:byte(22)*65536+bytes:byte(23)*256+bytes:byte(24)
    if math.max(width,height)>config.bounds.maxScreenshotLongEdge then File.Delete(path);error('Native frame dimensions exceeded')end
    local sha=SHA.Create();local digest=hex(sha:ComputeHash(bytes));sha:Dispose();bytes=nil
    files[id]={path=path,bytes=size,expires=now+config.frameTtlMs};bytesHeld=bytesHeld+size
    return {screenshotId=id,mediaRef=id,sha256=digest,byteLength=size,mediaType='image/png',width=width,height=height,capturedAt=captured,frameNumber=frame,expiresAt=DateTime.Parse(captured):AddMilliseconds(config.frameTtlMs):ToString('o')}
  end
  local source=debug.getinfo(1,'S').source:sub(2);local directory=source:match('^(.*[/\\])')or ''
  local factory=assert(loadfile(directory..'peer.lua'))()
  peer=factory(config,{json=json,api=api,clock=clock,crypto=crypto,channel=channel,store=store})
  config.executionMode='normal'
  api.pause();peer.authenticate();mac:Dispose();os.setlocale('C','numeric')
  while true do local raw=channel.receive();if raw then peer.handle(raw)end;if not peer.idle()then break end end
  peer.halt()
end
local ok=pcall(main)
if peer then pcall(peer.halt)end
if closeChannel then pcall(closeChannel)end
client.pause()
if not ok then console.log('Native game bridge stopped; configuration, pairing or operation unavailable. No automatic retry.')end
-- Probe exits only an empty emulator. A real game remains paused and watchable.
if os.getenv('LIFESTREAM_BIZHAWK_ROM_FREE_PROBE')=='1'and emu.getsystemid()=='NULL'then client.exit()end
