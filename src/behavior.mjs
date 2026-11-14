export function behavior(entry,state,fixture,scenario) {
if (entry.path === '/confirm' && entry.method === 'POST') {
  if (!entry.body?.association || !Number.isInteger(entry.body.sequence) || typeof entry.body.unsolicited !== 'boolean') return {status:400,body:{error:'fragment identity required'}};
  state.confirmed ??= [];
  const identity = JSON.stringify([entry.body.association,entry.body.sequence,entry.body.unsolicited]);
  if (!state.confirmed.includes(identity)) state.confirmed.push(identity);
  return {body:{confirmed:true}};
}
if (entry.path !== '/fragments') return null;
if (!state.polled && scenario === 'normal') return {status:409,body:{error:'poll required'}};
const fragmentSet = [...(fixture.cases[scenario] ?? []),...fixture.exchanges].find(route => route.path === '/fragments').body;
return {body:{items:fragmentSet.items.filter(item => !(state.confirmed ?? []).includes(JSON.stringify([item.association,item.sequence,item.unsolicited])))}};
}
