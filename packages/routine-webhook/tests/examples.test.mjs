import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHmac} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {CredentialStore} from '../dist/index.js';
const root=new URL('../',import.meta.url).pathname;
function example(file,env={},args=[],stopOnOutput=false){return new Promise((resolve,reject)=>{
 const child=spawn(process.execPath,['--import','tsx',`examples/${file}.ts`,...args],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 child.stdout.on('data',b=>{stdout+=b;if(stopOnOutput)child.kill('SIGINT');});child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
});}
test('all bundled TypeScript examples execute against local HTTP/WSS fixtures', {timeout:15000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'routine-examples-'));t.after(()=>rm(dir,{recursive:true,force:true}));let sends=0;
 const server=http.createServer(async(req,res)=>{for await(const _chunk of req){}sends++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({accepted:true,teamId:'t',groupChatId:'g',messageId:'m'}));});
 const sockets=new Set();server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
 const wss=new WebSocketServer({server,path:'/ws'});wss.on('connection',ws=>ws.on('message',raw=>{if(JSON.parse(raw).type==='routine_auth'){ws.send(JSON.stringify({type:'routine_auth_ok',routineId:'r',cursor:null}));ws.send(JSON.stringify({type:'routine.reply',routineId:'r',eventId:'e',topicKey:'order:1042',content:'Inventory synchronized.',createdAt:'2026-11-13T00:00:00.000Z',cursor:'c'}));}}));
 server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));});
 await new CredentialStore(dir).save({serverUrl:origin,webhookUrl:`${origin}/api/webhook/routine/r`,routineId:'r',teamId:'t',agentName:'ops-agent',agentSlug:'ops-agent',routineName:'Order Dispatch',webhookSecret:'whsec_example',autoApproveReply:true,cursor:null,createdAt:'2026-11-13T00:00:00.000Z'});
 const env={NIA_ROUTINE_WEBHOOK_CONFIG_DIR:dir,NIA_TEAMS_URL:origin,NIA_ROUTINE_ID:'r',NIA_ROUTINE_WEBHOOK_SECRET:'',WORKLOAD_OIDC_TOKEN:'fixture-oidc'};
 const send=await example('send',env);assert.equal(send.code,0,send.stderr);assert.match(send.stdout,/accepted: true/);
 const oidc=await example('oidc',env);assert.equal(oidc.code,0,oidc.stderr);assert.equal(sends,2);
 const listen=await example('listen',env,[],true);assert.equal(listen.code,0,listen.stderr);assert.match(listen.stdout,/Inventory synchronized/);
 const body=JSON.stringify({type:'routine.reply',routineId:'r',eventId:'e',topicKey:'order:1042',content:'Inventory synchronized.',createdAt:'2026-11-13T00:00:00.000Z'});const bodyPath=join(dir,'callback.json');await writeFile(bodyPath,body);
 const callback=await example('verify-callback',{...env,NIA_ROUTINE_WEBHOOK_SECRET:'whsec_example',CALLBACK_SIGNATURE:`sha256=${createHmac('sha256','whsec_example').update(body).digest('hex')}`},[bodyPath]);
 assert.equal(callback.code,0,callback.stderr);assert.match(callback.stdout,/Inventory synchronized/);
});
