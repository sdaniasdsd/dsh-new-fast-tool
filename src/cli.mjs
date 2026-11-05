#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { buildCatalog, walkRows } from './catalog.mjs';
import { parseYaml, privateWrite, copyModelState, routerRows, writeProfile } from './profile.mjs';
import { stopOwnedChild } from './runtime.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function options(argv){const result={};for(let i=0;i<argv.length;i++){const key=argv[i];if(!key.startsWith('--'))throw new Error(`Unknown argument: ${key}`);result[key.slice(2)]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;}return result;}
async function installedDsh(explicit){
  let dir=explicit||process.env.DSH_TASK_DSH_ROOT;
  if(!dir){
    const {stdout}=await promisify(execFile)(process.execPath, [path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'), 'root','-g']).catch(async()=>{
      // npm.cmd cannot be execFile'd directly on Windows without a shell. Resolve
      // the standard user prefix first, then use npm on non-Windows hosts.
      if(process.platform==='win32')return {stdout:path.join(process.env.APPDATA,'npm','node_modules')};
      return promisify(execFile)('npm',['root','-g']);
    });
    dir=path.join(stdout.trim(),'@deepseek-ai','dsh');
  }
  dir=path.resolve(dir);
  const manifest=JSON.parse(await fs.readFile(path.join(dir,'package.json'),'utf8'));
  if(manifest.name!=='@deepseek-ai/dsh')throw new Error('--dsh-root 必须指向已安装 @deepseek-ai/dsh 包目录。');
  const bin=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.dsh;
  if(!bin)throw new Error('安装的 DSH 未声明 CLI。');
  return {dshAnchor:path.join(dir,'package.json'),dshBin:path.resolve(dir,bin),dshVersion:manifest.version};
}

export async function prepare(opts){
  const installation=await installedDsh(opts['dsh-root']);
  const sourceHome=path.resolve(opts['source-home']||process.env.DSH_HOME||path.join(os.homedir(),'.dsh'));
  const stateDir=path.resolve(opts.state||path.join(root,'.runtime'));
  if(stateDir===sourceHome || stateDir.startsWith(sourceHome+path.sep))throw new Error('运行状态目录必须独立于原 DSH_HOME。');
  const profile=String(opts.profile||'web');
  if(!/^[A-Za-z0-9_-]+$/.test(profile))throw new Error('Invalid source profile');
  const sourceAnchor=path.join(sourceHome,'profiles',profile,'package.json');
  await fs.access(sourceAnchor);
  const {stdout}=await promisify(execFile)(process.execPath,[installation.dshBin,'--profile',profile,'--dump-config'],{env:{...process.env,DSH_HOME:sourceHome},maxBuffer:16*1024*1024,timeout:30000,windowsHide:true});
  const rows=parseYaml(stdout);
  if(!Array.isArray(rows)||!rows.length)throw new Error('源 profile 未生成有效插件清单。');
  const extension=opts.catalog?JSON.parse(await fs.readFile(path.resolve(opts.catalog),'utf8')):[];
  const infrastructureIds=String(opts['model-plugin']||'').split(',').filter(Boolean);
  for(const id of infrastructureIds)if(!rows.some(row=>row.id===id))throw new Error(`模型插件不存在于源根清单：${id}`);
  const catalog=buildCatalog(rows,extension,infrastructureIds);
  const snapshot={...installation,sourceHome,sourceAnchor,sourceProfile:profile,createdAt:new Date().toISOString(),infrastructureIds,rows};
  const defaultModel=rows.find(row=>row.id==='agent-default-model')?.config;
  const route={provider:opts.provider||defaultModel?.provider||'deepseek-official',model:opts.model||defaultModel?.model||'deepseek-flash'};
  const port=Number(opts.port||3186);if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid router port');
  const settings={route,port,cwd:path.resolve(opts.cwd||process.cwd()),maxRuntimes:Number(opts['max-runtimes']||2),startupTimeoutMs:90000};
  if(!Number.isInteger(settings.maxRuntimes)||settings.maxRuntimes<1||settings.maxRuntimes>8)throw new Error('max-runtimes 必须为 1 到 8。');
  const routerHome=path.join(stateDir,'router');
  await copyModelState(sourceHome,routerHome);
  const access={token:randomBytes(32).toString('base64url')};
  await privateWrite(path.join(stateDir,'snapshot.json'),JSON.stringify(snapshot));
  await privateWrite(path.join(stateDir,'catalog.json'),JSON.stringify(catalog,null,2));
  await privateWrite(path.join(stateDir,'router-config.json'),JSON.stringify(settings,null,2));
  await privateWrite(path.join(stateDir,'router-access.json'),JSON.stringify(access));
  await writeProfile(routerHome,'task-router',routerRows(snapshot,{stateDir},path.join(root,'src','host.mjs')));
  let count=0;walkRows(rows,()=>count++);
  console.log(`已准备独立 profile：${stateDir}\nDSH ${installation.dshVersion}；源清单 ${count} 行；可选能力 ${catalog.length} 组。\n模型：${route.provider} / ${route.model}\n原 DSH_HOME 未修改。`);
  return {stateDir,snapshot,catalog,settings};
}

