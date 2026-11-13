import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, stat, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { RoutineWebhookClient, CredentialStore, initializeRoutine, withProvisioning, verifyRoutineCallback, RoutineReplyStream, RoutineProvisioner, routineProfile } from '../dist/index.js';

const secret = 'whsec_fictional_test_secret';
const accepted = { accepted: true, teamId: 'team1', groupChatId: 'chat1', messageId: 'message1' };
const reply = (id='event1', cursor='cursor1') => ({ type: 'routine.reply', eventId: id, routineId: 'routine1', topicKey: 'order:1042', content: 'Inventory synchronized.', createdAt: '2026-11-13T00:00:00.000Z', cursor });
async function fixture(t, handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    try { await handler(req, res, raw); } catch (error) { res.writeHead(500); res.end(); throw error; }
  });
  const sockets = new Set(); server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for(const socket of sockets) socket.destroy(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return { server, serverUrl: `http://127.0.0.1:${server.address().port}` };
}
const json = (res, value, code=200) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

test('agent-connect provisioning, narrow token lifetime and atomic private profile', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'routine-store-')); t.after(() => rm(dir, {recursive:true,force:true}));
  let origin, observed;
  const {serverUrl} = await fixture(t, (req,res,raw) => {
    if (req.url === '/api/agent-connect/start') {
      assert.deepEqual(JSON.parse(raw), {clientLabel:'Routine Webhook CLI'});
      return json(res,{connectId:'connect1',connectCode:'A7F39C2B',pollSecret:'poll-secret',clientLabel:'Routine Webhook CLI',expiresInSeconds:600,verificationUrl:`${origin}/connect/A7F39C2B`});
    }
    if (req.url.startsWith('/api/agent-connect/status?')) {
      const u = new URL(req.url,origin); assert.equal(u.searchParams.get('reference'),'connect1'); assert.equal(u.searchParams.get('pollSecret'),'poll-secret');
      return json(res,{status:'approved',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',issuer:origin,audience:'nia-teams-workload',expiresInSeconds:3600,workloadToken:'setup-bearer-do-not-store'});
    }
    assert.equal(req.headers.authorization,'Bearer setup-bearer-do-not-store');
    if(req.method==='GET') return json(res,{teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',routines:[]});
    assert.equal(req.url,'/api/teams/team1/webhook-routines');
    assert.deepEqual(JSON.parse(raw),{name:'local-dispatch',task:'Check inventory',autoApproveReply:true,connectMac:true});
    json(res,{ok:true,routine:{routineId:'routine1',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',name:'local-dispatch',task:'Check inventory',enabled:true,autoApproveReply:true,connectMac:true,webhookUrl:`${origin}/api/webhook/routine/routine1`,webhookSecret:secret,createdAt:'2026-11-13T00:00:00.000Z',updatedAt:'2026-11-13T00:00:00.000Z'}},201);
  }); origin = serverUrl;
  const options = { serverUrl, configDir:dir, onVerification: start => { observed=start.verificationUrl; } };
  const p = await initializeRoutine({...options,name:'local-dispatch',task:'Check inventory',autoApproveReply:true});
  assert.equal(p.connectMac,true); assert.equal((await new CredentialStore(dir).get()).connectMac,true);
  assert.equal(p.webhookSecret,secret); assert.equal(observed,`${origin}/connect/A7F39C2B`);
  assert.equal((await stat(dir)).mode & 0o777,0o700); assert.equal((await stat(join(dir,'credentials.json'))).mode & 0o777,0o600);
  const text = await readFile(join(dir,'credentials.json'),'utf8'); assert.ok(!text.includes('setup-bearer')); assert.ok(!text.includes('workloadToken')); assert.ok(!text.includes('poll-secret'));
  assert.deepEqual(await readdir(dir),['credentials.json']);
  const store = new CredentialStore(dir); await store.save({...p, workloadToken:'untrusted-extra'},'other'); await store.setCursor('saved','other');
  assert.equal((await store.get('other')).cursor,'saved'); assert.equal((await store.get('other')).connectMac,true); assert.ok(!(await readFile(join(dir,'credentials.json'),'utf8')).includes('untrusted-extra'));
  await store.remove('other'); assert.equal(Object.keys((await store.read()).profiles).length,1);
  let scoped; await withProvisioning(options, async api => {scoped=api; assert.deepEqual((await api.list()).routines,[]);});
  await assert.rejects(scoped.list(),/discarded/);
});

test('HMAC exact bytes, source, title, context and stable idempotency on retry', async t => {
  const calls=[];
  const {serverUrl}=await fixture(t,(req,res,raw)=>{
    calls.push({headers:req.headers,raw});
    if(calls.length===1) return json(res,{},503);
    json(res,accepted);
  });
  const client=new RoutineWebhookClient({serverUrl,routineId:'routine1',webhookSecret:secret});
  assert.deepEqual(await client.send({topicKey:'order:1042',message:'核对库存',title:'Order #1042',payload:{order:'1042'},contextKeys:['order']}),accepted);
  assert.equal(calls.length,2);assert.equal(calls[0].headers['idempotency-key'],calls[1].headers['idempotency-key']);
  assert.equal(calls[0].raw,calls[1].raw);
  assert.equal(calls[1].headers['x-hub-signature-256'],`sha256=${createHmac('sha256',secret).update(calls[1].raw).digest('hex')}`);
  assert.equal(calls[1].headers['x-webhook-secret'],undefined);assert.equal(calls[1].headers['x-nia-context-keys'],'order');
  assert.deepEqual(JSON.parse(calls[1].raw),{protocol:'nia-routine-source-v1',message:'核对库存',title:'Order #1042',source:{type:'external-agent',topicKey:'order:1042',return:{type:'wss'}},payload:{order:'1042'}});
  for(const topicKey of ['', 'contains space', 'a'.repeat(257)]) await assert.rejects(client.send({topicKey,message:'x'}));
  await assert.rejects(client.send({topicKey:'ok',message:'x',idempotencyKey:'short'}));
  await assert.rejects(client.send({topicKey:'ok',message:'x',payload:{},contextKeys:['missing']}));
});

test('Bearer OIDC mode is disk-free, defaults return none and accepts HTTPS callback', async t=>{
  let body;
  const {serverUrl}=await fixture(t,(req,res,raw)=>{assert.equal(req.headers.authorization,'Bearer oidc-token');assert.equal(req.headers['x-hub-signature-256'],undefined);body=JSON.parse(raw);json(res,accepted);});
  const c=new RoutineWebhookClient({serverUrl,routineId:'routine1',getBearerToken:async()=>'oidc-token'});
  await c.send({topicKey:'order:1042',message:'Check'});assert.deepEqual(body.source.return,{type:'none'});
  await c.send({topicKey:'order:1042',message:'Check',return:{type:'callback',url:'https://nia-teams.com/example/callback'}});assert.equal(body.source.return.type,'callback');
  await assert.rejects(c.send({topicKey:'order:1042',message:'Check',return:{type:'wss'}}));assert.throws(()=>c.listen({onReply:()=>{}}));
});

test('URL boundaries reject credentials, query, fragment, paths and HTTP outside loopback; redirects do not forward secrets',async t=>{
  for(const serverUrl of ['https://a:b@nia-teams.com','https://nia-teams.com?', 'https://nia-teams.com/#', 'https://nia-teams.com?x=1','https://nia-teams.com/#x','https://nia-teams.com/path','http://example.com']) assert.throws(()=>new RoutineWebhookClient({serverUrl,routineId:'r',webhookSecret:secret}));
  let count=0;const {serverUrl}=await fixture(t,(req,res)=>{count++;res.writeHead(302,{Location:'/other'});res.end();});
  const c=new RoutineWebhookClient({webhookUrl:`${serverUrl}/api/webhook/routine/routine1`,webhookSecret:secret});
  await assert.rejects(c.send({topicKey:'order:1042',message:'Check'}),/Redirects/);assert.equal(count,1);
});

test('callback HMAC verifies untouched bytes before payload validation',()=>{
  const rawBody=JSON.stringify(reply());const signatureHeader=`sha256=${createHmac('sha256',secret).update(rawBody).digest('hex')}`;
  assert.equal(verifyRoutineCallback({rawBody,signatureHeader,secret}).eventId,'event1');
  assert.throws(()=>verifyRoutineCallback({rawBody:rawBody+' ',signatureHeader,secret}));
  for(const bad of [undefined,'sha256=x','sha256='+'0'.repeat(64)]) assert.throws(()=>verifyRoutineCallback({rawBody,signatureHeader:bad,secret}));
  const invalid=JSON.stringify({...reply(),content:42});assert.throws(()=>verifyRoutineCallback({rawBody:invalid,signatureHeader:`sha256=${createHmac('sha256',secret).update(invalid).digest('hex')}`,secret}));
});

async function streamFixture(t,onConnection){
  const {server,serverUrl}=await fixture(t,(_q,r)=>json(r,{})); const wss=new WebSocketServer({server,path:'/ws'});
  wss.on('connection',onConnection);t.after(async()=>{for(const s of wss.clients)s.terminate();await new Promise(r=>wss.close(r));});
  return serverUrl;
}

test('WSS waits for handler and persistence, deduplicates and reconnects with acknowledged cursor', {timeout:8000},async t=>{
  const auths=[],acks=[],persisted=[],handled=[];let release;const gate=new Promise(r=>release=r);let connection=0,stream;
  const serverUrl=await streamFixture(t,ws=>{
    const index=++connection;
    ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='routine_auth'){
      auths.push(m);ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:m.cursor}));
      if(index===1){ws.send(JSON.stringify(reply()));ws.send(JSON.stringify(reply()));}
      else ws.send(JSON.stringify(reply('event2','cursor2')));
    } else if(m.type==='routine_cursor'){
      acks.push(m.cursor);if(index===1&&acks.length===2)ws.close();else if(index===2) stream.stop();
    }});
  });
  stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,initialCursor:'initial',reconnectMinMs:10,
    onReply:async p=>{handled.push(p.eventId);if(p.eventId==='event1')await gate;},persistCursor:c=>{persisted.push(c);}});
  const running=stream.run();await wait(70);assert.deepEqual(acks,[]);assert.deepEqual(persisted,[]);release();await running;
  assert.deepEqual(handled,['event1','event2']);assert.deepEqual(persisted,['cursor1','cursor1','cursor2']);
  assert.equal(auths[0].secret,secret);assert.equal(auths[0].cursor,'initial');assert.equal(auths[1].cursor,'cursor1');
  assert.deepEqual(acks,['cursor1','cursor1','cursor2']);
});

