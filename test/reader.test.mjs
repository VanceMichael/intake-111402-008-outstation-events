import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect} from '../src/reader.mjs';
let source,client;
before(async () => {source = await createSource();client = createClient(source.origin);});
after(async () => {await source.close();});

test('静态点不能冒充历史事件', async () => {
  assert.equal((await collect(client))[0].kind, 'static');
  await assert.rejects(client('/fragments'), /409/);
  await client('/poll', {method:'POST',body:{classes:[1,2,3]}});
  assert.equal((await client('/fragments')).items[0].CON, true);
});
