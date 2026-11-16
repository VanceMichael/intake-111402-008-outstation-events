import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,collectEvents} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const client = createClient(source.origin);
  const rows = await collect(client);
  console.log('实际收件',JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
  const events = await collectEvents(client,{commit:batch => archive.put(batch,{source:source.origin,adapter:'events'})});
  console.log('事件收件',JSON.stringify({events:events.rows.filter(row => row.kind === 'event').length,gaps:events.gaps.length,
    responses:events.responses,confirmed:events.confirmations.length}));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('来源交互',JSON.stringify(await createClient(source.origin)('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
