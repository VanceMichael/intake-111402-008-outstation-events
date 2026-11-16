import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collectEvents,confirmFragments,collect} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';

function fragment(overrides = {}) {
  return {outstation:'station1',association:'a1',unsolicited:true,sequence:0,FIR:true,FIN:true,CON:true,IIN:{},
    objects:[{index:3,value:1,time:100,flags:1}],...overrides};
}

function stubClient(items,{onRequest} = {}) {
  const queue = [...items];
  const calls = [];
  return async (path,request) => {
    calls.push({path,request});
    onRequest?.(path,request,calls);
    if (path === '/poll') return {queued:true};
    if (path === '/fragments') {
      const batch = queue.shift();
      if (!batch) return {items:[]};
      return {items:batch.filter(item => !(calls.some(call => call.path === '/confirm' && call.request.body.association === item.association && call.request.body.sequence === item.sequence)))};
    }
    if (path === '/confirm') return {confirmed:true};
    throw new Error(`unexpected ${path}`);
  };
}

test('一个响应由多个片段组成，FIR 到 FIN 之间不提前结束', async () => {
  const client = stubClient([[fragment({sequence:0,FIN:false}),fragment({sequence:1,FIR:false,FIN:true})]]);
  const result = await collectEvents(client,{commit:async () => {}});
  assert.equal(result.responses.length,1);
  assert.deepEqual(result.responses[0].sequences,[0,1]);
  assert.equal(result.responses[0].complete,true);
  assert.equal(result.incomplete.length,0);
});

test('只收到非结尾片段时声明为不完整响应', async () => {
  const client = stubClient([[fragment({sequence:7,FIR:true,FIN:false})]]);
  const result = await collectEvents(client,{commit:async () => {}});
  assert.equal(result.responses.length,0);
  assert.equal(result.incomplete.length,1);
  assert.deepEqual(result.incomplete[0].sequences,[7]);
  assert.equal(result.incomplete[0].complete,false);
});

test('缓冲溢出声明成为可见缺口，事件标志与来源时间随值保存', async () => {
  const source = await createSource({scenario:'overflow'});
  try {
    const client = createClient(source.origin);
    const result = await collectEvents(client,{commit:async () => {}});
    const gaps = result.rows.filter(row => row.kind === 'gap');
    assert.equal(gaps.length,1);
    assert.equal(gaps[0].reason,'eventBufferOverflow');
    assert.equal(gaps[0].iin.eventBufferOverflow,true);
    assert.equal(gaps[0].sequence,0);
    const events = result.rows.filter(row => row.kind === 'event');
    assert.deepEqual(events.map(row => [row.index,row.value,row.flags,row.time,row.sourceTime]),[[0,0,1,13,13],[0,0,1,14,14]]);
    assert.equal(result.responses[0].complete,true);
  } finally {await source.close();}
});

test('相同点号和值出现在不同片段时是两次真实事件', async () => {
  const client = stubClient([[
    fragment({sequence:4,objects:[{index:9,value:1,time:50,flags:1}]}),
    fragment({sequence:5,objects:[{index:9,value:1,time:51,flags:1}]}),
  ]]);
  const result = await collectEvents(client,{commit:async () => {}});
  const events = result.rows.filter(row => row.kind === 'event');
  assert.equal(events.length,2);
  assert.notEqual(events[0].id,events[1].id);
});

test('重连后重送未确认片段不重复接收，确认后远端清空', async () => {
  const source = await createSource({scenario:'overflow'});
  try {
    const client = createClient(source.origin);
    const first = await collectEvents(client);
    assert.equal(first.confirmations.length,0);
    assert.equal(first.pending.length,2);
    const rows = first.rows.map(row => JSON.stringify(row)).sort();

    // 连接重建：同一批未确认片段再次领取，内容必须与第一次一致。
    const second = await collectEvents(client,{poll:false});
    assert.deepEqual(second.rows.map(row => JSON.stringify(row)).sort(),rows);
    assert.deepEqual(second.pending,first.pending);

    await confirmFragments(client,second.pending);
    const third = await collectEvents(client,{poll:false});
    assert.equal(third.rows.length,0);
    assert.equal(third.pending.length,0);
  } finally {await source.close();}
});

test('本地可靠收件失败时不确认远端缓冲', async () => {
  const source = await createSource({scenario:'overflow'});
  try {
    const client = createClient(source.origin);
    await assert.rejects(collectEvents(client,{commit:async () => {throw new Error('disk full');}}),/disk full/);
    const audit = await client('/__audit');
    assert.equal(audit.requests.some(entry => entry.path === '/confirm'),false);
    assert.equal((await client('/fragments')).items.length,2);
  } finally {await source.close();}
});

test('收件成功后才确认，缺口随原件进入查询', async () => {
  const directory = await mkdtemp(join(tmpdir(),'events-'));
  const source = await createSource({scenario:'overflow'});
  try {
    const client = createClient(source.origin);
    const archive = new Archive(directory);
    const result = await collectEvents(client,{commit:rows => archive.put(rows,{source:source.origin,adapter:'events'})});
    assert.equal(result.confirmations.length,2);
    const records = await archive.list();
    assert.equal(records.filter(entry => entry.row.kind === 'gap').length,1);
    assert.equal(records.filter(entry => entry.row.kind === 'event').length,2);
    assert.equal((await client('/fragments')).items.length,0);
  } finally {await source.close();await rm(directory,{recursive:true,force:true});}
});

test('静态点表读取保持原有约定', async () => {
  const source = await createSource();
  try {
    const rows = await collect(createClient(source.origin));
    assert.equal(rows[0].kind,'static');
    assert.equal(rows[0].id,'station1:0');
  } finally {await source.close();}
});
