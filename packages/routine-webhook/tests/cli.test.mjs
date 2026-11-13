import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const cli = new URL('../bin/nia-routine-webhook.mjs', import.meta.url).pathname;
function run(args, env = {}, input = '', timeout) {
  return new Promise((resolve, reject) => {
    const child=spawn(process.execPath,[cli,...args],{env:{...process.env,NIA_ROUTINE_ID:'',NIA_ROUTINE_WEBHOOK_SECRET:'',...env},stdio:['pipe','pipe','pipe'],timeout,killSignal:'SIGKILL'});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);
    child.on('close',code=>resolve({code,stdout,stderr}));child.stdin.end(input);
  });
}
const json=(res,value,code=200)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
test('CLI init, stdin/send, filtered listen --once, profiles, rotate-secret and delete', {timeout:15000},async t=>{
  const dir=await mkdtemp(join(tmpdir(),'routine-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  let origin,secret='whsec_demo_original';let patch,created,deleted=false,sent,acks=[];
  const routine=()=>({routineId:'routine1',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',name:'Order Dispatch',task:'Check inventory',enabled:true,autoApproveReply:true,connectMac:created?.connectMac ?? true,webhookUrl:`${origin}/api/webhook/routine/routine1`,webhookSecret:secret,createdAt:'2026-11-13T00:00:00.000Z',updatedAt:'2026-11-13T00:00:00.000Z'});
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString();const body=raw?JSON.parse(raw):undefined;
    if(req.url==='/api/agent-connect/start')return json(res,{connectId:'c',connectCode:'A7F39C2B',pollSecret:'poll-secret',clientLabel:body.clientLabel,expiresInSeconds:600,verificationUrl:`${origin}/connect/A7F39C2B`});
    if(req.url.startsWith('/api/agent-connect/status'))return json(res,{status:'approved',teamId:'team1',agentSlug:'ops-agent',agentName:'ops-agent',issuer:origin,audience:'nia-teams-workload',expiresInSeconds:3600,workloadToken:'setup-token-not-for-disk'});
    if(req.url==='/api/webhook/routine/routine1') {sent=body;assert.ok(req.headers['x-hub-signature-256']);return json(res,{accepted:true,teamId:'team1',groupChatId:'chat1',messageId:'message1'});}
    assert.equal(req.headers.authorization,'Bearer setup-token-not-for-disk');
    if(req.method==='POST'){created=body;return json(res,{ok:true,routine:routine()},201);}
    if(req.method==='PATCH'){patch=body;secret='whsec_demo_rotated';return json(res,{ok:true,routine:routine()});}
    if(req.method==='DELETE'){deleted=true;return json(res,{ok:true,routineId:'routine1'});}
    json(res,{},404);
  });
  const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  const wss=new WebSocketServer({server,path:'/ws'});wss.on('connection',ws=>ws.on('message',raw=>{
    const m=JSON.parse(raw);if(m.type==='routine_auth'){
      assert.equal(m.secret,secret);assert.equal(m.cursor,null);
      ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:null}));
      for(const [eventId,topicKey,cursor]of [['e0','other:1','c0'],['e1','order:1042','c1'],['e2','order:1042','c2']])ws.send(JSON.stringify({type:'routine.reply',routineId:'routine1',eventId,topicKey,cursor,content:'Inventory synchronized.',createdAt:'2026-11-13T00:00:00.000Z'}));
    }else if(m.type==='routine_cursor')acks.push(m.cursor);
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{for(const s of sockets)s.destroy();for(const s of wss.clients)s.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
  const common=['--config-dir',dir,'--profile','dispatch'];
  const init=await run(['init',...common,'--server',origin,'--name','Order Dispatch','--task','Check inventory','--auto-approve-reply']);
  assert.equal(init.code,0,init.stderr);assert.ok(init.stderr.includes('/connect/A7F39C2B'));assert.equal(JSON.parse(init.stdout).routineId,'routine1');assert.ok(!init.stdout.includes(secret));
  assert.equal(created.connectMac,true);assert.equal(JSON.parse(init.stdout).connectMac,true);
  assert.equal((await stat(join(dir,'credentials.json'))).mode&0o777,0o600);
  const send=await run(['send',...common,'--topic-key','order:1042','--title','Order #1042','--payload','{"order":1042}','--context-keys','order'],'','Check inventory');
  assert.equal(send.code,0,send.stderr);assert.equal(JSON.parse(send.stdout).accepted,true);assert.equal(sent.message,'Check inventory');assert.equal(sent.title,'Order #1042');
  const oneWay=await run(['send',...common,'--topic-key','order:1042','--message','Work in GroupChat','--return','none']);
  assert.equal(oneWay.code,0,oneWay.stderr);assert.equal(JSON.parse(oneWay.stdout).accepted,true);assert.deepEqual(sent.source.return,{type:'none'});
  const listen=await run(['listen',...common,'--once','--topic-key','order:1042','--timeout-ms','3000']);assert.equal(listen.code,0,listen.stderr);
  assert.equal(listen.stdout.trim().split('\n').length,1);assert.equal(JSON.parse(listen.stdout).eventId,'e1');assert.deepEqual(acks,['c0','c1']);
  let data=JSON.parse(await readFile(join(dir,'credentials.json'),'utf8'));assert.equal(data.profiles.dispatch.cursor,'c1');assert.equal(data.profiles.dispatch.connectMac,true);
  const profiles=await run(['profiles',...common]);assert.equal(profiles.code,0);assert.ok(profiles.stdout.includes('[REDACTED]'));assert.ok(!profiles.stdout.includes(secret));
  const rotate=await run(['rotate-secret',...common]);assert.equal(rotate.code,0,rotate.stderr);assert.deepEqual(patch,{rotateSecret:true});
  data=JSON.parse(await readFile(join(dir,'credentials.json'),'utf8'));assert.equal(data.profiles.dispatch.webhookSecret,'whsec_demo_rotated');assert.equal(data.profiles.dispatch.cursor,'c1');assert.equal(data.profiles.dispatch.connectMac,true);
  assert.ok(!JSON.stringify(data).includes('setup-token'));
  for(const [flag,expected] of [['--no-connect-mac',false],['--connect-mac',true]]) {
    const result=await run(['init',...common,'--server',origin,'--name','Order Dispatch','--task','Check inventory',flag]);
    assert.equal(result.code,0,result.stderr);assert.equal(created.connectMac,expected);assert.equal(JSON.parse(result.stdout).connectMac,expected);
    const saved=JSON.parse(await readFile(join(dir,'credentials.json'),'utf8'));assert.equal(saved.profiles.dispatch.connectMac,expected);
  }
  const del=await run(['delete',...common]);assert.equal(del.code,0,del.stderr);assert.ok(deleted);assert.deepEqual(JSON.parse(await readFile(join(dir,'credentials.json'),'utf8')).profiles,{});
});

test('CLI environment-only send never creates config directory; errors are nonzero',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'routine-env-'));t.after(()=>rm(dir,{recursive:true,force:true}));const missing=join(dir,'must-not-exist');
  const server=http.createServer((req,res)=>json(res,{accepted:true,teamId:'t',groupChatId:'g',messageId:'m'}));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));
  const result=await run(['send','--topic-key','order:1','--message','Check','--config-dir',missing],{NIA_ROUTINE_ID:'routine1',NIA_ROUTINE_WEBHOOK_SECRET:'whsec_test',NIA_TEAMS_URL:`http://127.0.0.1:${server.address().port}`});
  assert.equal(result.code,0,result.stderr);await assert.rejects(stat(missing),{code:'ENOENT'});
  const bad=await run(['init','--name','x']);assert.equal(bad.code,1);assert.match(bad.stderr,/--task/);
  const conflict=await run(['init','--name','x','--task','x','--connect-mac','--no-connect-mac','--server',`http://127.0.0.1:${server.address().port}`,'--config-dir',missing]);
  assert.equal(conflict.code,1);assert.match(conflict.stderr,/Choose one Mac connection mode/);assert.equal(conflict.stdout,'');
  await assert.rejects(stat(missing),{code:'ENOENT'});
  const help=await run(['--help']);assert.equal(help.code,0);assert.match(help.stdout,/rotate-secret/);assert.match(help.stdout,/\[--connect-mac\|--no-connect-mac\]/);
});

