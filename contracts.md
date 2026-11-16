# 来源网关契约

GET /static 返回点表；POST /poll 接受 classes；GET /fragments 返回 outstation、association、unsolicited、sequence、FIR、FIN、CON、objects、IIN。POST /confirm 接受 association/sequence/unsolicited。序列号为 4 位，片段身份不可只用序列号。GET /__audit 返回网关请求与确认状态审计。IIN.eventBufferOverflow 是来源完整性告警。

## 本地来源操作

默认场景 normal，其他场景为 overflow。设置 SCENARIO 后启动可固定一个变体。POST /__scenario 的 name 切换来源场景并清空来源会话状态，供开发人员在测试中模拟外部变化；采集适配器不调用此控制入口。GET /__audit 返回所有真实来源请求、当前场景与会话状态。除明确列出的状态变化外，GET 可重复读取，消息可能重复领取。

来源路由的 requires 表示通信前提，sets 是来源端会话状态转移。源端拒绝返回对应HTTP状态和JSON原因，适配器不能把错误响应当业务内容。所有URL限定本地来源，未知资源404；fixture中的静态资料与 src/behavior.mjs 的状态处理共同构成来源行为。接口为授权网关的有限资料投影，不宣称覆盖协议全部版本或完整线路栈。

## 收存约定

当前适配器 collect(client) 返回带字符串 id 的原件行。Archive.put(rows, provenance) 按实际内容和来源生成摘要，保留不同内容。该原件归档不自动决定业务当前值、引用已解析、区间完整或远端已确认；业务投影与领取状态需要各自维护。GET /records 保留兼容，不将未知状态伪造为成功。

collectEvents(client, options) 在同一适配器上领取事件，不改变上述归档语义：

- 先 POST /poll 声明类别，再循环 GET /fragments 直到 items 为空；一个响应由 FIR 到 FIN 的多个片段组成，中途片段不视为响应结束，缺失 FIN 的响应出现在 incomplete 中。
- 片段去重键是 outstation/association/sequence/unsolicited 加片段内容摘要。重连重送的未确认片段因此只收一次；序列号回绕后的新事件内容不同，仍作为真实事件；同点号同值不合并。
- IIN 中 overflow 类声明写成 kind:'gap' 缺口行，与事件行一起保存；事件行带 flags、time 与 sourceTime。
- 只有 CON 为 true 的片段才确认。options.commit 成功后才确认；无 commit 时只返回 pending，由调用方在可靠保存后调用 confirmFragments。远端确认不会早于本地可靠收件。
