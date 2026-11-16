# 远端站点事件缓冲的确认式采集

远端站点观测接入器。已有静态点表抓取；本地网关暴露应用层片段，不实现链路层。

## 运行

Node.js 22.23.4，依赖仅为标准库，package-lock.json 不含网络依赖。无需安装数据库或访问外站。

```sh
npm test
npm run demo
npm start
```

demo 从空临时目录启动来源与查询服务，实际领取并打印收件结果后退出，通常不到 5 秒。持续运行时来源监听 4010，查询服务监听 4020；GET /records 返回已收原件，GET /health 检查服务。

```sh
docker build --network=none -t outstation-events .
docker run --rm --network=none outstation-events npm test
docker run --rm --network=none outstation-events npm run demo
```

Dockerfile 固定 Node 镜像摘要。首次使用需预载该镜像，运行和测试不下载任何内容。现场演示可执行 npm run demo，在90秒内完成启动、实际收件与查询。

## 工程结构

- src/reader.mjs 是当前来源适配器；不修改来源来迎合适配结果。
  - collect(client) 保留原有静态点表读取，只反映当前值。
  - collectEvents(client, options) 先按类别轮询，再持续领取片段直到本次取空；按 FIR/FIN 归并整次响应，收到单个片段不代表响应结束。
  - 事件行随值保存 flags、time 与 sourceTime；IIN 中 buffer overflow 类声明写成独立的 kind:'gap' 缺口行，而不是只留在状态位里。
  - 片段按 outstation/association/sequence/unsolicited 加内容摘要去重：重连重送的未确认片段只收一次，而同一片段序列号回绕后出现的新事件内容不同，仍按真实事件接收；点位相同、值相同不会合并。
  - options.commit 是本地可靠收件动作（如 Archive.put）。只在 commit 成功后确认远端片段；未给出 commit 时返回 pending，调用方可靠保存后再 confirmFragments，确认永不早于落盘。
- src/source.mjs 与 src/behavior.mjs 实现本地来源网关，契约见 contracts.md。
- src/archive.mjs 保存来源与内容摘要；同内容重收不新增，内容变化保留版本。
- src/api.mjs 提供收件查询；.state 为运行状态，停止后可删除恢复空收件箱。
- fixtures/source.json 是虚构来源资料和状态变化，不含真实账号、交易或个人数据。

环境变量 DATA_DIR、PORT、SOURCE_PORT 控制目录和端口；SCENARIO 选择本地来源资料版本。测试和演示自己创建空目录，不依赖上次执行遗留状态。
