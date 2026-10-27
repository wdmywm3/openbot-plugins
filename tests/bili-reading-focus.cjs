'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const {fixture}=require('./video-analysis.cjs'),{memoryDatabase}=require('./helpers/memory-database.cjs');
const code=fs.readFileSync(path.join(__dirname,'../plugins/bilibili-explorer/index.js'),'utf8');
const sandbox={module:{exports:{}}};vm.runInNewContext(code,sandbox);
const BV='BV1234567890';
const analyze=(f,options={})=>sandbox.biliAnalyzeCommand(f.ctx,'bilianalyze',BV,options);
const focusedJob=f=>[...f.state.values()].find(value=>value?.bvid===BV&&value.stage&&value.question);
(async()=>{
 for(const value of ['', 'a','abc','a'.repeat(55),'b'.repeat(64),'b'.repeat(1000),'bvid=BV1234567890&cid=12&wts=1702204169'])
   assert.equal(sandbox.biliMd5Ascii(value),crypto.createHash('md5').update(value).digest('hex'));
 const images={img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'};
 const signed=sandbox.biliWbiSign({foo:'114',bar:'514',baz:'1919810'},images,1702204169);
 assert.equal(signed.w_rid,'6149fdadf571698ca7e6a567265cd0ee','known WBI signing vector');
 const partial=fixture({duration:120});const db=memoryDatabase(partial.ctx),oldFetch=partial.ctx.api.fetchJson;
 partial.ctx.api.fetchJson=async url=>url.includes('aisubtitle.hdslb.com')?{body:[{from:0,to:10,content:'一段字幕'},{from:90,to:95,content:'另一段'}]}:oldFetch(url);
 await analyze(partial);
 let content=(await db({name:'bilibili-history',scope:'channel',action:'get',collection:'contents',key:`${BV}:p:1`})).record.value;
 assert.deepEqual(content.coverage.map(row=>[row.start,row.end]),[[0,10],[90,95]]);assert.ok(content.coverage.every(row=>!row.complete));
 await analyze(partial,{question:'第一段说了什么',ranges:[{start:0,end:10}]});
 const note=(await db({name:'bilibili-history',scope:'chat',action:'get',collection:'notes',key:`${BV}:p:1`})).record.value;
 assert.equal(note.focused,false,'a focused answer does not replace an existing full analysis');assert.equal(note.focusedReadings.length,1);
 const focus=fixture({duration:1800});const original=focus.ctx.api.runAgent;
 focus.ctx.api.runAgent=async request=>{if(request.taskId.endsWith('-locate')){focus.models.push(request);return{text:JSON.stringify({ranges:[{start:600,end:620}]})};}return original(request);};
 await analyze(focus,{question:'十分钟处如何解释样本？'});const job=focusedJob(focus);
 assert.equal(job.stage,'completed');assert.deepEqual(job.windows,[{start:600,end:620}]);assert.match(job.summary,/600–620秒/);
 assert.ok(!focus.job(),'focused reading has an independent checkpoint');assert.equal(focus.media.length,0);
 const requestCount=focus.requests.length,callCount=focus.models.length;await analyze(focus,{question:'十分钟处如何解释样本？'});
 assert.equal(focus.requests.length,requestCount);assert.equal(focus.models.length,callCount);
 const early=fixture({duration:1800,decision:{answerComplete:true,evidence:[{start:10,end:20,claim:'已回答'}]}});
 await analyze(early,{question:'原理是什么',ranges:[{start:0,end:120},{start:1000,end:1100}]});
 assert.equal(focusedJob(early).notes.length,1);assert.ok(focusedJob(early).unreadRanges.length>0);
 const fallback=fixture({captions:false}),fallbackDb=memoryDatabase(fallback.ctx),fetch=fallback.ctx.api.fetchJson;
 fallback.ctx.config.browseUid='2';fallback.ctx.api.getSecret=async()=> 'bili_jct=test';
 fallback.ctx.api.fetchJson=async(url,options)=>{
   if(url.includes('/nav'))return{code:0,data:{isLogin:true,mid:2,wbi_img:images}};
   if(url.includes('/view?')){const response=await fetch(url,options);response.data.owner={mid:3};return response;}
   if(url.includes('/conclusion/get'))return{code:0,data:{model_result:{summary:'不能把这句话当字幕',subtitle:[{part_subtitle:[{start_timestamp:0,content:'这是实际逐句文字'},{start_timestamp:10,end_timestamp:20,content:'另一句'}]}]}}};
   return fetch(url,options);
 };
 await analyze(fallback);assert.equal(fallback.media.length,0);assert.match(fallback.job().summary,/平台补充逐句文字/);
 assert.ok(JSON.stringify(fallback.models[0].externalContent).includes('这是实际逐句文字'));assert.ok(!JSON.stringify(fallback.models).includes('不能把这句话当字幕'));
 content=(await fallbackDb({name:'bilibili-history',scope:'channel',action:'get',collection:'contents',key:`${BV}:p:1`})).record.value;
 assert.deepEqual(content.coverage.map(row=>[row.start,row.end]),[[10,20]],'unknown end times add no invented coverage');
 const summaryOnly=fixture({captions:false,decisions:{visual:{needAudio:true}}});summaryOnly.ctx.config.browseUid='2';summaryOnly.ctx.api.getSecret=fallback.ctx.api.getSecret;
 const raw=summaryOnly.ctx.api.fetchJson;summaryOnly.ctx.api.fetchJson=async(url,options)=>url.includes('/conclusion/get')?{code:0,data:{model_result:{summary:'only summary'}}}:url.includes('/nav')?{code:0,data:{isLogin:true,mid:2,wbi_img:images}}:url.includes('/view?')?{code:0,data:{title:'测试',owner:{mid:3},pages:[{cid:1,duration:40}]}}:raw(url,options);
 await analyze(summaryOnly);assert.ok(summaryOnly.media.some(input=>input.kind==='transcribe'),'a speech-dependent question still needs actual speech after preview');
 console.log('Bili reading: actual caption intervals, WBI vector, text fallback, no summary-as-transcript, focused checkpoints and early completion passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
