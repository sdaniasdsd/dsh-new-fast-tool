import fs from 'node:fs/promises';
import { Handoff } from './handoff.mjs';
import { json } from './http.mjs';
import { redact } from './runtime.mjs';
import { assertSelectedActive, assertPresetActive } from './activation.mjs';
import { owningPackage } from './catalog.mjs';

export const name='task-runtime-worker';
export const inject=['webServer','connection','sessionController','agentPresets'];
export async function apply(ctx,config){
  const task=JSON.parse(await fs.readFile(config.taskFile,'utf8'));
  const emit=event=>console.log(`DSH_TASK_EVENT ${JSON.stringify({id:task.id,...event})}`);
  const audit=async scoped=>{
    if(scoped)await ctx.loader.await();
    const entries=[...ctx.loader.entries()];
    assertSelectedActive(entries,config.selectedHostIds,ctx.fiber.state);
    // The standing declaration and a Session's retained scope are lazy: do not
    // expect the generated preset to be mounted before session creation.
    if(scoped)assertPresetActive(await ctx.agentPresets.compositionInventory(),config.selectedScopeIds,ctx.fiber.state);
  };
  const handoff=new Handoff(task,ctx.sessionController,emit,audit);
  let hostReady=false, disposed=false;
  for(const action of ['expectations','ready','begin','failed'])ctx.effect(()=>ctx.webServer.register({kind:'exact',path:`/task-runtime/${action}`,handler:async(req,res)=>{
    const rejected=ctx.connection.requestRejection(req);
    if(rejected!==undefined)return json(res,rejected,{error:'Unauthorized'});
    if(req.method!=='POST')return json(res,405,{error:'POST required'});
    if(!hostReady)return json(res,503,{error:'Host not ready'});
    try{
      if(action==='failed'){emit({type:'failed',message:'所选前端插件未能激活，原始任务未提交。'});return json(res,200,{});}
      if(action==='expectations'){
        await audit(false);
        const packages=new Set();
        for(const entry of ctx.loader.entries())if(config.selectedHostIds.includes(entry.options.id)&&!entry.disabled){const pkg=owningPackage(entry.options.name);if(pkg?.dsh?.client)packages.add(pkg.name);}
        const presets=await ctx.agentPresets.list();
        emit({type:'preset-roster',ids:presets.map(item=>item.id),broken:presets.filter(item=>item.broken).map(item=>({id:item.id,reason:redact(item.broken)}))});
        return json(res,200,{packages:[...packages],presets:presets.map(item=>({id:item.id,broken:item.broken}))});
      }
      json(res,200,await (action==='ready'?handoff.ready():handoff.begin()));
    }
    catch(error){emit({type:'failed',message:redact(error.message)});json(res,500,{error:'任务交接失败，请查看子进程诊断。'});}
  }}),`task-runtime.worker.${action}`);
  // Do not await the Loader from apply(): that would make readiness depend on
  // itself. The Client also returns from apply before its settled-tree wait.
  const timer=setTimeout(()=>{
    void ctx.loader.await().then(async()=>{if(!disposed){await audit(false);hostReady=true;emit({type:'host-ready'});}}).catch(error=>emit({type:'failed',message:redact(error.message)}));
  },0);
  ctx.effect(()=>()=>{disposed=true;clearTimeout(timer);},'task-runtime.worker-ready');
}
