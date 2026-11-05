import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { RuntimeManager } from '../src/runtime.mjs';
import { parseYaml } from '../src/profile.mjs';

async function fixture(t, options={}){
  const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-task-runtime-test-'));
  t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
  const children=[],stopped=[];
  const manager=new RuntimeManager({
    stateDir, snapshot:{sourceHome:path.join(stateDir,'source'),sourceAnchor:path.join(stateDir,'package.json'),dshAnchor:path.join(stateDir,'package.json'),dshBin:path.join(stateDir,'bin.js'),rows:[{id:'preset-standard',name:'file:///test/dsh-agent-preset/index.mjs',config:{id:'standard',plugins:[]}}]},catalog:[],bridgeModule:path.join(stateDir,'worker.mjs'),plan:async()=>({capabilities:[],reason:'test'}),maxRuntimes:1,startupTimeoutMs:1000,
    spawnChild:(executable,args,spawnOptions)=>{const child=new EventEmitter();Object.assign(child,{pid:100+children.length,exitCode:null,signalCode:null,stdout:new PassThrough(),stderr:new PassThrough(),spawnOptions,args});children.push(child);return child;},
    stopChild:async child=>{if(child){stopped.push(child.pid);child.exitCode=0;child.emit('exit',0);}},...options
  });
  t.after(()=>manager.close());return {manager,stateDir,children,stopped};
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function awaitState(task,state){for(let i=0;i<100&&task.state!==state;i++)await pause(5);assert.equal(task.state,state,task.error);}
test('worker owns a fresh home and waits for Host plus URL; no original prompt is on argv',async t=>{
  const {manager,children,stateDir}=await fixture(t);
  const task=manager.tasks.get(manager.start({prompt:'private original',cwd:stateDir,route:{provider:'test',model:'test'}}).id);
  await awaitState(task,'starting');const child=children[0];
  assert.ok(child.spawnOptions.env.DSH_HOME.startsWith(stateDir));assert.ok(!child.args.join(' ').includes('private original'));
  child.stdout.write(`DSH_TASK_EVENT ${JSON.stringify({id:task.id,type:'host-ready'})}\n`);
  assert.equal(task.state,'starting');child.stdout.write('dsh web: http://127.0.0.1:3210/?token=private\n');assert.equal(task.state,'awaiting-ui');
  const config=parseYaml(await fs.readFile(path.join(child.spawnOptions.env.DSH_HOME,'profiles/task-worker/cordis.patch.yml'),'utf8'));
  assert.equal(config[0].insert.length,2);assert.ok(config[0].insert.some(row=>row.id==='task-runtime-worker'));
  assert.equal(config[0].insert[0].config.id,'standard');
  assert.ok(!JSON.stringify(manager.public(task)).includes('token='));
});
test('concurrent task cap counts planning, cancellation prevents later spawning',async t=>{
  let complete;const pending=new Promise(resolve=>{complete=resolve;});
  const {manager,children,stateDir}=await fixture(t,{plan:()=>pending});
  const task=manager.start({prompt:'first',cwd:stateDir});assert.throws(()=>manager.start({prompt:'second',cwd:stateDir}),/上限/);
  await manager.stop(task.id);complete({capabilities:[],reason:''});await manager.tasks.get(task.id).work;
  assert.equal(children.length,0);assert.equal(manager.tasks.get(task.id).state,'stopped');
});
test('startup timeout stops exactly the owned child and retains a clear error',async t=>{
  const {manager,stopped,stateDir}=await fixture(t,{startupTimeoutMs:20});
  const task=manager.tasks.get(manager.start({prompt:'first',cwd:stateDir}).id);
  await awaitState(task,'failed');assert.match(task.error,/超时/);assert.deepEqual(stopped,[100]);
});
test('unknown model selection fails before a subprocess is created',async t=>{
  const {manager,children,stateDir}=await fixture(t,{plan:async()=>({capabilities:['not-installed'],reason:''})});
  const task=manager.tasks.get(manager.start({prompt:'first',cwd:stateDir}).id);
  await task.work;assert.equal(task.state,'failed');assert.match(task.error,/Unknown/);assert.equal(children.length,0);
});
