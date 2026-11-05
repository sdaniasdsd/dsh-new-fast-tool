import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyModelState, privateWrite, workerProfile } from './profile.mjs';
import { resolveSelection } from './catalog.mjs';

export function redact(line) {
  return String(line).replace(/([?&]token=)[^\s&"']+/gi, '$1<redacted>')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<redacted>')
    .replace(/((?:api[_-]?key|secret|authorization)\s*[:=]\s*)[^\s,}]+/gi, '$1<redacted>');
}

export async function stopOwnedChild(child, graceMs=1500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { await promisify(execFile)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
    catch { if (child.exitCode === null && child.signalCode === null) child.kill(); }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise(resolve => { const timer=setTimeout(resolve,graceMs); timer.unref(); child.once('exit',()=>{clearTimeout(timer);resolve();}); });
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  }
}

export class RuntimeManager {
  constructor({ snapshot, catalog, stateDir, bridgeModule, plan, maxRuntimes = 2, startupTimeoutMs = 90000, plannerTimeoutMs = 60000, spawnChild = spawn, stopChild = stopOwnedChild }) {
    Object.assign(this, { snapshot, catalog, stateDir, bridgeModule, plan, maxRuntimes, startupTimeoutMs, plannerTimeoutMs, spawnChild, stopChild });
    this.tasks = new Map(); this.closed = false;
  }
  public(task) {
    return { id: task.id, state: task.state, capabilities: task.selection || [], reason: task.reason || '', pid: task.child?.pid ?? null, sessionId: task.sessionId || null, error: task.error || null, createdAt: task.createdAt, presetRoster:task.presetRoster, report: task.report ? { sourceRootRows: task.report.sourceRootRows, workerRootRows: task.report.workerRootRows } : null };
  }
  list() { return [...this.tasks.values()].map(task => this.public(task)); }
  start({ prompt, cwd, route, checkOnly = false }) {
    if (this.closed) throw new Error('调度器已关闭。');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 64000) throw new Error('任务内容为空或超过 64000 字符。');
    if (!path.isAbsolute(cwd || '')) throw new Error('工作目录必须是绝对路径。');
    if ([...this.tasks.values()].filter(x => !['failed','stopped'].includes(x.state)).length >= this.maxRuntimes) throw new Error('运行中的任务已达上限，请先停止一个任务。');
    const task = { id: randomUUID(), state: 'planning', createdAt: new Date().toISOString(), abort: new AbortController(), errors: [] };
    this.tasks.set(task.id, task);
    task.work = this.launch(task, { prompt, cwd, route, checkOnly });
    return this.public(task);
  }
  async launch(task, request) {
    try {
      const stat = await fs.stat(request.cwd); if (!stat.isDirectory()) throw new Error('工作目录不是文件夹。');
      const signal = AbortSignal.any([task.abort.signal, AbortSignal.timeout(this.plannerTimeoutMs)]);
      const planned = await this.plan(request.prompt, signal);
      task.abort.signal.throwIfAborted();
      task.selection = resolveSelection(this.catalog, planned.capabilities);
      task.reason = planned.reason; task.state = 'preparing';
      const home = path.join(this.stateDir, 'tasks', task.id);
      const taskFile = path.join(home, 'handoff.json');
      await copyModelState(this.snapshot.sourceHome, home);
      await privateWrite(taskFile, JSON.stringify({ id: task.id, prompt: request.prompt, cwd: request.cwd, route: request.route, checkOnly: request.checkOnly }, null, 2));
      task.report = await workerProfile(this.snapshot, this.catalog, task.selection, home, this.bridgeModule, taskFile);
      task.abort.signal.throwIfAborted();
      task.state = 'starting';
      const child = this.spawnChild(process.execPath, [this.snapshot.dshBin, '--profile', 'task-worker', '--no-open', '--port', '0'], {
        cwd: request.cwd, env: { ...process.env, DSH_HOME: home }, stdio: ['ignore','pipe','pipe'], windowsHide: true, detached: process.platform !== 'win32'
      });
      task.child = child;
      let stdout = '', stderr = '';
      const onLine = line => {
        const url = /dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(line)?.[1];
        if (url) task.url = url;
        if (line.startsWith('DSH_TASK_EVENT ')) {
          let event; try { event = JSON.parse(line.slice(15)); } catch { return; }
          if (event.id !== task.id) return;
          if (event.type === 'host-ready') task.hostReady = true;
          if (event.type === 'session-created') task.sessionId = event.sessionId;
          if (event.type === 'preset-roster') task.presetRoster = event;
          if (event.type === 'submitted') { task.state = 'dialogue'; clearTimeout(task.timer); }
          if (event.type === 'check-ready') { task.state = 'check-ready'; clearTimeout(task.timer); }
          if (event.type === 'failed') void this.fail(task, new Error(event.message || '子进程交接失败。'));
        }
        if (task.state === 'starting' && task.hostReady && task.url) task.state = 'awaiting-ui';
        if (/error|failed|incompatible|EADDRINUSE/i.test(line)) { task.errors.push(redact(line).slice(0, 400)); if (task.errors.length > 8) task.errors.shift(); }
      };
      child.stdout.on('data', chunk => { stdout += chunk.toString(); let end; while ((end = stdout.indexOf('\n')) >= 0) { onLine(stdout.slice(0,end).replace(/\r$/, '')); stdout=stdout.slice(end+1); } if(stdout.length>1048576)stdout=stdout.slice(-8192); });
      child.stderr.on('data', chunk => { stderr += chunk.toString(); let end; while ((end=stderr.indexOf('\n'))>=0) { onLine(stderr.slice(0,end));stderr=stderr.slice(end+1); } if(stderr.length>1048576)stderr=stderr.slice(-8192); });
      child.on('error', error => void this.fail(task,error));
      child.once('exit', code => { clearTimeout(task.timer); if (!['failed','stopped'].includes(task.state)) { task.state='failed';task.error=redact(`子进程已退出 (${code})。${task.errors.join(' ')}`); } });
      task.timer = setTimeout(() => void this.fail(task,new Error(`等待子进程/前端挂载就绪超时。${task.errors.join(' ')}`)), this.startupTimeoutMs);
      task.timer.unref();
      if(task.abort.signal.aborted) await this.stop(task.id);
    } catch (error) { if(task.state!=='stopped') await this.fail(task,error); }
  }
  async fail(task, error) {
    if (['failed','stopped'].includes(task.state)) return;
    task.state='failed'; task.error=redact(error.message || String(error)); task.abort.abort(); clearTimeout(task.timer);
    await this.stopChild(task.child);
  }
  async stop(id) {
    const task=this.tasks.get(id); if(!task) throw new Error('任务不存在。');
    task.state='stopped';task.abort.abort();clearTimeout(task.timer);await this.stopChild(task.child);return this.public(task);
  }
  async close() { this.closed=true;await Promise.allSettled([...this.tasks.keys()].map(id=>this.stop(id)));await Promise.allSettled([...this.tasks.values()].map(task=>task.work)); }
}