test('handler failure does not advance cursor or acknowledge later queued events', {timeout:8000}, async t=>{
  let connection=0,stream;const auths=[],acks=[],handled=[];
  const serverUrl=await streamFixture(t,ws=>{const n=++connection;ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='routine_auth'){
    auths.push(m.cursor);ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:m.cursor}));ws.send(JSON.stringify(reply()));if(n===1)ws.send(JSON.stringify(reply('event2','cursor2')));
  }else if(m.type==='routine_cursor'){acks.push(m.cursor);stream.stop();}});});
  stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,reconnectMinMs:10,onReply:p=>{handled.push(p.eventId);if(connection===1)throw Error('retry');}});
  await stream.run();assert.deepEqual(auths,[null,null]);assert.deepEqual(handled,['event1','event1']);assert.deepEqual(acks,['cursor1']);
});

test('expired cursor is explicit, fails closed without handler and allows caller recovery', {timeout:8000},async t=>{
  let recovered=false,stream;const cursors=[],persisted=[];
  const serverUrl=await streamFixture(t,ws=>ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='routine_auth'){
    cursors.push(m.cursor);if(m.cursor==='earliest')assert.deepEqual(persisted,['earliest']);if(m.cursor!=='earliest')ws.send(JSON.stringify({type:'routine_cursor_expired',earliestCursor:'earliest'}));
    else{ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:'earliest'}));ws.send(JSON.stringify(reply()));}
  }else if(m.type==='routine_cursor')stream.stop();}));
  await assert.rejects(new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,initialCursor:'old',onReply:()=>{}}).run(),/expired/);
  stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,initialCursor:'old',reconnectMinMs:10,onReply:()=>{},onCursorExpired:earliest=>{recovered=true;return earliest;},persistCursor:cursor=>{persisted.push(cursor);}});
  await stream.run();assert.ok(recovered);assert.deepEqual(cursors,['old','old','earliest']);assert.deepEqual(persisted,['earliest','cursor1']);
});