test('CLI listen --once and --timeout-ms exit when peers ignore close frames', {timeout:8000},async t=>{
  let deliver=true;
  const server=http.createServer();
  const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
  const wss=new WebSocketServer({server,path:'/ws'});
  wss.on('connection',ws=>ws.on('message',raw=>{
    if(JSON.parse(raw).type==='routine_auth'){
      ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'routine1',cursor:null}));
      if(deliver)ws.send(JSON.stringify({type:'routine.reply',routineId:'routine1',eventId:'e1',topicKey:'order:1042',cursor:'c1',content:'Done.',createdAt:'2026-11-13T00:00:00.000Z'}));
      ws._socket.pause();
    }
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const s of sockets)s.destroy();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
  const env={NIA_ROUTINE_ID:'routine1',NIA_ROUTINE_WEBHOOK_SECRET:'whsec_fixture',NIA_TEAMS_URL:`http://127.0.0.1:${server.address().port}`};
  const onceResult=await run(['listen','--once','--timeout-ms','3000'],env,'',2500);
  assert.equal(onceResult.code,0,onceResult.stderr);assert.equal(JSON.parse(onceResult.stdout).eventId,'e1');
  deliver=false;
  const timeoutResult=await run(['listen','--timeout-ms','250'],env,'',2500);
  assert.equal(timeoutResult.code,1,timeoutResult.stderr);assert.match(timeoutResult.stderr,/Listen timed out/);
});
