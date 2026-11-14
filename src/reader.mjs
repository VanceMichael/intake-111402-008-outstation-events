export async function collect(client) {
  const snapshot = await client('/static');
  return snapshot.points.map(point => ({id:`${snapshot.outstation}:${point.index}`,value:point.value,flags:point.flags,kind:'static'}));
}