test('pairing polls pending approval at 2 seconds, reports expiration and rejects untrusted verification origins', {timeout:6000}, async t=>{
  const {agentConnect}=await import('../dist/index.js');let origin,polls=0,mode='pending';let firstPoll,lastPoll;
  const {serverUrl}=await fixture(t,(req,res)=>{
    if(req.url.endsWith('/start')) return json(res,{connectId:'c',connectCode:'A7F39C2B',pollSecret:'secret',clientLabel:'Routine Webhook CLI',expiresInSeconds:600,verificationUrl:`${mode==='untrusted'?'https://example.com':origin}/connect/A7F39C2B`});
    polls++;if(polls===1){firstPoll=Date.now();return json(res,{status:'pending'});}lastPoll=Date.now();json(res,{status:'expired'});
  });origin=serverUrl;
  await assert.rejects(agentConnect({serverUrl,onVerification:()=>{}}),/expired/);assert.equal(polls,2);assert.ok(lastPoll-firstPoll>=1900);
  mode='untrusted';await assert.rejects(agentConnect({serverUrl,onVerification:()=>assert.fail('untrusted URL displayed')}),/Untrusted/);
  mode='pending';polls=0;await assert.rejects(agentConnect({serverUrl,timeoutMs:30,onVerification:()=>{}}));
});

