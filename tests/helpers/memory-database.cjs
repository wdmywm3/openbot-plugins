const assert = require('node:assert/strict');
function memoryDatabase(ctx) {
  let records = new Map(), revision = 0;
  const scopeKey = input => JSON.stringify([input.name || '', input.scope || 'chat', input.scope === 'channel' ? '' : input.chatId || ctx?.message?.chatId || '', input.collection]);
  const run = input => {
    const prefix = scopeKey(input), key = prefix + ':' + input.key, prior = records.get(key);
    if (input.action === 'get') return {record:structuredClone(prior || null)};
    if (input.action === 'query') {
      let all = [...records.entries()].filter(([key,row])=>key.startsWith(prefix+':') && (!input.prefix || row.key.startsWith(input.prefix))
        && Object.entries(input.where || {}).every(([field,value])=>row.value[field]===value)).map(([,row])=>row).sort((a,b)=>b.updatedAt-a.updatedAt||a.key.localeCompare(b.key));
      const offset = input.cursor ? all.findIndex(row=>row.key===input.cursor)+1 : 0, limit = Math.min(50,input.limit||10), rows=all.slice(offset,offset+limit);
      return {records:structuredClone(rows),nextCursor:offset+rows.length<all.length?rows.at(-1).key:null};
    }
    assert.equal(input.expectedRevision,prior?.revision||0,'revision conflict');
    if(input.action==='delete'){records.delete(key);return{ok:true};}
    assert.equal(input.action,'put');assert.ok(Buffer.byteLength(JSON.stringify(input.value))<=128*1024);
    const record={key:input.key,value:structuredClone(input.value),revision:++revision,updatedAt:revision};records.set(key,record);return{ok:true,record:structuredClone(record)};
  };
  const database = async input => {
    if(input.action!=='batch')return run(input);
    const before=new Map(records),oldRevision=revision;
    try{return{ok:true,results:input.operations.map(operation=>run({...input,...operation}))};}
    catch(error){records=before;revision=oldRevision;throw error;}
  };
  if(ctx)ctx.api.database=database;
  return database;
}
module.exports={memoryDatabase};
