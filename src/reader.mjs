import {createHash} from 'node:crypto';

export async function collect(client) {
  const snapshot = await client('/static');
  return snapshot.points.map(point => ({id:`${snapshot.outstation}:${point.index}`,value:point.value,flags:point.flags,kind:'static'}));
}

const DEFAULT_CLASSES = [1,2,3];

/** 发起分类轮询。classes 对应 DNP3 的事件类别，默认全部类别。 */
export async function pollClasses(client, classes = DEFAULT_CLASSES) {
  if (!Array.isArray(classes) || classes.length === 0) throw new Error('event classes required');
  return client('/poll',{method:'POST',body:{classes}});
}

/** 确认所需的片段身份是 association/sequence/unsolicited 三元组；序列号本身不是身份。 */
export function fragmentIdentity(fragment) {
  return {association:fragment.association,sequence:fragment.sequence,unsolicited:fragment.unsolicited};
}

function identityKey(fragment) {
  return JSON.stringify([fragment.association,fragment.sequence,fragment.unsolicited]);
}

// 响应归属还要带上 outstation，避免不同站点复用序列号时被并成一次响应。
function responseKey(fragment) {
  return JSON.stringify([fragment.outstation,fragment.association,fragment.unsolicited]);
}

// 网关重连后会原样重送未确认片段，所以片段内容摘要可以稳定标识一次重送；
// 序列号回绕后出现的另一个真实片段内容不同，摘要也随之不同。
export function fragmentDigest(fragment) {
  return createHash('sha256').update(canonical(fragment)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function declaredIin(fragment) {
  if (!fragment.IIN || typeof fragment.IIN !== 'object') return {};
  return Object.fromEntries(Object.entries(fragment.IIN).filter(([,declared]) => declared === true));
}

function gapReasons(iin) {
  return Object.keys(iin).filter(reason => /overflow/i.test(reason));
}

function rowsForFragment(fragment, digest) {
  const outstation = fragment.outstation ?? '';
  const identity = `${outstation}:${fragment.association}:${fragment.unsolicited ? 'u' : 's'}:${fragment.sequence}:${digest.slice(0,16)}`;
  const iin = declaredIin(fragment);
  const base = {
    outstation:fragment.outstation,
    association:fragment.association,
    unsolicited:fragment.unsolicited,
    sequence:fragment.sequence,
    FIR:fragment.FIR,
    FIN:fragment.FIN,
    CON:fragment.CON,
    fragment:digest,
    iin,
  };
  const objects = Array.isArray(fragment.objects) ? fragment.objects : [];
  const rows = objects.map((object, position) => ({
    ...object,
    id:`${outstation}:${object.index}:event:${identity}:${position}`,
    kind:'event',
    ...base,
    index:object.index,
    value:object.value,
    flags:object.flags,
    time:object.time,
    sourceTime:object.time,
    position,
  }));
  // 来源声明缓冲溢出时写入一条可见缺口；丢失区间不能只留在 IIN 位里。
  for (const reason of gapReasons(iin)) {
    rows.push({
      id:`gap:${identity}:${reason}`,
      kind:'gap',
      reason,
      ...base,
    });
  }
  return rows;
}

export async function confirmFragment(client, fragment) {
  if (!fragment?.association || !Number.isInteger(fragment.sequence) || typeof fragment.unsolicited !== 'boolean') throw new Error('fragment identity required');
  return client('/confirm',{method:'POST',body:fragmentIdentity(fragment)});
}

/** 按片段身份去重后逐条确认；调用方必须已经可靠保存这些片段对应的收件。 */
export async function confirmFragments(client, fragments) {
  const confirmed = [];
  const done = new Set();
  for (const fragment of fragments) {
    const key = identityKey(fragment);
    if (done.has(key)) continue;
    done.add(key);
    await confirmFragment(client, fragment);
    confirmed.push(fragmentIdentity(fragment));
  }
  return confirmed;
}

function responseSummary(response) {
  return {outstation:response.outstation,association:response.association,unsolicited:response.unsolicited,sequences:[...response.sequences],fragments:response.fragments,complete:response.complete};
}

function trackResponse(open, result, fragment) {
  const key = responseKey(fragment);
  let response = open.get(key);
  if (fragment.FIR === true) {
    // FIR 开启一个新响应；上一个没有等到 FIN 的响应是可见的不完整响应。
    if (response && !response.complete) result.incomplete.push(responseSummary(response));
    response = {outstation:fragment.outstation,association:fragment.association,unsolicited:fragment.unsolicited,sequences:[],fragments:0,complete:false};
    open.set(key,response);
  } else if (!response) {
    response = {outstation:fragment.outstation,association:fragment.association,unsolicited:fragment.unsolicited,sequences:[],fragments:0,complete:false};
    open.set(key,response);
  }
  response.sequences.push(fragment.sequence);
  response.fragments++;
  if (fragment.FIN === true) {
    response.complete = true;
    result.responses.push(responseSummary(response));
    open.delete(key);
  }
}

function uniqueIdentities(fragments) {
  const seen = new Set();
  return fragments.filter(fragment => {
    const key = identityKey(fragment);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(fragmentIdentity);
}

/**
 * 领取网关事件：分类轮询后持续读取片段，直到本次可领取内容取空。
 * 一个响应可能由多个片段组成，FIR/FIN 之间不会提前结束。
 *
 * options.commit 必须是“本地可靠收件”的异步动作（例如 Archive.put）。
 * 只有 commit 成功返回后才确认远端片段；未提供 commit 时不确认，返回 pending，
 * 由调用方在可靠保存后使用 confirmFragments 完成确认，避免为了清空远端缓冲丢掉现场经过。
 */
export async function collectEvents(client, options = {}) {
  const classes = options.classes ?? DEFAULT_CLASSES;
  const shouldPoll = options.poll ?? true;
  const commit = options.commit;
  const maxRequests = options.maxRequests ?? 64;
  const maxFragments = options.maxFragments ?? 512;

  const result = {rows:[],responses:[],confirmations:[],pending:[],incomplete:[],gaps:[],polled:false};
  if (shouldPoll) { await pollClasses(client, classes); result.polled = true; }

  const open = new Map();
  const seen = new Set();
  const pending = [];
  let fragments = 0;

  for (let request = 0; request < maxRequests; request++) {
    const data = await client('/fragments');
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) break;

    const batchRows = [];
    const batchAcks = [];
    let fresh = 0;
    for (const fragment of items) {
      const digest = fragmentDigest(fragment);
      const key = `${identityKey(fragment)}\u0000${digest}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh++;
      fragments++;
      if (fragments > maxFragments) throw new Error('fragment budget exceeded');

      const rows = rowsForFragment(fragment, digest);
      batchRows.push(...rows);
      for (const row of rows) if (row.kind === 'gap') result.gaps.push(row);
      trackResponse(open, result, fragment);
      if (fragment.CON === true) batchAcks.push(fragment);
    }
    if (fresh === 0) break;

    result.rows.push(...batchRows);
    if (typeof commit === 'function') {
      // 先完成本地可靠收件，再确认远端；commit 失败时不会发出任何 /confirm。
      await commit(batchRows,{polled:result.polled,responses:result.responses.length});
      const confirmed = await confirmFragments(client, batchAcks);
      result.confirmations.push(...confirmed.map(identity => ({...identity,confirmed:true})));
    } else {
      pending.push(...batchAcks);
    }
  }

  for (const response of open.values()) if (!response.complete) result.incomplete.push(responseSummary(response));
  result.pending = uniqueIdentities(pending);
  return result;
}
