export function assertSelectedActive(entries,expectedIds,activeState){
  const list=[...entries];
  for(const id of expectedIds){
    const matches=list.filter(entry=>entry.options.id===id || entry.options.name===id);
    if(!matches.length)throw new Error(`所选插件未进入加载树：${id}`);
    for(const entry of matches){
      if(entry.disabled)continue;
      if(!entry.fiber || entry.fiber.state!==activeState)throw new Error(`所选插件未激活：${id}`);
    }
  }
}

export function assertPresetActive(inventory,expectedIds,activeState){
  const preset=inventory.find(item=>item.id==='standard');
  if(!preset)throw new Error('任务 Standard preset 未注册。');
  if(preset.broken)throw new Error(`任务 preset 挂载失败：${preset.broken}`);
  for(const id of expectedIds)if(!preset.rows.some(row=>row.entryId?.split(':').at(-1)===id&&row.enabled===true&&row.fiberState===activeState))throw new Error(`任务 preset 中所选能力未激活：${id}`);
}
