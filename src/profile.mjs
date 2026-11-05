import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { selectRows, walkRows } from './catalog.mjs';

// Do not evaluate DSH !!js while inspecting configuration.
const jsType = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => ({ __dshExpression: value }), predicate: value => value && typeof value.__dshExpression === 'string' && Object.keys(value).length === 1, represent: value => value.__dshExpression });
export const yamlSchema = yaml.DEFAULT_SCHEMA.extend([jsType]);
export const parseYaml = text => yaml.load(text, { schema: yamlSchema });
export const dumpYaml = value => yaml.dump(value, { schema: yamlSchema, noRefs: true, lineWidth: -1 });

export async function privateWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { mode: 0o600 });
}

export function resolveModules(rows, sourceAnchor, dshAnchor) {
  const source = createRequire(sourceAnchor), installation = createRequire(dshAnchor);
  const cloned = structuredClone(rows);
  walkRows(cloned, row => {
    if (row.name.startsWith('cordis:') || row.name.startsWith('file:')) return;
    // A profile can contain hoisted/symlinked copies of DSH itself. Always
    // resolve in-box packages against the running installation first, exactly
    // as the product launcher does, to avoid mixed Cordis service identities.
    const resolvers=row.name.startsWith('@deepseek-ai/')?[installation,source]:[source,installation];
    let resolved;
    for(const resolver of resolvers){try{resolved=resolver.resolve(row.name);break;}catch{}}
    if(!resolved)throw new Error(`Cannot resolve installed plugin ${row.id}: ${row.name}`);
    row.name=pathToFileURL(resolved).href;
  });
  return cloned;
}

export async function copyModelState(sourceHome, targetHome) {
  for (const name of ['settings.yaml', '.credentials.yaml']) {
    let text;
    try { text = await fs.readFile(path.join(sourceHome, name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (name === '.credentials.yaml') {
      const document = yaml.load(text);
      if (document?.records) delete document.records['client-connection/browser-session'];
      text = yaml.dump(document, { noRefs: true });
    }
    await privateWrite(path.join(targetHome, name), text);
  }
  const freeModelHome=path.join(sourceHome,'our-free-model');
  try{
    const settings=JSON.parse(await fs.readFile(path.join(freeModelHome,'settings.json'),'utf8'));
    const safeSettings=Object.fromEntries(['enabled','distribution','announcementAck','notifyOs','updateCheckHours','autoReloadWatch','probeIntervalMinutes','defaultMaxTokens'].filter(key=>settings[key]!==undefined).map(key=>[key,settings[key]]));
    await privateWrite(path.join(targetHome,'our-free-model','settings.json'),JSON.stringify(safeSettings));
  }catch(error){if(error.code!=='ENOENT')throw error;}
  for(const name of ['catalog.json','availability.json']){
    try{await privateWrite(path.join(targetHome,'our-free-model',name),await fs.readFile(path.join(freeModelHome,name)));}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

export function isolatePaths(rows,sourceHome,targetHome){
  const source=path.resolve(sourceHome),target=path.resolve(targetHome);
  const rebase=value=>{
    if(Array.isArray(value))return value.map(rebase);
    if(value&&typeof value==='object'){
      if(value.__dshExpression){if(value.__dshExpression.includes(source)||value.__dshExpression.includes(source.replaceAll('\\','/')))throw new Error('源路径表达式不能安全隔离，请改用 dshHomePath()。');return value;}
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,rebase(item)]));
    }
    if(typeof value==='string' && path.isAbsolute(value)){
      const relative=path.relative(source,value);
      if(relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))return path.join(target,relative);
    }
    return value;
  };
  const cloned=structuredClone(rows);
  walkRows(cloned,row=>{
    if(row.config!==undefined)row.config=rebase(row.config);
    if(String(row.name).includes('/dsh-credentials-local/'))row.config={...row.config,path:path.join(target,'.credentials.yaml'),dshHome:target,watch:false};
    if(String(row.name).includes('/dsh-session-persistence-jsonl/'))row.config={...row.config,root:path.join(target,'sessions')};
    if(String(row.name).includes('/dsh-storage-json/'))row.config={...row.config,root:path.join(target,'storages')};
    if(String(row.name).includes('/dsh-attachment-local/'))row.config={...row.config,dshHome:target};
  });
  return cloned;
}

export async function writeProfile(home, name, rows) {
  if (!/^[a-z][a-z0-9-]+$/.test(name)) throw new Error('Invalid managed profile name');
  const dir = path.join(home, 'profiles', name);
  await privateWrite(path.join(dir, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: [] } } }, null, 2));
  await privateWrite(path.join(dir, 'cordis.yml'), '[]\n');
  await privateWrite(path.join(dir, 'cordis.patch.yml'), dumpYaml([{ insert: rows }]));
  return dir;
}

