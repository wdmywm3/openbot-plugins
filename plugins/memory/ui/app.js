"use strict";
const api=window.openbotPlugin,$=id=>document.getElementById(id),runsOnly=api.getContext().viewId==='runs';
const states={running:'整理中',completed:'已完成',interrupted:'已中断',paused:'已暂停',failed:'失败',rolled_back:'已回滚',rollback_pending:'回滚待处理'};
let chatId=api.getContext().chatId||'',snapshot,nextOffset=null,generation=0,revision=0,savedRevision=0,saveTimer,savePromise,loading=0,failed=false,styleChat=null;
const call=(action,input={})=>api.callAction(action,{...input,chatId});
let chatListPromise;
async function loadChats(){if(chatListPromise)return chatListPromise;chatListPromise=(async()=>{const rows=new Map();let offset=0;do{const result=await call('list',{chatsOnly:true,chatOffset:offset});for(const row of result.chats||[])rows.set(row.chatId,row);offset=result.chatsNextOffset??null;if(chatId&&!rows.has(chatId))rows.set(chatId,{chatId});$('chat').replaceChildren(option('',runsOnly?'选择聊天':'实例默认'),...[...rows.values()].map(row=>option(row.chatId,row.name||row.chatId)));$('chat').value=chatId;}while(offset!==null);})().finally(()=>{chatListPromise=null;});return chatListPromise;}
let maintenanceNextOffset=null,followupsNextOffset=null,pagesExpanded=false;
const maintenanceMore=document.createElement('button'),followupsMore=document.createElement('button');
maintenanceMore.type=followupsMore.type='button';maintenanceMore.textContent=followupsMore.textContent='加载更多';
maintenanceMore.hidden=followupsMore.hidden=true;$('maintenance').append(maintenanceMore);$('followups').append(followupsMore);
function renderFollowups(result,append=false){
 if(!append)$('followup-items').replaceChildren();
 for(const followup of result.followups||[]){const row=document.createElement('p');row.textContent=followup.completed?followup.notified?'复查完成，已提交待通知内容':'复查完成，无需通知':followup.paused?'复查已暂停':'等待复查';if(followup.paused&&!followup.canceled&&!followup.completed&&followup.recordRevision)row.append(button(followup.recoveryRequired?'已核对，恢复复查':'恢复复查',async()=>{await call('manage',{action:'resumeFollowup',id:followup.memoryId,revision:followup.recordRevision,reconciled:!!followup.recoveryRequired});await refresh();}));$('followup-items').append(row);}
 followupsNextOffset=result.followupsNextOffset??null;followupsMore.hidden=followupsNextOffset===null;$('followups').hidden=!$('followup-items').childElementCount&&followupsMore.hidden;
}
function renderMaintenance(result,append=false){
 if(!append)$('maintenance-items').replaceChildren();
 for(const proposal of result.maintenance||[]){const row=document.createElement('div'),reason=document.createElement('p'),actions=document.createElement('div');reason.textContent=proposal.reason;actions.className='maintenance-actions';actions.append(button(proposal.target==='long_term'?'长期保留':'归档',async()=>{await call('manage',{action:'applyMaintenance',id:proposal.proposalId});await refresh();}),button('忽略',async()=>{await call('manage',{action:'dismissMaintenance',id:proposal.proposalId});await refresh();}));row.append(reason,actions);$('maintenance-items').append(row);}
 maintenanceNextOffset=result.maintenanceNextOffset??null;maintenanceMore.hidden=maintenanceNextOffset===null;$('maintenance').hidden=!$('maintenance-items').childElementCount&&maintenanceMore.hidden;
}
function moreSection(control,section){control.onclick=()=>task(async()=>{control.disabled=true;const current=generation;pagesExpanded=true;loading++;try{const result=await call('list',{includeChats:false,...(section==='maintenance'?{maintenanceOffset:maintenanceNextOffset}:{followupOffset:followupsNextOffset})});if(current!==generation)return;if(section==='maintenance')renderMaintenance(result,true);else renderFollowups(result,true);}finally{control.disabled=false;}});}
moreSection(maintenanceMore,'maintenance');moreSection(followupsMore,'followups');
function error(cause){$("error").hidden=!cause;$("error").textContent=cause?.message||String(cause||'');}
async function task(work,clear=true){if(clear)error('');try{await work();}catch(cause){error(cause);}}
function button(label,handler){const el=document.createElement('button');el.type='button';el.textContent=label;el.onclick=()=>task(handler);return el;}
function option(value,label){const el=document.createElement('option');el.value=value;el.textContent=label;return el;}
function dependentFields(){$("enabled-fields").hidden=$("enabled").getAttribute('aria-checked')!=='true';$("daily-time").hidden=$("schedule").value!=='daily';$("policy-fields").disabled=!!chatId&&$("inherit").value==='inherit';}
function renderSettings(){const config=snapshot.settings;$("inherit-label").hidden=!chatId;$("inherit").value=snapshot.inherited?'inherit':'override';$("enabled").setAttribute('aria-checked',String(config.enabled));$("schedule").value=config.schedule||'daily';$("daily-time").value=config.dailyTime||'03:00';$("idle").value=String(config.idleMinutes||0);$("advanced").hidden=!chatId;$("style").hidden=!chatId.includes(':private:');$("style-lock").checked=!!snapshot.styleLocked;
 if(styleChat!==chatId){styleChat=chatId;const fields={length:['长度',{brief:'简短',balanced:'按问题安排',detailed:'适当展开'}],tone:['语气',{calm:'平和',warm:'亲切',lively:'活泼'}],formality:['表达方式',{casual:'随意',neutral:'自然',formal:'正式'}],humor:['幽默',{little:'少开玩笑',moderate:'适度幽默'}]};$("style-fields").replaceChildren();for(const [key,[label,choices]]of Object.entries(fields)){const wrap=document.createElement('label'),select=document.createElement('select');wrap.className='field';wrap.append(label);select.dataset.key=key;select.append(option('','未指定'),...Object.entries(choices).map(([v,n])=>option(v,n)));select.value=snapshot.style?.[key]||'';wrap.append(select);$("style-fields").append(wrap);}}
 $("scan-start").hidden=!snapshot.checkpoint?.start;$("scan-start").textContent=snapshot.checkpoint?.start?'整理起点更新于 '+new Date(snapshot.checkpoint.start.at).toLocaleString():'';dependentFields();
}
async function refresh(append=false){if(append)pagesExpanded=true;const current=generation,request=++loading,result=await call('list',{includeChats:false,offset:append?nextOffset:0});if(current!==generation||request!==loading)return;snapshot=result;pagesExpanded=append;$("chat").value=chatId;
 if(revision===savedRevision&&!runsOnly)renderSettings();
 $("status").textContent=snapshot.error||(snapshot.paused?'自动整理已暂停':snapshot.busy?'正在整理…':snapshot.pending?'有未完成的整理':!chatId?'选择一个聊天后，可以查看记录或立即整理。':'');
 $("run").disabled=!chatId||snapshot.busy;$("pause").hidden=!chatId||snapshot.paused||!snapshot.settings.enabled;$("resume").hidden=!chatId||!snapshot.paused;$("stop").hidden=!snapshot.busy&&!snapshot.pending;
 if(!append)$("items").replaceChildren();for(const run of snapshot.runs?.items||[]){const row=document.createElement('div');row.className='item';row.append(button(new Date(run.createdAt).toLocaleString()+' · '+(states[run.status]||run.status)+'\n'+(run.summary||''),async()=>{await flush();if(failed)return;await api.ui.openOverlay({viewId:'details',input:{chatId,runId:run.id}});await refresh();}));$("items").append(row);}
 if(!append&&chatId&&!snapshot.runs?.items?.length)$("items").textContent='暂无整理记录';nextOffset=snapshot.runs?.nextOffset??null;$("more").hidden=nextOffset===null;
 if(!append){renderFollowups(snapshot);renderMaintenance(snapshot);}
}
function draft(){const enabled=$("enabled").getAttribute('aria-checked')==='true',schedule=$("schedule").value,dailyTime=$("daily-time").value;if(enabled&&schedule==='daily'&&!dailyTime)throw Error('请选择每天的整理时间');return {action:'settings',inherit:!!chatId&&$("inherit").value==='inherit',settings:{enabled,schedule,dailyTime:dailyTime||'03:00',idleMinutes:Number($("idle").value)}};}
async function flush(){clearTimeout(saveTimer);if(savePromise)return savePromise;if(revision===savedRevision)return;
 savePromise=(async()=>{while(revision!==savedRevision){const current=revision,scope=chatId;try{$("save-status").textContent='正在保存…';await call('manage',draft());if(!$("style").hidden)await call('manage',{action:'style',locked:$("style-lock").checked,values:Object.fromEntries([...$("style-fields").querySelectorAll('select')].filter(el=>el.value).map(el=>[el.dataset.key,el.value]))});if(scope!==chatId)return;savedRevision=current;failed=false;$("retry-save").hidden=true;error('');}catch(cause){failed=true;$("retry-save").hidden=false;$("save-status").textContent='未保存';error(cause);return;}}
 api.ui.setDirty(false);$("save-status").textContent='已保存';await refresh();})().finally(()=>{savePromise=null;});return savePromise;
}
function edited(){revision++;api.ui.setDirty(true);dependentFields();$("save-status").textContent='';if(!failed){clearTimeout(saveTimer);saveTimer=setTimeout(flush,500);}}
$("enabled").onclick=()=>{$("enabled").setAttribute('aria-checked',String($("enabled").getAttribute('aria-checked')!=='true'));edited();};
$("preferences").addEventListener('change',event=>{if(event.target.matches('input,select'))edited();});
$("retry-save").onclick=()=>{failed=false;void flush();};
async function selectScope(next,publish=true){await flush();if(revision!==savedRevision&&!await api.ui.confirm({title:'放弃修改',message:'当前修改尚未保存，切换聊天会丢失这次修改。',confirmLabel:'放弃修改'})){$("chat").value=chatId;return;}chatId=next;generation++;revision=savedRevision=0;failed=false;styleChat=null;api.ui.setDirty(false);$("save-status").textContent='';$("retry-save").hidden=true;if(publish)api.ui.setContext({chatId});await refresh();}
$("chat").onchange=()=>task(()=>selectScope($("chat").value));api.ui.onContextChange(value=>{if((value.chatId||'')!==chatId)task(()=>selectScope(value.chatId||'',false));});
for(const [id,action]of [['run','run'],['pause','pause'],['resume','resume'],['stop','stop']])$(id).onclick=()=>task(async()=>{await flush();if(failed)return;await call('manage',{action});await refresh();});
$("start-now").onclick=()=>task(async()=>{await flush();if(failed)return;if(!await api.ui.confirm({title:'跳过此前记录',message:'之后从当前时间开始整理，这个聊天此前尚未整理的记录将跳过。',confirmLabel:'跳过'}))return;await call('manage',{action:'startFromNow',requestKey:'checkpoint:'+Date.now()+':'+Math.random().toString(36).slice(2)});await refresh();});
$("style-reset").onclick=()=>task(async()=>{await flush();if(failed)return;await call('manage',{action:'style',values:{},locked:true});styleChat=null;await refresh();});
$("import").onclick=()=>task(async()=>{await flush();if(failed)return;const picked=await api.selectFiles({extensions:['json']});if(picked.files?.length)await call('import',{refs:picked.files.map(file=>file.ref)});await Promise.all([loadChats(),refresh()]);});
$("more").onclick=()=>task(()=>refresh(true));$("preferences").hidden=runsOnly;$("more-actions").hidden=runsOnly;
task(()=>Promise.all([loadChats(),refresh()]));setInterval(()=>{if(!document.hidden&&!savePromise&&!pagesExpanded&&revision===savedRevision)task(()=>refresh(),false);},5000);