test('network-disconnect retry preserves key, bytes and does not expose secret in failure',async t=>{
  const calls=[];const {serverUrl}=await fixture(t,(req,res,raw)=>{calls.push({key:req.headers['idempotency-key'],raw});if(calls.length===1)return req.socket.destroy();json(res,accepted);});
  const c=new RoutineWebhookClient({serverUrl,routineId:'routine1',webhookSecret:secret});
  await c.send({topicKey:'order:1',message:'Check'});assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);
});

test('WSS application and control heartbeat, caller seen IDs and persistence failure replay', {timeout:8000},async t=>{
  let stream,connections=0,handled=0,persistCalls=0,appPong=false,controlPing=false;const cursors=[];
  const serverUrl=await streamFixture(t,ws=>{
    const n=++connections;ws.on('ping',()=>{controlPing=true;});
    ws.on('message',raw=>{const m=JSON.parse(raw);if(m.type==='routine_auth'){
      cursors.push(m.cursor);ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:m.cursor}));
      ws.send(JSON.stringify({type:'ping'}));
      ws.send(JSON.stringify(reply()));
    }else if(m.type==='pong')appPong=true;else if(m.type==='routine_cursor'&&n===2)setTimeout(()=>stream.stop(),30);
    });
  });
  stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,seenEventIds:new Set(['event1']),reconnectMinMs:5,heartbeatMs:10,
    onReply:()=>handled++,persistCursor:()=>{if(++persistCalls===1)throw Error('disk full');}});
  await stream.run();assert.equal(handled,0);assert.deepEqual(cursors,[null,null]);assert.equal(persistCalls,2);assert.ok(appPong);assert.ok(controlPing);
});

