import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collect,collectEvents} from './reader.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';

const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(resolve(process.env.DATA_DIR ?? '.state'));
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const client = createClient(source.origin);
  const rows = await collect(client);
  console.log(JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'current'})));
  // 静态点表只反映当前值；事件领取负责离线期间的真实跳闸记录与确认。
  const events = await collectEvents(client,{commit:batch => archive.put(batch,{source:source.origin,adapter:'events'})});
  console.log(JSON.stringify({events:events.rows.length,gaps:events.gaps.length,responses:events.responses.length,confirmed:events.confirmations.length}));
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
