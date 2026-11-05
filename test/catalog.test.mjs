import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCatalog, resolveSelection, selectRows } from '../src/catalog.mjs';
import { copyModelState, parseYaml, dumpYaml, isolatePaths, taskPresetRows } from '../src/profile.mjs';

const rows = [
  {id:'session',name:'@deepseek-ai/dsh-session'},
  {id:'ui-sidebar-documentpreview',name:'@deepseek-ai/dsh-client-ui-sidebar-documentpreview'},
  {id:'ui-sidebar-files',name:'@deepseek-ai/dsh-client-ui-sidebar-files'},
  {id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs',disabled:true},
  {id:'standard',name:'@deepseek-ai/dsh-agent-preset',config:{plugins:[{id:'tool-fs',name:'@deepseek-ai/dsh-tool-fs'},{id:'tool-web',name:'@deepseek-ai/dsh-tool-web'}]}},
  {id:'outside',name:'my-installed-plugin',disabled:true}
];
test('selection prunes Host and nested preset rows; source stays intact', () => {
  const catalog = buildCatalog(rows);
  const result = selectRows(rows,catalog,[]);
  assert.deepEqual(result.map(x=>x.id),['session','standard']);
  assert.deepEqual(result[1].config.plugins,[]);
  assert.equal(rows[4].config.plugins.length,2);
});
test('documents includes required file capability, retains tool scope and enables UI',()=>{
  const catalog=buildCatalog(rows), selection=resolveSelection(catalog,['documents']);
  assert.deepEqual(selection,['files','documents']);
  const result=selectRows(rows,catalog,selection);
  assert.equal(result.find(x=>x.id==='tool-fs').disabled,true);
  assert.equal(result.find(x=>x.id==='ui-sidebar-documentpreview').disabled,false);
  assert.deepEqual(result.find(x=>x.id==='standard').config.plugins.map(x=>x.id),['tool-fs']);
});
test('unknown IDs, cycles and duplicate declarations are rejected',()=>{
  assert.throws(()=>resolveSelection(buildCatalog(rows),['made-up']),/Unknown/);
  assert.throws(()=>resolveSelection([{id:'a',requires:['b']},{id:'b',requires:['a']}],['a']),/Cyclic/);
  assert.throws(()=>buildCatalog(rows,[{id:'files',rows:[]}]),/Duplicate/);
  assert.throws(()=>buildCatalog(rows,[{id:'custom-a',rows:['session'],requires:['custom-b']},{id:'custom-b',rows:['outside'],requires:['custom-a']}]),/Cyclic/);
});
test('installed external plugin code is only included after selection',()=>{
  const catalog=buildCatalog(rows), item=catalog.find(x=>x.title==='my-installed-plugin');
  assert.ok(item);
  assert.equal(selectRows(rows,catalog,[item.id]).find(x=>x.id==='outside').disabled,false);
});
test('DSH expression roundtrip is inert and preserves executable syntax',()=>{
  const source="- id: p\n  name: p\n  disabled: !!js process.platform !== 'win32'\n";
  const parsed=parseYaml(source); assert.equal(typeof parsed[0].disabled,'object');
  assert.deepEqual(parseYaml(dumpYaml(parsed)),parsed);
});
test('absolute/file installed plugins cannot silently remain in the core',()=>{
  for(const name of ['file:///missing/local-plugin/index.mjs', process.platform==='win32'?'E:\\missing\\plugin\\index.mjs':'/missing/plugin/index.mjs']){
    const source=[{id:'local',name}];const catalog=buildCatalog(source);
    assert.equal(catalog.length,1);assert.deepEqual(selectRows(source,catalog,[]),[]);
  }
});
test('custom unknown dependency is refused rather than discarded',()=>{
  assert.throws(()=>buildCatalog(rows,[{id:'custom',rows:['session'],requires:['typo']}]),/dependency/i);
});

test('a configured model provider is infrastructure before the planner can select capabilities',()=>{
  const source=[{id:'llm',name:'@deepseek-ai/dsh-llm'},{id:'our-free-model',name:'dsh-our-free-model'},{id:'office',name:'my-office'}];
  const catalog=buildCatalog(source,[],['our-free-model']);
  assert.ok(!catalog.some(item=>item.rows.includes('our-free-model')));
  assert.ok(selectRows(source,catalog,[]).some(row=>row.id==='our-free-model'));
  assert.ok(!selectRows(source,catalog,[]).some(row=>row.id==='office'));
});
test('ordinary array configuration is not interpreted as a Loader subtree',()=>{
  const source=[{id:'session',name:'@deepseek-ai/dsh-session',config:[{id:'tool-web',name:'business data'}]}];
  assert.deepEqual(selectRows(source,buildCatalog(source),[]),source);
});
test('explicit credential, storage and persistence roots are isolated',()=>{
  const home=process.platform==='win32'?'C:\\test\\source':'/test/source';
  const target=process.platform==='win32'?'E:\\test\\worker':'/test/worker';
  const rows=[{id:'creds',name:'file:///modules/dsh-credentials-local/lib/index.js',config:{path:home+'/.credentials.yaml'}},{id:'persist',name:'file:///modules/dsh-session-persistence-jsonl/lib/index.js',config:{root:'/outside/sessions'}},{id:'store',name:'file:///modules/dsh-storage-json/lib/index.js',config:{root:'/outside/storage'}}];
  const isolated=isolatePaths(rows,home,target);
  assert.ok(isolated[0].config.path.startsWith(target));assert.ok(isolated[1].config.root.startsWith(target));assert.ok(isolated[2].config.root.startsWith(target));
  assert.equal(rows[1].config.root,'/outside/sessions');
});

test('worker receives only public our-free-model catalog state',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dsh-task-runtime-'));
  const source=path.join(root,'source'),target=path.join(root,'target');
  try{
    await fs.mkdir(path.join(source,'our-free-model'),{recursive:true});
    await fs.writeFile(path.join(source,'our-free-model','settings.json'),JSON.stringify({enabled:true,distribution:'managed',forward:{token:'must-not-copy'}}));
    await fs.writeFile(path.join(source,'our-free-model','catalog.json'),'{"entries":["kilo-auto/free"]}');
    await fs.writeFile(path.join(source,'our-free-model','availability.json'),'{"results":{}}');
    await fs.writeFile(path.join(source,'our-free-model','private.json'),'secret');
    await copyModelState(source,target);
    const settings=JSON.parse(await fs.readFile(path.join(target,'our-free-model','settings.json'),'utf8'));
    assert.deepEqual(settings,{enabled:true,distribution:'managed'});
    assert.equal(await fs.readFile(path.join(target,'our-free-model','catalog.json'),'utf8'),'{"entries":["kilo-auto/free"]}');
    assert.equal(await fs.readFile(path.join(target,'our-free-model','availability.json'),'utf8'),'{"results":{}}');
    await assert.rejects(fs.access(path.join(target,'our-free-model','private.json')));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('task preset uses Standard regardless of source default and enables selected nested tools',()=>{
  const source=[{id:'agent-preset-registry',name:'@deepseek-ai/dsh-agent-preset-registry',config:{default:'minimal'}},
    {id:'preset-standard',name:'@deepseek-ai/dsh-agent-preset',inject:['biliBasicCompactionPolicy'],config:{id:'standard',plugins:[{id:'delegation',name:'cordis:group',group:true,config:[{id:'tool-subagent',name:'@deepseek-ai/dsh-tool-subagent',disabled:true}]}]}},
    {id:'preset-minimal',name:'@deepseek-ai/dsh-agent-preset',config:{id:'minimal',plugins:[]}}];
  const result=taskPresetRows(source,new Set(['delegation','tool-subagent']));
  assert.equal(result.rows.length,2);assert.equal(result.rows[0].config.default,'standard');
  assert.equal(result.rows[1].config.id,'standard');
  assert.equal(result.rows[1].inject,undefined);
  assert.equal(result.rows[1].config.plugins[0].config[0].disabled,false);
  assert.deepEqual(result.scopeIds,['tool-subagent']);
  assert.equal(source[1].config.plugins[0].config[0].disabled,true);
});
