import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Capability groups intentionally leave shared registries/services in the core.
// IDs, not model-generated modules or YAML, are the selection boundary.
const groups = [
  ['files', '文件读写和检索', '读取、修改工作区文件，搜索文件内容，浏览文件树。', ['tool-fs','tool-fs-search','ui-sidebar-files']],
  ['documents', '文档与图片预览', '在侧栏预览 PDF、Office、Markdown、代码和图片。', ['ui-sidebar-documentpreview','office-to-pdf'], ['files']],
  ['shell', '终端与命令执行', '运行 PowerShell/bash 命令，打开交互式终端。', ['tool-bash','tool-pwsh','persistent-bash','persistent-pwsh','terminal-bash','terminal-pwsh','terminal-controller','ui-sidebar-terminal','ui-settings-shell']],
  ['web', '联网搜索和网页读取', '联网搜索资料、读取网页内容。', ['web-fetch-http','web-search-deepseek','tool-web','ui-settings-web-search']],
  ['skills', '技能目录', '发现并加载已安装的 skills。', ['skill-filesystem','tool-skill','ui-skill']],
  ['subagents', '子智能体协作', '委派、管理、查看子智能体任务。', ['delegation','tool-subagent','tool-subagent-fork','tool-subagent-control','tool-subagent-list-agents','ui-subagent','ui-settings-subagent']],
  ['schedule', '定时任务', '创建和查看定时任务。', ['tool-schedule','ui-schedule']],
  ['planning', '任务规划', '规划任务、维护待办和目标。', ['tool-todo','tool-goal','command-goal','ui-goal','ui-plan']],
  ['workflow', '工作流', '使用程序化工作流并查看运行过程。', ['workflow-ptc','tool-workflow','tool-ralph','ui-workflow-run'], ['subagents']],
  ['developer', '插件开发与检查', '检查 Cordis 插件和服务，使用插件管理工具。', ['tool-cordis','ui-cordis','tool-plugin-manager','tool-plugin-market']]
];

export function childrenOf(row) {
  if ((row.group===true || row.name==='cordis:group') && Array.isArray(row.config)) return row.config;
  return String(row.name).includes('dsh-agent-preset') && Array.isArray(row.config?.plugins) ? row.config.plugins : [];
}

export function owningPackage(spec) {
  let file;
  try{file=spec.startsWith('file:')?fileURLToPath(spec):path.isAbsolute(spec)?spec:null;}catch{return null;}
  if(!file)return null;
  let dir=path.dirname(file);
  for(;;){try{return JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));}catch{}const parent=path.dirname(dir);if(parent===dir)return null;dir=parent;}
}

export function walkRows(rows, visit) {
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !row.id || !row.name) continue;
    visit(row);
    walkRows(childrenOf(row), visit);
  }
}

function packageName(spec) {
  if (typeof spec !== 'string') return null;
  if (spec.startsWith('file:') || spec.startsWith('.') || path.isAbsolute(spec) || /^[A-Za-z]:/.test(spec)) return owningPackage(spec)?.name || 'local-plugin';
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

export function buildCatalog(rows, extensions = [], infrastructureIds = []) {
  const all = [];
  walkRows(rows, row => {if(!infrastructureIds.includes(row.id))all.push(row);});
  const ids = new Set(all.map(row => row.id));
  const catalog = groups.map(([id, title, description, members, requires = []]) => ({ id, title, description, rows: members.filter(x => ids.has(x)), requires }))
    .filter(item => item.rows.length);
  const owned = new Set(catalog.flatMap(item => item.rows));
  // Explicit extension declarations take precedence; shared deps use requires.
  for (const extension of extensions) {
    if (!extension || !/^[a-z][a-z0-9-]{0,70}$/.test(extension.id) || !Array.isArray(extension.rows)) throw new Error('Invalid capability declaration');
    if (catalog.some(x => x.id === extension.id)) throw new Error(`Duplicate capability: ${extension.id}`);
    if(extension.requires!==undefined && (!Array.isArray(extension.requires)||extension.requires.some(id=>typeof id!=='string')))throw new Error('Invalid capability dependency list');
    for (const id of extension.rows) {
      if (!ids.has(id) || owned.has(id)) throw new Error(`Unknown or already-owned plugin row: ${id}`);
      owned.add(id);
    }
    catalog.push({ id: extension.id, title: String(extension.title || extension.id), description: String(extension.description || '').slice(0, 500), rows: extension.rows, requires: extension.requires || [] });
  }
  // Installed non-DSH modules become optional capabilities; no import/apply.
  const external = new Map();
  for (const row of all) {
    const pkg = packageName(row.name);
    if (!pkg || pkg.startsWith('@deepseek-ai/') || pkg.startsWith('cordis:') || owned.has(row.id)) continue;
    const key = `installed-${pkg.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
    if (!external.has(key)) external.set(key, { id: key, title: pkg, description: `已安装插件 ${pkg}；能力由该插件提供。`, rows: [], requires: [] });
    if (!external.get(key).rows.includes(row.id)) external.get(key).rows.push(row.id);
  }
  catalog.push(...external.values());
  for (const item of catalog) {
    const unknown=item.requires.filter(x=>!catalog.some(y=>y.id===x));
    if(unknown.length && extensions.some(extension=>extension.id===item.id))throw new Error(`Unknown capability dependency: ${unknown.join(', ')}`);
    item.requires=item.requires.filter(x=>catalog.some(y=>y.id===x));
  }
  for(const item of catalog)resolveSelection(catalog,[item.id]);
  return catalog;
}

export function resolveSelection(catalog, requested, max = 12) {
  if (!Array.isArray(requested) || requested.length > max || requested.some(x => typeof x !== 'string')) throw new Error('Invalid plugin selection');
  const items = new Map(catalog.map(item => [item.id, item]));
  const selected = new Set(), visiting = new Set();
  function add(id) {
    if (selected.has(id)) return;
    const item = items.get(id);
    if (!item) throw new Error(`Unknown capability: ${id}`);
    if (visiting.has(id)) throw new Error(`Cyclic capability dependency: ${id}`);
    visiting.add(id);
    for (const dependency of item.requires || []) add(dependency);
    visiting.delete(id); selected.add(id);
  }
  for (const id of requested) add(id);
  return [...selected];
}

export function selectRows(rows, catalog, selected) {
  const enabled = new Set(resolveSelection(catalog, selected));
  const ownership = new Map();
  for (const capability of catalog) for (const id of capability.rows) {
    if (!ownership.has(id)) ownership.set(id, []);
    ownership.get(id).push(capability.id);
  }
  function filter(list) {
    return list.flatMap(row => {
      const owners = ownership.get(row.id);
      if (owners && !owners.some(id => enabled.has(id))) return [];
      const copy = structuredClone(row);
      const children=childrenOf(row);
      if(children.length && Array.isArray(row.config))copy.config=filter(children);
      else if(children.length)copy.config.plugins=filter(children);
      // Source-level base tool rows are often deliberately disabled because the
      // active preset owns registration. Preserve that scope distinction.
      if (owners && (row.id.startsWith('ui-') || owners.some(id => id.startsWith('installed-')))) copy.disabled = false;
      return [copy];
    });
  }
  return filter(rows);
}

export function modelCatalog(catalog) {
  return catalog.map(({ id, title, description, requires }) => ({ id, title, description, requires }));
}