async function start(opts){
  const stateDir=path.resolve(opts.state||path.join(root,'.runtime'));
  const snapshot=JSON.parse(await fs.readFile(path.join(stateDir,'snapshot.json'),'utf8'));
  const current=await installedDsh(path.dirname(snapshot.dshAnchor));
  if(current.dshVersion!==snapshot.dshVersion)throw new Error('DSH 已升级，请重新 prepare。');
  const access=JSON.parse(await fs.readFile(path.join(stateDir,'router-access.json'),'utf8'));
  const child=spawn(process.execPath,[snapshot.dshBin,'--profile','task-router'],{env:{...process.env,DSH_HOME:path.join(stateDir,'router')},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
  let pending='';
  child.stdout.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trim();pending=pending.slice(end+1);if(line.startsWith('DSH_TASK_ROUTER_READY ')){const origin=line.slice(22).trim();console.log(`按需入口已就绪：${origin}`);if(!opts['no-open'])openBrowser(`${origin}/#token=${access.token}`);else console.log('访问令牌在私有 router-access.json 中；在入口 URL 后添加 #token=<token>。');}else console.log(line);}});
  child.stderr.pipe(process.stderr);
  const stop=()=>void stopOwnedChild(child,6000);
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  await new Promise(resolve=>child.once('exit',code=>{process.exitCode=code??0;resolve();}));
}
function openBrowser(url){
  let child;
  if(process.platform==='win32')child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});
  else child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});
  child.on('error',()=>console.error('无法自动打开浏览器，请使用私有访问令牌打开入口。'));
  child.unref();
}
async function check(opts){
  const stateDir=path.resolve(opts.state||path.join(root,'.runtime'));
  const snapshot=JSON.parse(await fs.readFile(path.join(stateDir,'snapshot.json'),'utf8'));
  const current=await installedDsh(path.dirname(snapshot.dshAnchor));
  if(current.dshVersion!==snapshot.dshVersion)throw new Error('DSH 已升级，请重新 prepare。');
  const {stdout}=await promisify(execFile)(process.execPath,[snapshot.dshBin,'--profile','task-router','--dump-config'],{env:{...process.env,DSH_HOME:path.join(stateDir,'router')},maxBuffer:16*1024*1024,timeout:30000});
  const rows=parseYaml(stdout);
  console.log(`配置解析通过：router ${rows.length} 个根插件；DSH ${current.dshVersion}。未发送模型请求。`);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  try{const opts=options(args);if(command==='prepare')await prepare(opts);else if(command==='start')await start(opts);else if(command==='check')await check(opts);else console.log('用法：dsh-task-runtime prepare|start|check [--state PATH] [--source-home PATH] [--profile web] [--dsh-root PATH] [--provider ID --model ID] [--cwd PATH] [--no-open]');}
  catch(error){console.error(error.message);process.exitCode=1;}
}
