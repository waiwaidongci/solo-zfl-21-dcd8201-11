# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录，以及部件批次、召回单与替换件记录。

## 启动

```bash
PORT=3021 node server.js
```

可选环境变量：`DB_FILE` 指定库文件路径（默认 `data/db.json`）。旧版库文件缺少批次相关字段时会在读取时自动补齐，无需手工迁移。

## 主要接口

### 钟表、调校、复测（旧接口，行为不变）

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

### 部件批次追溯与召回闭环

- `POST /batches` 登记批次并关联调校中的钟表：`{code, partName, supplier?, note?, clockIds?}`，批次编号唯一，关联钟表必须全部存在，否则整体失败不落库
- `GET /batches?status=` 批次列表（含召回进度）
- `GET /batches/:id` 批次详情（含关联钟表与召回单）
- `POST /batches/:id/recall` 批次召回：`{reason, note?}`。召回后关联钟表进入锁定，调校与复测接口返回 409。同一批次重复/并发召回返回已有召回单（200, `duplicated: true`），不重复建单、不重置处置进度
- `GET /batches/:id/affected` 受影响钟表清单
- `POST /batches/:id/replacements` 替换件登记：`{clockId, note?}`，逐只解除锁定。未召回先登记返回 409；不在影响清单返回 404；同一钟表重复登记返回原记录（200, `duplicated: true`）
- `GET /recalls?batchId=` 召回处置历史（含进度 total/released/done）
- `GET /recalls/:id` 召回单详情（含每只钟表的锁定/解除状态与替换件）

## 并发与一致性

- 所有写请求串行执行，读-改-写不交错，并发召回/替换不会重复建单或互相覆盖
- 每次提交先校验后落库，库文件通过临时文件原子改名写入，失败不会只写一半
- 数据落盘 `data/db.json`，服务重启后批次、召回与锁定状态保留

## 输入校验

- 请求体必须是 JSON 对象；`null`、数组、标量一律 400
- 批次 `code`、`partName`，召回 `reason`，替换件 `clockId` 必须是非空字符串（拒绝 `null`、数字、纯空白），写入前去除首尾空白，批次编号按修剪后的值判重
- `clockIds` 缺省表示不关联；一旦提供必须是非空字符串数组（`null`、字符串、对象等均 400），自动去重，关联钟表必须全部存在
- `supplier`、`note` 为可选字符串，类型错误同样 400
- 校验失败的请求返回明确错误信息，且不会新增批次、召回或锁定记录

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'

# 批次召回闭环
curl -X POST http://127.0.0.1:3021/batches \
  -H 'Content-Type: application/json' \
  -d '{"code":"BATCH-2026-001","partName":"擒纵叉","clockIds":["clock_demo"]}'
curl -X POST http://127.0.0.1:3021/batches/<batchId>/recall \
  -H 'Content-Type: application/json' \
  -d '{"reason":"批次游丝硬度不达标"}'
curl http://127.0.0.1:3021/batches/<batchId>/affected
curl -X POST http://127.0.0.1:3021/batches/<batchId>/replacements \
  -H 'Content-Type: application/json' \
  -d '{"clockId":"clock_demo","note":"已更换新批次擒纵叉"}'
curl http://127.0.0.1:3021/recalls
```

## 测试

```bash
npm test   # 等价于 node --test test/*.test.js
```

覆盖：正常召回闭环、重复召回/重复替换幂等、并发不重复建单、非法流转、提交失败不写一半、重启持久化、旧接口回归，以及输入边界（空请求体、非JSON对象、空字段、错误类型、失败不落库、合法请求）。测试通过子进程在临时库文件上启动真实服务，不影响 `data/db.json`。