export function taskPresetRows(rows,selectedIds){
  const presets=rows.filter(row=>String(row.name).includes('dsh-agent-preset')&&Array.isArray(row.config?.plugins));
  const standard=presets.find(row=>row.config.id==='standard');
  if(!standard)throw new Error('源 Web profile 缺少 Standard preset，不能安全生成任务 preset。');
  // Keep the source Standard identity: SessionController validates preset IDs
  // before composing the scope. Replace its rows, not its public identity.
  const task=structuredClone(standard);
  // Desktop patches may override the preset plugin's static `agentPresets`
  // injection with a service supplied only by the full desktop composition.
  // That leaves the isolated registry empty; the preset's static injection is
  // sufficient for task workers and remains in effect when this option is absent.
  delete task.inject;
  const seen=new Set(task.config.plugins.map(row=>row.id));
  for(const preset of presets)for(const row of preset.config.plugins)if(selectedIds.has(row.id)&&!seen.has(row.id)){task.config.plugins.push(structuredClone(row));seen.add(row.id);}
  const scopeIds=[];
  walkRows(task.config.plugins,row=>{
    if(!selectedIds.has(row.id))return;
    if(typeof row.disabled==='boolean')row.disabled=false;
    if(row.group===true||row.name==='cordis:group')return;
    const expression=row.disabled?.__dshExpression;
    if(expression===`process.platform === 'win32'`&&process.platform==='win32')return;
    if(expression===`process.platform !== 'win32'`&&process.platform!=='win32')return;
    scopeIds.push(row.id);
  });
  return {rows:rows.filter(row=>!presets.includes(row)).map(row=>row.id==='agent-preset-registry'?{...row,config:{...row.config,default:'standard'}}:row).concat(task),scopeIds};
}

const ROUTER_CORE = new Set(['llm','deepseek-llm-api-extensions','authorization','deepseek-account','credentials','llm-pi-ai','llm-deepseek','llm-deepseek-account','settings','config-editor','agent-default-model']);
export function routerRows(snapshot, config, hostModule) {
  const rows = snapshot.rows.filter(row => ROUTER_CORE.has(row.id)||(snapshot.infrastructureIds||[]).includes(row.id));
  rows.push({ id: 'task-runtime-router', name: pathToFileURL(hostModule).href, config });
  return isolatePaths(resolveModules(rows, snapshot.sourceAnchor, snapshot.dshAnchor),snapshot.sourceHome,path.join(config.stateDir,'router'));
}

export async function workerProfile(snapshot, catalog, selection, home, bridgeModule, taskFile) {
  const filtered = selectRows(snapshot.rows, catalog, selection);
  // Avoid automatic profile-wide mutation and watcher races in task runtimes.
  const withoutRouter = filtered.filter(row => !['hmr','task-runtime','task-runtime-router'].includes(row.id));
  const selectedIds=new Set(catalog.filter(item=>selection.includes(item.id)).flatMap(item=>item.rows));
  const scoped=taskPresetRows(withoutRouter,selectedIds);
  const rows = isolatePaths(resolveModules(scoped.rows, snapshot.sourceAnchor, snapshot.dshAnchor),snapshot.sourceHome,home);
  rows.push({ id: 'task-runtime-worker', name: pathToFileURL(bridgeModule).href, config: { taskFile, selectedHostIds:rows.filter(row=>selectedIds.has(row.id)).map(row=>row.id), selectedScopeIds:scoped.scopeIds, selectedIds:[...selectedIds] } });
  await writeProfile(home, 'task-worker', rows);
  const report = { sourceRootRows: snapshot.rows.length, workerRootRows: rows.length, selectedCapabilities: selection, retainedRows: [] };
  walkRows(rows, row => report.retainedRows.push({ id: row.id, name: row.name, disabled: row.disabled === true }));
  await privateWrite(path.join(home, 'composition-report.json'), JSON.stringify(report, null, 2));
  return report;
}
