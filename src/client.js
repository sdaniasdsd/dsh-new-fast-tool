window.__ModuleLoader__.load({
  id:'dsh-task-runtime',
  factory:()=>{
    const inject=['uiWorkspace'];
    function apply(ctx){
      let disposed=false;
      ctx.effect(()=>()=>{disposed=true;},'task-runtime.client');
      // The complete Client tree must settle before the first task is sent.
      setTimeout(()=>{void (async()=>{
        await ctx.loader.await();
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        if(disposed)return;
        const invoke=async action=>{
          const response=await fetch(`/task-runtime/${action}`,{method:'POST',credentials:'same-origin'});
          if(!response.ok)throw new Error(`Task handoff ${action}: HTTP ${response.status}`);
          return response.json();
        };
        const expected=await invoke('expectations');
        for(const entry of ctx.loader.entries()){
          if(!entry.disabled&&entry.fiber?.state!==ctx.fiber.state){
            await invoke('failed');throw new Error(`Client plugin is inactive: ${entry.options.id}`);
          }
        }
        for(const id of expected.packages){
          const entries=[...ctx.loader.entries()].filter(entry=>entry.options.id===id||entry.options.name===id);
          if(!entries.length||entries.some(entry=>!entry.disabled&&entry.fiber?.state!==ctx.fiber.state)){
            await invoke('failed');throw new Error(`Selected client plugin is inactive: ${id}`);
          }
        }
        const prepared=await invoke('ready');
        if(prepared.checkOnly)return;
        ctx.uiWorkspace.openSession(prepared.sessionId);
        await new Promise(resolve=>requestAnimationFrame(resolve));
        if(!disposed)await invoke('begin');
      })().catch(error=>console.error('[task-runtime] 原始任务尚未交接：',error));},0);
    }
    return {inject,apply};
  }
});
