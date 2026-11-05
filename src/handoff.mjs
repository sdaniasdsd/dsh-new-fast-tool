// Kept independent of Cordis so ordering/idempotency can be checked without
// invoking a real assistant or opening a browser.
export class Handoff {
  constructor(task, controller, emit, audit=()=>{}) { Object.assign(this,{task,controller,emit,audit});this.started=false; }
  ready() {
    this.preparation ??= (async()=>{
      await this.audit(false);
      if(this.task.checkOnly){this.emit({type:'check-ready'});return {checkOnly:true};}
      const created=await this.controller.create({cwd:this.task.cwd,agentPreset:'standard'});
      this.sessionId=created.sessionId;
      await this.controller.selectModel({sessionId:this.sessionId,...this.task.route});
      await this.audit(true);
      this.emit({type:'session-created',sessionId:this.sessionId});
      return {sessionId:this.sessionId};
    })();
    return this.preparation;
  }
  begin() {
    if(!this.preparation)throw new Error('前端尚未就绪。');
    this.submission ??= (async()=>{
      const prepared=await this.preparation;
      if(prepared.checkOnly)return prepared;
      await this.audit(true);
      await this.controller.prompt({requestId:this.task.id,sessionId:this.sessionId,mode:'queue',content:[{type:'text',text:this.task.prompt}]},new AbortController().signal);
      this.started=true;this.emit({type:'submitted',sessionId:this.sessionId});return {sessionId:this.sessionId,accepted:true};
    })();
    return this.submission;
  }
}