test('cursor expiration recovery rejection is fatal, not an implicit gap skip', {timeout:5000},async t=>{
  const serverUrl=await streamFixture(t,ws=>ws.on('message',raw=>{if(JSON.parse(raw).type==='routine_auth')ws.send(JSON.stringify({type:'routine_cursor_expired',earliestCursor:'earliest'}));}));
  const cause = new Error('human reconciliation needed');
  await assert.rejects(new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{},onCursorExpired:()=>{throw cause;}}).run(),error=>{assert.match(error.message,/recovery declined/);assert.equal(error.cause,cause);return true;});
});

test('stop terminates an authenticated peer that never answers the close frame', {timeout:4000}, async t=>{
  let ready;const authenticated=new Promise(resolve=>{ready=resolve;});
  const serverUrl=await streamFixture(t,ws=>ws.on('message',raw=>{
    if(JSON.parse(raw).type==='routine_auth'){
      ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:null}));
      ws._socket.pause(); // Keep TCP open without consuming or answering close frames.
      ready();
    }
  }));
  const stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{}});
  const running=stream.run();await authenticated;
  const started=Date.now();stream.stop();stream.stop();await running;
  assert.ok(Date.now()-started<2000,'Shutdown must not wait for the ws 30-second close timeout');
});

test('stop terminates CONNECTING sockets with an unfinished upgrade handshake', {timeout:4000}, async t=>{
  const {server,serverUrl}=await fixture(t,(_req,res)=>json(res,{}));
  let upgraded;const pending=new Promise(resolve=>{upgraded=resolve;});
  server.on('upgrade',()=>upgraded()); // Intentionally never respond to the HTTP upgrade.
  const stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{}});
  const running=stream.run();await pending;
  const started=Date.now();stream.stop();await running;
  assert.ok(Date.now()-started<1000);
});

test('protocol errors terminate a half-open peer before reconnect cleanup completes', {timeout:4000}, async t=>{
  const serverUrl=await streamFixture(t,ws=>ws.on('message',raw=>{
    if(JSON.parse(raw).type==='routine_auth'){
      ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:null}));
      ws.send('not-json');ws._socket.pause();
    }
  }));
  let error;
  const stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{},onError:e=>{error=e;stream.stop();}});
  const started=Date.now();await stream.run();assert.ok(error instanceof SyntaxError);assert.ok(Date.now()-started<2000);
});

test('cursor recovery persists replacement before reconnect even if the old peer ignores close', {timeout:5000}, async t=>{
  const persisted=[],cursors=[];let stream,connections=0;
  const serverUrl=await streamFixture(t,ws=>{
    const connection=++connections;
    ws.on('message',raw=>{
      const m=JSON.parse(raw);if(m.type!=='routine_auth')return;
      cursors.push(m.cursor);
      ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:m.cursor}));
      if(connection===1){ws.send(JSON.stringify({type:'routine_cursor_expired',earliestCursor:'earliest'}));ws._socket.pause();}
      else {
        assert.equal(m.cursor,'replacement');assert.deepEqual(persisted,['replacement']);
        ws.send(JSON.stringify(reply()));
      }
    });
  });
  stream=new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,initialCursor:'old',reconnectMinMs:5,
    onReply:()=>{},onCursorExpired:()=> 'replacement',persistCursor:cursor=>{persisted.push(cursor);},onProcessed:()=>stream.stop()});
  await stream.run();assert.deepEqual(cursors,['old','replacement']);assert.deepEqual(persisted,['replacement','cursor1']);
});

test('cursor recovery rejects invalid choices and retains persistence failure causes', {timeout:5000}, async t=>{
  const serverUrl=await streamFixture(t,ws=>ws.on('message',raw=>{
    if(JSON.parse(raw).type==='routine_auth')ws.send(JSON.stringify({type:'routine_cursor_expired',earliestCursor:'earliest'}));
  }));
  for(const choice of ['', '   ', undefined, 42]) {
    await assert.rejects(new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{},onCursorExpired:()=>choice}).run(),error=>{
      assert.equal(error.constructor.name,'CursorExpiredError');assert.match(error.cause.message,/nonempty string or null/);return true;
    });
  }
  const cause=new Error('cursor store unavailable');
  await assert.rejects(new RoutineReplyStream({serverUrl,routineId:'routine1',webhookSecret:secret,onReply:()=>{},onCursorExpired:()=> 'replacement',persistCursor:()=>{throw cause;}}).run(),error=>{
    assert.equal(error.cause,cause);return true;
  });
});

