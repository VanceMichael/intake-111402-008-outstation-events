import test from 'node:test';
import assert from 'node:assert/strict';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
test('来源变更与异常边界具有可观察的区别',async () => {
  const source = await createSource();
  try {
    const client = createClient(source.origin);
    const choose = name => client('/__scenario',{method:'POST',body:{name}});
await choose('overflow');
let fragments = (await client('/fragments')).items;
assert.equal(fragments[0].FIN,false);
assert.equal(fragments[1].FIN,true);
assert.equal(fragments[0].IIN.eventBufferOverflow,true);
await client('/confirm',{method:'POST',body:{association:'a2',sequence:0,unsolicited:true}});
fragments = (await client('/fragments')).items;
assert.equal(fragments.length,1);
assert.equal(fragments[0].sequence,1);
} finally {await source.close();}
});
