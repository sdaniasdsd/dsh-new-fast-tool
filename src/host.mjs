import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeManager } from './runtime.mjs';
import { planTask } from './planner.mjs';
import { modelCatalog } from './catalog.mjs';
import { allowed, bodyJson, json } from './http.mjs';

export const name='task-runtime-router';
export const inject=['llm'];
export async function apply(ctx, config={}) {
  if(!config.stateDir)throw new Error('请先运行 dsh-task-runtime prepare，或配置 task-runtime.stateDir。');
  const settings=JSON.parse(await fs.readFile(path.join(config.stateDir,'router-config.json'),'utf8'));
  const snapshot=JSON.parse(await fs.readFile(path.join(config.stateDir,'snapshot.json'),'utf8'));
  const catalog=JSON.parse(await fs.readFile(path.join(config.stateDir,'catalog.json'),'utf8'));
  const access=JSON.parse(await fs.readFile(path.join(config.stateDir,'router-access.json'),'utf8'));
  const route=settings.route || ctx.get('agentDefaultModel')?.currentSelection();
  if(!route?.provider || !route?.model)throw new Error('请配置路由模型的 provider 和 model。');
  const manager=new RuntimeManager({snapshot,catalog,stateDir:config.stateDir,bridgeModule:fileURLToPath(new URL('./worker.mjs',import.meta.url)),maxRuntimes:settings.maxRuntimes || 2, startupTimeoutMs:settings.startupTimeoutMs || 90000,plan:(task,signal)=>planTask(ctx,task,catalog,route,snapshot.dshAnchor,signal)});
  let origin;
  const page=await fs.readFile(new URL('./router.html',import.meta.url));
  const script=await fs.readFile(new URL('./router-browser.js',import.meta.url));
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(!req.headers.host || req.headers.host!==new URL(origin).host)return json(res,403,{error:'Host 不匹配。'});
      if(req.method==='GET' && (url.pathname==='/' || url.pathname==='/router-browser.js')){
        res.writeHead(200,{'content-type':url.pathname==='/'?'text/html; charset=utf-8':'text/javascript; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://127.0.0.1:*; connect-src 'self'; frame-ancestors 'self'"});
        return res.end(url.pathname==='/'?page:script);
      }
      if(!allowed(req,access.token,origin))return json(res,403,{error:'需要本机访问令牌。'});
      if(req.method==='GET' && url.pathname==='/api/catalog')return json(res,200,{capabilities:modelCatalog(catalog),cwd:settings.cwd,route});
      if(req.method==='GET' && url.pathname==='/api/tasks')return json(res,200,{tasks:manager.list()});
      if(req.method==='POST' && url.pathname==='/api/tasks'){
        const request=await bodyJson(req);
        return json(res,202,manager.start({prompt:request.prompt,cwd:request.cwd||settings.cwd,route}));
      }
      const match=/^\/api\/tasks\/([0-9a-f-]+)\/(connect|stop)$/.exec(url.pathname);
      if(req.method==='POST' && match){
        const task=manager.tasks.get(match[1]);if(!task)return json(res,404,{error:'任务不存在。'});
        if(match[2]==='stop')return json(res,200,await manager.stop(task.id));
        if(!task.url || !['awaiting-ui','dialogue','check-ready'].includes(task.state))return json(res,409,{error:'子进程尚未就绪。'});
        return json(res,200,{url:task.url});
      }
      json(res,404,{error:'接口不存在。'});
    }catch(error){if(!res.headersSent)json(res,400,{error:error.message});else res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(settings.port??3186,'127.0.0.1',resolve);});
  origin=`http://127.0.0.1:${server.address().port}`;
  // No access token or child token URL is written into diagnostic output.
  console.log(`DSH_TASK_ROUTER_READY ${origin}`);
  ctx.effect(()=>async()=>{await manager.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));},'task-runtime.router');
}