for (const connectMac of [false, true]) {
  test(`initializeRoutine preserves explicit connectMac: ${connectMac} through profile writes`, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'routine-mac-')); t.after(() => rm(dir, {recursive:true,force:true}));
    let origin;
    const {serverUrl} = await fixture(t, (req,res,raw) => {
      if (req.url === '/api/agent-connect/start') return json(res,{connectId:'c',connectCode:'CODE',pollSecret:'poll',verificationUrl:`${origin}/connect/CODE`});
      if (req.url.startsWith('/api/agent-connect/status')) return json(res,{status:'approved',teamId:'team1',workloadToken:'setup-token'});
      assert.equal(req.method,'POST');assert.deepEqual(JSON.parse(raw),{name:'Mac mode',task:'Check inventory',connectMac});
      json(res,{ok:true,routine:{routineId:'routine1',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',name:'Mac mode',task:'Check inventory',enabled:true,autoApproveReply:false,connectMac,webhookUrl:`${origin}/api/webhook/routine/routine1`,webhookSecret:secret,createdAt:'2026-11-13T00:00:00.000Z',updatedAt:'2026-11-13T00:00:00.000Z'}},201);
    }); origin=serverUrl;
    const p=await initializeRoutine({serverUrl,configDir:dir,name:'Mac mode',task:'Check inventory',connectMac,onVerification:()=>{}});
    assert.equal(p.connectMac,connectMac);
    const store=new CredentialStore(dir);assert.equal((await store.get()).connectMac,connectMac);
    await store.setCursor('next');assert.equal((await store.get()).connectMac,connectMac);
  });
}

test('RoutineProvisioner forwards connectMac patches and reads returned state', async t => {
  const {serverUrl}=await fixture(t,(req,res,raw)=>{
    assert.equal(req.method,'PATCH');assert.equal(req.url,'/api/teams/team1/webhook-routines/routine1');
    assert.deepEqual(JSON.parse(raw),{connectMac:false});
    json(res,{ok:true,routine:{routineId:'routine1',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',name:'Mac mode',task:'Check inventory',enabled:true,autoApproveReply:false,connectMac:false,webhookUrl:`http://${req.headers.host}/api/webhook/routine/routine1`,webhookSecret:secret,createdAt:'2026-11-13T00:00:00.000Z',updatedAt:'2026-11-13T00:00:00.000Z'}});
  });
  const api=new RoutineProvisioner(serverUrl,'team1','setup-token');t.after(()=>api.dispose());
  assert.equal((await api.update('routine1',{connectMac:false})).connectMac,false);
});

test('routineProfile only reports connectMac when the server returns true', () => {
  const routine={routineId:'routine1',webhookUrl:'https://nia-teams.com/api/webhook/routine/routine1'};
  for(const value of [true,false,undefined,'true',1]) {
    assert.equal(routineProfile({...routine,connectMac:value},'https://nia-teams.com').connectMac,value===true);
  }
});


test('secret-authenticated one-way send explicitly disables external replies', async t => {
  const {serverUrl}=await fixture(t,(req,res,raw)=>{
    assert.equal(req.method,'POST');assert.ok(req.headers['x-hub-signature-256']);
    assert.deepEqual(JSON.parse(raw).source.return,{type:'none'});json(res,accepted);
  });
  const client=new RoutineWebhookClient({serverUrl,routineId:'routine1',webhookSecret:secret});
  assert.deepEqual(await client.send({topicKey:'order:1042',message:'Work in GroupChat',return:{type:'none'}}),accepted);
});
