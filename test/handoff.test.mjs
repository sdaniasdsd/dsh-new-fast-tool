import test from 'node:test';
import assert from 'node:assert/strict';
import { Handoff } from '../src/handoff.mjs';
import { parsePlan } from '../src/planner.mjs';
import { allowed } from '../src/http.mjs';
import { redact } from '../src/runtime.mjs';
import { assertSelectedActive, assertPresetActive } from '../src/activation.mjs';

test('original task is never submitted before UI readiness, then exactly once',async()=>{
  const calls=[],events=[];
  const controller={create:async request=>{assert.equal(request.agentPreset,'standard');calls.push('create');return {sessionId:'session-test'};},selectModel:async()=>calls.push('select'),prompt:async request=>calls.push(request)};
  const task={id:'task-1',prompt:'原始任务\n包含多行',cwd:'E:\\workspace',route:{provider:'test',model:'test'}};
  const handoff=new Handoff(task,controller,event=>events.push(event));
  assert.throws(()=>handoff.begin(),/尚未就绪/);assert.deepEqual(calls,[]);
  const prepared=await Promise.all([handoff.ready(),handoff.ready()]);assert.equal(prepared[0].sessionId,'session-test');assert.deepEqual(calls,['create','select']);
  await Promise.all([handoff.begin(),handoff.begin()]);
  assert.equal(calls.length,3);assert.equal(calls[2].content[0].text,task.prompt);assert.equal(calls[2].requestId,task.id);
  assert.equal(events.filter(x=>x.type==='submitted').length,1);
});

test('selected tools must be enabled in the actual task preset inventory',()=>{
  assert.throws(()=>assertPresetActive([],['tool-fs'],2),/Standard preset 未注册/);
  assert.throws(()=>assertPresetActive([{id:'standard',broken:'missing service',rows:[]}],[],2),/missing service/);
  assert.throws(()=>assertPresetActive([{id:'standard',rows:[{entryId:'tool-fs',enabled:false,fiberState:2}]}],['tool-fs'],2),/未激活/);
  assert.doesNotThrow(()=>assertPresetActive([{id:'standard',rows:[{entryId:'delegation:tool-fs',enabled:true,fiberState:2}]}],['tool-fs'],2));
});
test('check-only mode never creates a session or submits a real prompt',async()=>{
  const controller=new Proxy({},{get(){throw new Error('must not touch assistant');}});
  const handoff=new Handoff({checkOnly:true},controller,()=>{});
  await handoff.ready();assert.deepEqual(await handoff.begin(),{checkOnly:true});
});
test('model JSON is validated against existing capabilities',()=>{
  const catalog=[{id:'files',requires:[]}];
  assert.deepEqual(parsePlan('```json\n{"capabilities":["files"],"reason":"需要文件"}\n```',catalog).capabilities,['files']);
  assert.throws(()=>parsePlan('{"capabilities":["shell"]}',catalog),/Unknown/);
  assert.throws(()=>parsePlan('please execute...',catalog),/JSON/);
});
test('controller rejects wrong origin, host and access token',()=>{
  const req={headers:{host:'127.0.0.1:3186',origin:'http://127.0.0.1:3186',authorization:'Bearer local-secret'}};
  assert.equal(allowed(req,'local-secret','http://127.0.0.1:3186'),true);
  assert.equal(allowed({...req,headers:{...req.headers,origin:'https://evil.example'}},'local-secret','http://127.0.0.1:3186'),false);
  assert.equal(allowed(req,'wrong','http://127.0.0.1:3186'),false);
  assert.equal(allowed({...req,headers:{...req.headers,host:'evil.example'}},'local-secret','http://127.0.0.1:3186'),false);
});
test('diagnostic redaction hides DSH URL tokens and API keys',()=>{
  const redacted=redact('dsh web: http://127.0.0.1:1234/?token=private-token apiKey=private sk-abcdefghijkl');
  assert.ok(!redacted.includes('private'));assert.ok(!redacted.includes('sk-abcdefghijkl'));
});
test('settled but failed/missing selected plugins block original message',async()=>{
  assert.throws(()=>assertSelectedActive([{options:{id:'selected'},disabled:false,fiber:{state:3}}],['selected'],2),/未激活/);
  assert.throws(()=>assertSelectedActive([],['selected'],2),/加载树/);
  const controller={create:async()=>{throw new Error('must not create');}};
  const handoff=new Handoff({prompt:'original'},controller,()=>{},()=>assertSelectedActive([],['selected'],2));
  await assert.rejects(handoff.ready(),/加载树/);
  await assert.rejects(handoff.begin(),/加载树/);
  assert.equal(handoff.started,false);
});
