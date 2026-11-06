"use strict";
const api=window.openbotPlugin,$=id=>document.getElementById(id),selection=new Map();
let snapshot,offset=0,serial=0,selecting=false,exportJob="",busy=false,debounce;
const call=(action,input={})=>api.callAction(action,input);
const filters=()=>({query:$("query").value,status:$("status").value,profileId:$("profile-filter").value,chatId:$("chat-filter").value,source:$("source").value,analysis:$("analysis").value});
function error(cause){$("error").textContent=cause?.message||String(cause||"");$("error").hidden=!cause;}
async function task(work,clear=true){if(clear)error("");try{await work();}catch(cause){error(cause);}}
function button(text,handler){const el=document.createElement("button");el.type="button";el.textContent=text;el.onclick=()=>task(handler);return el;}
function options(select,rows,label){const previous=select.value;select.replaceChildren(...[{id:"",name:label},...rows].map(row=>{const option=document.createElement("option");option.value=row.id;option.textContent=row.name;return option;}));select.value=previous;}
function selectionBar(){
 $("batch").hidden=!selecting;$("selected-count").textContent=`已选 ${selection.size} 张`;
 $("page-selection").checked=!!snapshot?.items.length&&snapshot.items.every(item=>selection.has(item.id));
 $("select-all").hidden=!snapshot||snapshot.total<=snapshot.items.length;$("select-all").disabled=busy||snapshot?.total>500;
 $("select-all").title=snapshot?.total>500?"一次最多选择 500 张，请缩小筛选范围":"";
 document.querySelectorAll("[data-batch]").forEach(el=>el.disabled=busy||!selection.size);
}
function grid(){
 $("grid").replaceChildren(...snapshot.items.map(item=>{
  const tile=document.createElement("article");tile.className="tile"+(selection.has(item.id)?" selected":"");
  const open=button("",async()=>{if(selecting){selection.has(item.id)?selection.delete(item.id):selection.set(item.id,item.revision);grid();return;}await api.ui.openOverlay({viewId:"editor",input:{id:item.id},size:"lg"});await refresh();});
  const image=document.createElement("img");image.loading="lazy";image.alt=item.caption||item.name||"表情";image.src=api.assetUrl(item.assetRef);
  const caption=document.createElement("span");caption.className="caption";caption.textContent=item.meaning||item.caption||item.name||"待识别";
  open.append(image,caption);tile.append(open);
  if(item.enabled===false||item.error||item.analysisStatus!=="ready"){const state=document.createElement("span");state.className="status"+(item.error?" failure":"");state.textContent=item.enabled===false?"已停用":item.error?"处理失败":"待识别";open.append(state);}
  if(selecting){const check=document.createElement("input");check.type="checkbox";check.checked=selection.has(item.id);check.setAttribute("aria-label",`选择 ${caption.textContent}`);check.onchange=()=>{check.checked?selection.set(item.id,item.revision):selection.delete(item.id);grid();};tile.append(check);}
  return tile;
 }));
 if(!snapshot.items.length)$("grid").textContent=Object.values(filters()).some(Boolean)?"没有符合条件的表情":"还没有表情，可以导入图片。";
 selectionBar();
}
function jobs(){
 const active=snapshot.jobs.find(job=>job.status==="running")||snapshot.jobs.find(job=>job.status==="queued")||(["failed","interrupted","paused"].includes(snapshot.jobs[0]?.status)?snapshot.jobs[0]:null);
 $("progress").replaceChildren();$("progress").hidden=!active&&!exportJob;if(!active)return;
 const label=document.createElement("span"),p=active.progress||{};
 label.textContent=active.status==="failed"?active.error||"处理失败":`${active.status==="queued"?"等待处理":active.status==="running"?"正在处理":"处理已中断"}${p.total?` ${p.completed||0}/${p.total}`:""}${p.failed?`，${p.failed} 张失败`:""}`;
 $("progress").append(label,button(["running","queued"].includes(active.status)?"停止":"继续",async()=>{await (["running","queued"].includes(active.status)?call("stop"):call("job",{action:"resume",id:active.id}));await refresh();}));
}
async function refresh(){const current=++serial;try{const result=await call("list",{...filters(),offset});if(current!==serial)return;snapshot=result;
 options($("profile-filter"),snapshot.contexts.profiles,"全部角色");options($("chat-filter"),snapshot.contexts.chats,"全部聊天");
 $("sync").hidden=snapshot.capabilities.platform!=="napcat";$("summary").textContent=`${snapshot.total} 张表情`;
 $("previous").disabled=offset===0;$("next").disabled=snapshot.nextOffset==null;$("paging").hidden=snapshot.total<=48;$("page").textContent=`${Math.floor(offset/48)+1} / ${Math.max(1,Math.ceil(snapshot.total/48))}`;grid();jobs();
 if(exportJob){const job=await call("job",{action:"status",id:exportJob});if(current!==serial)return;if(job.status==="completed"){$("progress").hidden=false;$("progress").append(button("保存导出文件",async()=>{const result=await api.saveFiles(job.result.files.map(file=>file.ref));if(!result.canceled)exportJob="";await refresh();}));}}
 }catch(cause){if(current===serial)throw cause;}
}
function changed(){offset=0;selection.clear();task(refresh);}
$("query").oninput=()=>{clearTimeout(debounce);serial++;debounce=setTimeout(changed,200);};
for(const id of ["status","profile-filter","chat-filter","source","analysis"])$(id).onchange=changed;
$("filters").onclick=()=>$("extra-filters").hidden=!$("extra-filters").hidden;
$("reset").onclick=()=>{for(const id of ["query","status","profile-filter","chat-filter","source","analysis"])$(id).value="";changed();};
$("select-mode").onclick=()=>{selecting=!selecting;selection.clear();$("select-mode").textContent=selecting?"完成选择":"批量选择";grid();};
$("page-selection").onchange=event=>{snapshot.items.forEach(item=>event.target.checked?selection.set(item.id,item.revision):selection.delete(item.id));grid();};
$("select-all").onclick=()=>task(async()=>{const result=await call("selection",filters());selection.clear();result.items.forEach(item=>selection.set(item.id,item.revision));grid();});
for(const element of document.querySelectorAll("[data-batch]"))element.onclick=()=>task(async()=>{
 const operation=element.dataset.batch,items=[...selection].map(([id,revision])=>({id,revision}));if(!items.length)return;
 if(operation==="scope"){const result=await api.ui.openOverlay({viewId:"scope",input:{items}});if(result?.failed?.length)error(`部分表情未修改：\n${result.failed.map(item=>item.error).join("\n")}`);selection.clear();await refresh();return;}
 if(operation==="export"){exportJob=(await call("exportBundle",{ids:items.map(item=>item.id)})).id;await refresh();return;}
 if(operation==="remove"&&!await api.ui.confirm({title:`删除 ${items.length} 张表情`,message:"这些图片会从表情库移除。",confirmLabel:"删除",danger:true}))return;
 busy=true;selectionBar();try{const result=await call("batch",{operation,items});result.succeeded.forEach(id=>selection.delete(id));await refresh();if(result.failed.length)error(`已完成 ${result.succeeded.length} 张，${result.failed.length} 张失败：\n${result.failed.map(item=>item.error).join("\n")}`);}finally{busy=false;selectionBar();}
});
$("import").onclick=()=>task(async()=>{if(busy)return;busy=true;serial++;$("import").disabled=true;selectionBar();try{
 const chosen=await api.selectFiles({extensions:["png","jpg","jpeg","gif","webp","json"]});const files=chosen.files||[],images=files.filter(file=>file.mimeType!=="application/json"),bundles=files.filter(file=>file.mimeType==="application/json");
 if(images.length)await api.ui.openOverlay({viewId:"scope",title:"导入表情",input:{importRefs:images.map(file=>file.ref)}});
 if(bundles.length)await call("importBundle",{refs:bundles.map(file=>file.ref)});await refresh();
 }finally{busy=false;$("import").disabled=false;selectionBar();}});
$("settings").onclick=()=>task(async()=>{await api.ui.openOverlay({viewId:"preferences",size:"md"});await refresh();});
$("search-history").onclick=()=>task(()=>api.ui.openOverlay({viewId:"history"}));
$("sync").onclick=()=>task(async()=>{await call("sync");await refresh();});
$("update").onclick=()=>task(async()=>{await call("update",{requestKey:String(Date.now())});await refresh();});
$("export").onclick=()=>task(async()=>{exportJob=(await call("exportBundle")).id;await refresh();});
$("previous").onclick=()=>{offset=Math.max(0,offset-48);task(refresh);};$("next").onclick=()=>{offset=snapshot.nextOffset;task(refresh);};
task(refresh);setInterval(()=>{if(!document.hidden&&!busy)task(refresh,false);},5000);
