// Opt-in compatibility check against a local DSH installation. No LLM call,
// real assistant prompt, normal-home writes, or external plugin installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeManager, stopOwnedChild, redact } from '../src/runtime.mjs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root=fileURLToPath(new URL('../',import.meta.url));
const stateDir=path.join(root,'.runtime');
const snapshot=JSON.parse(await fs.readFile(path.join(stateDir,'snapshot.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(stateDir,'catalog.json'),'utf8'));
const access=JSON.parse(await fs.readFile(path.join(stateDir,'router-access.json'),'utf8'));
const settings=JSON.parse(await fs.readFile(path.join(stateDir,'router-config.json'),'utf8'));
const router=spawn(process.execPath,[snapshot.dshBin,'--profile','task-router'],{env:{...process.env,DSH_HOME:path.join(stateDir,'router')},stdio:['ignore','pipe','pipe'],windowsHide:true,detached:process.platform!=='win32'});
let origin='', output='';
router.stdout.on('data',chunk=>{const text=chunk.toString();output+=text;const match=/DSH_TASK_ROUTER_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);if(match)origin=match[1];});
router.stderr.on('data',chunk=>{output+=chunk.toString();if(output.length>20000)output=output.slice(-20000);});
const selected=process.argv.slice(2);
const manager=new RuntimeManager({snapshot,catalog,stateDir,bridgeModule:path.join(root,'src','worker.mjs'),plan:async()=>({capabilities:selected,reason:'启动检查：未调用模型'}),startupTimeoutMs:90000});
let browser;
async function until(predicate,timeout=45000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('Timed out. '+redact(output).slice(-1800));await new Promise(resolve=>setTimeout(resolve,100));}}
try{
  await until(()=>origin||router.exitCode!==null);
  assert.ok(origin,'router failed: '+redact(output).slice(-1800));
  assert.equal((await fetch(origin+'/api/catalog')).status,403);
  const response=await fetch(origin+'/api/catalog',{headers:{Authorization:`Bearer ${access.token}`}});
  assert.equal(response.status,200);assert.ok((await response.json()).capabilities.length);
  console.log('Installed DSH router: authenticated HTTP + thin page ready.');
  const started=manager.start({prompt:'启动检查，不提交给助手。',cwd:settings.cwd,route:settings.route,checkOnly:true});
  const task=manager.tasks.get(started.id);
  await until(()=>['awaiting-ui','failed'].includes(task.state),90000);
  assert.equal(task.state,'awaiting-ui',task.error||task.errors.join('\n'));
  const auth=await fetch(task.url,{redirect:'manual'});
  const cookies=auth.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
  const childOrigin=new URL(task.url).origin;
  const page=await fetch(childOrigin+'/',{headers:{Cookie:cookies}});
  assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('dsh-task-runtime'),'worker bridge missing from client graph');
  const executable=process.env.DSH_TEST_BROWSER || (process.platform==='win32'?'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe':undefined);
  browser=await chromium.launch({executablePath:executable,headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:900}});
  const pageErrors=[];
  const workerPage=await context.newPage();
  workerPage.on('pageerror',error=>pageErrors.push(redact(error.message).slice(0,350)));
  workerPage.on('console',message=>{if(message.type()==='error')pageErrors.push(redact(message.text()).slice(0,350));});
  await workerPage.goto(task.url,{waitUntil:'domcontentloaded',timeout:45000});
  try{await until(()=>['check-ready','failed'].includes(task.state),45000);}catch{throw new Error('Browser plugins did not settle: '+pageErrors.join(' | ').slice(-2500));}
  assert.equal(task.state,'check-ready',task.error||pageErrors.join(' | '));
  assert.ok(task.presetRoster?.ids?.includes('standard'),`Standard preset was not registered: ${JSON.stringify(task.presetRoster)}`);
  const visibleText=await workerPage.locator('body').innerText();
  assert.ok(!/Failed to load plugins|web boot:.*did not activate/i.test(visibleText),'Official Web UI is showing a plugin boot failure: '+visibleText.slice(-1000));
  await fs.mkdir(path.join(stateDir,'screenshots'),{recursive:true});
  await workerPage.screenshot({path:path.join(stateDir,'screenshots','worker-ready.png')});
  const routerPage=await context.newPage();
  await routerPage.goto(`${origin}/#token=${access.token}`,{waitUntil:'networkidle'});
  await routerPage.screenshot({path:path.join(stateDir,'screenshots','router-ready.png')});
  assert.equal(task.sessionId,undefined);
  console.log(`Installed DSH worker: private PID ${task.child.pid}, filtered profile ${task.report.workerRootRows}/${task.report.sourceRootRows} root rows, Host ready; preset roster ${task.presetRoster.ids.join(',')}; check-only handoff passed.`);
  await fs.writeFile(path.join(stateDir,selected.length?'last-smoke-selected.json':'last-smoke.json'),JSON.stringify({date:new Date().toISOString(),dshVersion:snapshot.dshVersion,routerRootRows:12,sourceRootRows:task.report.sourceRootRows,workerRootRows:task.report.workerRootRows,selectedCapabilities:task.selection,modelRequests:0,assistantPrompts:0,hostReady:true,clientGraphContainsBridge:true,browserPluginsSettled:true,noBootErrorPage:true},null,2));
}finally{await browser?.close();await manager.close();await stopOwnedChild(router);}
