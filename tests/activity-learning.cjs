'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {memoryDatabase}=require('./helpers/memory-database.cjs');
const sandbox={};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../shared/activity-learning.js'),'utf8'),sandbox);
(async()=>{
 const db=memoryDatabase(), learning=sandbox.createActivityLearning(input=>db({...input,scope:'channel'}));
 const source={id:'video:p:1',kind:'video-note',url:'https://example.com/video',text:'样本只有十人，结论不能推广到所有人。'};
 const input={topic:'样本数量',understanding:'小样本结论有局限',application:'评价实验结果时检查样本规模',uncertainty:'未核对原论文',evidence:[{sourceId:source.id,quote:'样本只有十人'}]};
 const saved=await learning.write(input,[source]);assert.ok(saved.revision);
 assert.equal((await learning.retrieve('实验样本')).length,1);assert.equal((await learning.retrieve('猫咪饮食')).length,0);
 assert.equal((await learning.write(input,[source])).unchanged,true);
 await assert.rejects(learning.write({...input,evidence:[{sourceId:source.id,quote:'这不是原文'}]},[source]),/引文/);
 await assert.rejects(learning.write({...input,understanding:'修订'},[source]),/当前版本/);
 const revised=await learning.write({...input,id:saved.id,expectedRevision:saved.revision,understanding:'已核对样本限制，仍需检查抽样方式'},[source]);
 assert.equal((await learning.history(saved.id)).records.length,1);
 await assert.rejects(learning.retract(saved.id,saved.revision),/版本/);
 await learning.retract(saved.id,revised.revision);assert.equal((await learning.retrieve('样本')).length,0);
 await assert.rejects(learning.write(input,[source]),/撤回/);
 assert.equal((await learning.history(saved.id)).records.length,2);
 await learning.questions([{sourceId:source.id,question:'样本如何选取？'},{sourceId:'invented',question:'无来源'}],[source]);
 await learning.questions([{sourceId:source.id,question:'样本如何选取？'}],[source]);
 const questions=await learning.pending();assert.equal(questions.length,1);
 await learning.resolve(questions[0].id,'使用自愿报名的样本',source.id);assert.equal((await learning.pending()).length,0);
 const privateLearning=sandbox.createActivityLearning(input=>db({...input,scope:'chat',chatId:'owner'}));
 await privateLearning.write({...input,topic:'私人的实验样本'},[source]);assert.equal((await learning.retrieve('实验')).length,0);
 await assert.rejects(privateLearning.tool({action:'retract',id:saved.id},false,()=>source),/主人/);
 // A failed CAS rolls back the archived row as well as the current record.
 const active=await privateLearning.retrieve('实验'),row=active[0];
 const racing=sandbox.createActivityLearning(async request=>{
   if(request.action==='batch'){const current=(await db({scope:'chat',chatId:'owner',collection:'lessons',action:'get',key:row.id})).record;
     await db({scope:'chat',chatId:'owner',collection:'lessons',action:'put',key:row.id,expectedRevision:current.revision,value:current.value});}
   return db({...request,scope:'chat',chatId:'owner'});
 });
 await assert.rejects(racing.write({...input,topic:row.topic,id:row.id,expectedRevision:row.revision,understanding:'并发修改'},[source]),/revision conflict/);
 assert.equal((await privateLearning.history(row.id)).records.length,0);
 console.log('Activity learning: grounded quotes, relevance, revisions, retraction, pending questions, scope isolation and atomic rollback passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
