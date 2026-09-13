const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");

const SERVER = path.join(__dirname, "..", "server.js");

async function waitForHealth(base, child, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return true;
    } catch {
      // 服务尚未就绪，继续等待
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function startServer(dbFile) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), DB_FILE: dbFile },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const base = `http://127.0.0.1:${port}`;
    if (await waitForHealth(base, child)) {
      return { child, base, dbFile, stderr: () => stderr };
    }
    await stopServer(child);
  }
  throw new Error("服务启动失败");
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // 先挂监听再发信号，避免 exit 事件在监听注册前触发导致永久等待
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

async function freshServer(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clock-recall-test-"));
  const server = await startServer(path.join(dir, "db.json"));
  t.after(async () => {
    await stopServer(server.child);
    await fs.rm(dir, { recursive: true, force: true });
  });
  return server;
}

async function api(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非JSON响应
  }
  return { status: res.status, body: json };
}

// 发送原始字符串请求体，用于构造 null、数组等非对象JSON
async function apiRaw(base, method, pathname, raw) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: raw
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非JSON响应
  }
  return { status: res.status, body: json };
}

async function readPersisted(dbFile) {
  const raw = JSON.parse(await fs.readFile(dbFile, "utf8"));
  return {
    batches: raw.batches || [],
    recalls: raw.recalls || [],
    replacements: raw.replacements || []
  };
}

async function createClock(base, code) {
  const res = await api(base, "POST", "/clocks", {
    code,
    escapementType: "瑞士杠杆式",
    balanceFrequency: "18000vph",
    targetDailyRateSeconds: 20
  });
  assert.equal(res.status, 201);
  return res.body.data;
}

async function createBatchWithClocks(base, clockCount = 2) {
  const clocks = [];
  for (let i = 0; i < clockCount; i += 1) {
    clocks.push(await createClock(base, `CLK-T-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`));
  }
  const res = await api(base, "POST", "/batches", {
    code: `BATCH-${Math.random().toString(36).slice(2, 10)}`,
    partName: "擒纵叉",
    supplier: "测试供应商",
    clockIds: clocks.map((clock) => clock.id)
  });
  assert.equal(res.status, 201);
  return { batch: res.body.data, clocks };
}

test("正常召回闭环：登记批次→召回锁定→逐只替换解除→恢复调校复测", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 2);
  const [clockA, clockB] = clocks;
  assert.equal(batch.status, "active");
  assert.equal(batch.affectedCount, 2);

  // 召回前可以正常调校
  const before = await api(base, "POST", `/clocks/${clockA.id}/adjustments`, {
    currentDailyRateSeconds: 50,
    direction: "慢针方向",
    amount: "微调0.2格"
  });
  assert.equal(before.status, 201);

  // 发起召回
  const recall = await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "批次游丝硬度不达标" });
  assert.equal(recall.status, 201);
  assert.equal(recall.body.data.items.length, 2);
  assert.ok(recall.body.data.items.every((item) => item.status === "locked"));
  const recallId = recall.body.data.id;

  // 受影响清单
  const affected = await api(base, "GET", `/batches/${batch.id}/affected`);
  assert.equal(affected.status, 200);
  assert.equal(affected.body.data.length, 2);
  assert.deepEqual(
    affected.body.data.map((item) => item.clockId).sort(),
    [clockA.id, clockB.id].sort()
  );
  assert.ok(affected.body.data.every((item) => item.clockCode));

  // 锁定期间调校与复测均被拒绝
  for (const clock of [clockA, clockB]) {
    const adj = await api(base, "POST", `/clocks/${clock.id}/adjustments`, {
      currentDailyRateSeconds: 40,
      direction: "快针方向",
      amount: "微调0.1格"
    });
    assert.equal(adj.status, 409);
    const ret = await api(base, "POST", `/clocks/${clock.id}/retests`, {
      dailyRateSeconds: 10,
      amplitude: 250
    });
    assert.equal(ret.status, 409);
  }

  // 登记替换件，逐只解除
  const replA = await api(base, "POST", `/batches/${batch.id}/replacements`, {
    clockId: clockA.id,
    note: "已更换新批次擒纵叉"
  });
  assert.equal(replA.status, 201);
  assert.equal(replA.body.data.recallId, recallId);
  assert.equal(replA.body.recall.progress.released, 1);
  assert.equal(replA.body.recall.progress.done, false);

  // A 已解除，B 仍锁定
  const adjA = await api(base, "POST", `/clocks/${clockA.id}/adjustments`, {
    currentDailyRateSeconds: 25,
    direction: "慢针方向",
    amount: "微调0.1格"
  });
  assert.equal(adjA.status, 201);
  const adjB = await api(base, "POST", `/clocks/${clockB.id}/adjustments`, {
    currentDailyRateSeconds: 25,
    direction: "慢针方向",
    amount: "微调0.1格"
  });
  assert.equal(adjB.status, 409);

  // B 也解除后，召回单完成，复测恢复
  const replB = await api(base, "POST", `/batches/${batch.id}/replacements`, { clockId: clockB.id });
  assert.equal(replB.status, 201);
  const recalls = await api(base, "GET", "/recalls");
  assert.equal(recalls.body.data.length, 1);
  assert.equal(recalls.body.data[0].progress.done, true);
  const retB = await api(base, "POST", `/clocks/${clockB.id}/retests`, {
    dailyRateSeconds: 8,
    amplitude: 255
  });
  assert.equal(retB.status, 201);
});

test("重复召回：不重复建单、不覆盖已解除的处置进度", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 2);
  const [clockA] = clocks;

  const first = await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "擒纵轮齿形超差" });
  assert.equal(first.status, 201);
  const recallId = first.body.data.id;

  // 先解除一只，制造处置进度
  const repl = await api(base, "POST", `/batches/${batch.id}/replacements`, { clockId: clockA.id });
  assert.equal(repl.status, 201);
  const releasedAt = repl.body.recall.items.find((item) => item.clockId === clockA.id).releasedAt;

  // 重复召回
  const second = await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "重复提交" });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicated, true);
  assert.equal(second.body.data.id, recallId);

  // 仍只有一张召回单，且进度未被重置
  const recalls = await api(base, "GET", "/recalls");
  assert.equal(recalls.body.data.length, 1);
  const detail = await api(base, "GET", `/recalls/${recallId}`);
  const itemA = detail.body.data.items.find((item) => item.clockId === clockA.id);
  assert.equal(itemA.status, "released");
  assert.equal(itemA.releasedAt, releasedAt);
  assert.equal(detail.body.data.progress.released, 1);
});

test("重复替换：同一钟表重复登记返回原记录，不重复建单", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 1);
  const clock = clocks[0];
  await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "批次缺陷" });

  const first = await api(base, "POST", `/batches/${batch.id}/replacements`, {
    clockId: clock.id,
    note: "第一次登记"
  });
  assert.equal(first.status, 201);
  const replacementId = first.body.data.id;
  const releasedAt = first.body.recall.items[0].releasedAt;

  const second = await api(base, "POST", `/batches/${batch.id}/replacements`, {
    clockId: clock.id,
    note: "重复登记不应生效"
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicated, true);
  assert.equal(second.body.data.id, replacementId);
  assert.equal(second.body.data.note, "第一次登记");

  const recalls = await api(base, "GET", "/recalls");
  const item = recalls.body.data[0].items[0];
  assert.equal(item.replacement.id, replacementId);
  assert.equal(item.releasedAt, releasedAt);
});

test("并发触发：并发召回与并发替换均只建一单", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 2);

  // 并发召回
  const recallResults = await Promise.all(
    Array.from({ length: 6 }, () => api(base, "POST", `/batches/${batch.id}/recall`, { reason: "并发召回" }))
  );
  assert.equal(recallResults.filter((res) => res.status === 201).length, 1);
  assert.equal(recallResults.filter((res) => res.status === 200).length, 5);
  const recallIds = new Set(recallResults.map((res) => res.body.data.id));
  assert.equal(recallIds.size, 1);
  const recalls = await api(base, "GET", "/recalls");
  assert.equal(recalls.body.data.length, 1);
  assert.equal(recalls.body.data[0].items.length, 2);

  // 并发替换同一只钟表
  const replResults = await Promise.all(
    Array.from({ length: 6 }, () =>
      api(base, "POST", `/batches/${batch.id}/replacements`, { clockId: clocks[0].id })
    )
  );
  assert.equal(replResults.filter((res) => res.status === 201).length, 1);
  assert.equal(replResults.filter((res) => res.status === 200).length, 5);
  const replacementIds = new Set(replResults.map((res) => res.body.data.id));
  assert.equal(replacementIds.size, 1);

  // 并发登记相同编号批次
  const code = `BATCH-DUP-${Math.random().toString(36).slice(2, 8)}`;
  const batchResults = await Promise.all(
    Array.from({ length: 4 }, () => api(base, "POST", "/batches", { code, partName: "摆轮" }))
  );
  assert.equal(batchResults.filter((res) => res.status === 201).length, 1);
  assert.equal(batchResults.filter((res) => res.status === 409).length, 3);
  const batches = await api(base, "GET", "/batches");
  assert.equal(batches.body.data.filter((item) => item.code === code).length, 1);
});

test("非法流转：未召回先替换、对象不存在、缺字段、编号重复", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 1);
  const clock = clocks[0];

  // 未召回不能登记替换件
  const early = await api(base, "POST", `/batches/${batch.id}/replacements`, { clockId: clock.id });
  assert.equal(early.status, 409);

  // 召回不存在的批次
  const noBatch = await api(base, "POST", "/batches/batch_ghost/recall", { reason: "x" });
  assert.equal(noBatch.status, 404);
  const noBatchDetail = await api(base, "GET", "/batches/batch_ghost");
  assert.equal(noBatchDetail.status, 404);
  const noRecall = await api(base, "GET", "/recalls/recall_ghost");
  assert.equal(noRecall.status, 404);

  // 未召回时受影响清单为空
  const affected = await api(base, "GET", `/batches/${batch.id}/affected`);
  assert.equal(affected.status, 200);
  assert.deepEqual(affected.body.data, []);

  // 召回后对不在清单内的钟表登记替换件
  await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "缺陷" });
  const outsider = await createClock(base, "CLK-OUTSIDER");
  const wrongClock = await api(base, "POST", `/batches/${batch.id}/replacements`, { clockId: outsider.id });
  assert.equal(wrongClock.status, 404);

  // 缺字段（对未召回批次校验 reason；已召回批次重复提交属幂等返回，在专门用例覆盖）
  const fresh = await api(base, "POST", "/batches", { code: "BATCH-NO-REASON", partName: "摆轮" });
  assert.equal(fresh.status, 201);
  const noReason = await api(base, "POST", `/batches/${fresh.body.data.id}/recall`, {});
  assert.equal(noReason.status, 400);
  const noPart = await api(base, "POST", "/batches", { code: "BATCH-X" });
  assert.equal(noPart.status, 400);
  const noClock = await api(base, "POST", `/batches/${batch.id}/replacements`, {});
  assert.equal(noClock.status, 400);

  // 批次编号重复
  const dup = await api(base, "POST", "/batches", { code: batch.code, partName: "擒纵轮" });
  assert.equal(dup.status, 409);
});

test("失败恢复：提交失败不得只写入一半", { timeout: 60000 }, async (t) => {
  const { base, dbFile } = await freshServer(t);
  const clock = await createClock(base, "CLK-ATOMIC");

  // 批次关联了不存在的钟表 → 整体失败，批次不得落库
  const badBatch = await api(base, "POST", "/batches", {
    code: "BATCH-BAD",
    partName: "擒纵叉",
    clockIds: [clock.id, "clock_ghost"]
  });
  assert.equal(badBatch.status, 400);
  const batches = await api(base, "GET", "/batches");
  assert.equal(batches.body.data.length, 0);

  // 召回缺少 reason → 批次状态不得变更，不得生成召回单
  const good = await api(base, "POST", "/batches", {
    code: "BATCH-GOOD",
    partName: "擒纵叉",
    clockIds: [clock.id]
  });
  assert.equal(good.status, 201);
  const badRecall = await api(base, "POST", `/batches/${good.body.data.id}/recall`, {});
  assert.equal(badRecall.status, 400);
  const batchAfter = await api(base, "GET", `/batches/${good.body.data.id}`);
  assert.equal(batchAfter.body.data.status, "active");
  assert.equal(batchAfter.body.data.recalledAt, null);
  assert.equal(batchAfter.body.data.recall, null);
  const recalls = await api(base, "GET", "/recalls");
  assert.equal(recalls.body.data.length, 0);

  // 锁定期间调校被拒 → 不得产生调校记录
  await api(base, "POST", `/batches/${good.body.data.id}/recall`, { reason: "缺陷" });
  const blocked = await api(base, "POST", `/clocks/${clock.id}/adjustments`, {
    currentDailyRateSeconds: 40,
    direction: "快针方向",
    amount: "微调0.1格"
  });
  assert.equal(blocked.status, 409);
  const adjustments = await api(base, "GET", `/adjustments?clockId=${clock.id}`);
  assert.equal(adjustments.body.data.length, 0);

  // 非法JSON → 400，服务与库文件保持完好
  const res = await fetch(`${base}/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json"
  });
  assert.equal(res.status, 400);
  const health = await api(base, "GET", "/health");
  assert.equal(health.status, 200);
  const raw = JSON.parse(await fs.readFile(dbFile, "utf8"));
  assert.equal(raw.batches.length, 1);
  assert.equal(raw.recalls.length, 1);
});

test("服务重启后批次、召回与锁定状态仍在", { timeout: 60000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clock-recall-restart-"));
  const dbFile = path.join(dir, "db.json");
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const first = await startServer(dbFile);
  t.after(async () => stopServer(first.child));
  const { batch, clocks } = await createBatchWithClocks(first.base, 2);
  await api(first.base, "POST", `/batches/${batch.id}/recall`, { reason: "批次缺陷" });
  await api(first.base, "POST", `/batches/${batch.id}/replacements`, { clockId: clocks[0].id });
  await stopServer(first.child);

  const second = await startServer(dbFile);
  t.after(async () => stopServer(second.child));

  const batches = await api(second.base, "GET", "/batches");
  assert.equal(batches.body.data.length, 1);
  assert.equal(batches.body.data[0].status, "recalled");

  const recalls = await api(second.base, "GET", "/recalls");
  assert.equal(recalls.body.data.length, 1);
  assert.equal(recalls.body.data[0].progress.released, 1);
  assert.equal(recalls.body.data[0].progress.done, false);

  // 锁定状态延续：未解除的钟表仍被拒绝，已解除的可正常调校
  const blocked = await api(second.base, "POST", `/clocks/${clocks[1].id}/adjustments`, {
    currentDailyRateSeconds: 40,
    direction: "快针方向",
    amount: "微调0.1格"
  });
  assert.equal(blocked.status, 409);
  const allowed = await api(second.base, "POST", `/clocks/${clocks[0].id}/adjustments`, {
    currentDailyRateSeconds: 40,
    direction: "快针方向",
    amount: "微调0.1格"
  });
  assert.equal(allowed.status, 201);

  // 重启后重复召回仍幂等
  const dup = await api(second.base, "POST", `/batches/${batch.id}/recall`, { reason: "重启后重复提交" });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicated, true);
});

test("旧接口回归：钟表、调校、复测、查询行为不变", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);

  const health = await api(base, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  for (const route of [
    "GET /clocks",
    "POST /clocks",
    "GET /clocks/not-qualified",
    "GET /clocks/:id/history",
    "POST /clocks/:id/adjustments",
    "POST /clocks/:id/retests",
    "GET /clocks/:id/latest-retest",
    "GET /adjustments",
    "GET /retests"
  ]) {
    assert.ok(health.body.routes.includes(route), `缺少旧路由 ${route}`);
  }

  // 初始演示数据仍在
  const initial = await api(base, "GET", "/clocks");
  assert.equal(initial.body.data.length, 1);
  assert.equal(initial.body.data[0].id, "clock_demo");
  assert.equal(initial.body.data[0].qualified, false);

  // 建档 → 调校 → 复测闭环
  const clock = await createClock(base, "CLK-REGRESSION");
  assert.equal(clock.targetDailyRateSeconds, 20);
  const badClock = await api(base, "POST", "/clocks", { code: "CLK-NO-FIELDS" });
  assert.equal(badClock.status, 400);

  const adj = await api(base, "POST", `/clocks/${clock.id}/adjustments`, {
    currentDailyRateSeconds: 55,
    direction: "慢针方向",
    amount: "微调0.3格"
  });
  assert.equal(adj.status, 201);

  const ret = await api(base, "POST", `/clocks/${clock.id}/retests`, {
    dailyRateSeconds: 12,
    amplitude: 252
  });
  assert.equal(ret.status, 201);
  assert.equal(ret.body.data.qualified, true);
  assert.equal(ret.body.data.adjustmentId, adj.body.data.id);

  const latest = await api(base, "GET", `/clocks/${clock.id}/latest-retest`);
  assert.equal(latest.body.data.qualified, true);

  const history = await api(base, "GET", `/clocks/${clock.id}/history`);
  assert.equal(history.body.data.adjustments.length, 1);
  assert.equal(history.body.data.retests.length, 1);

  const qualifiedList = await api(base, "GET", "/clocks?qualified=true");
  assert.ok(qualifiedList.body.data.some((item) => item.id === clock.id));
  const notQualified = await api(base, "GET", "/clocks/not-qualified");
  assert.ok(!notQualified.body.data.some((item) => item.id === clock.id));
  assert.ok(notQualified.body.data.some((item) => item.id === "clock_demo"));

  const adjustments = await api(base, "GET", `/adjustments?clockId=${clock.id}`);
  assert.equal(adjustments.body.data.length, 1);
  const retests = await api(base, "GET", "/retests?qualified=true");
  assert.equal(retests.body.data.length, 1);

  const notFound = await api(base, "GET", "/clocks/clock_ghost/history");
  assert.equal(notFound.status, 404);
  const noRoute = await api(base, "GET", "/no-such-route");
  assert.equal(noRoute.status, 404);
});

test("输入边界：空请求体与非JSON对象请求体一律400且不落库", { timeout: 60000 }, async (t) => {
  const { base, dbFile } = await freshServer(t);
  const { batch } = await createBatchWithClocks(base, 1);
  const before = await readPersisted(dbFile);
  assert.equal(before.batches.length, 1);

  const badRequests = [
    () => api(base, "POST", "/batches"), // 空请求体
    () => apiRaw(base, "POST", "/batches", "null"),
    () => apiRaw(base, "POST", "/batches", "[1,2]"),
    () => apiRaw(base, "POST", "/batches", "\"文本\""),
    () => apiRaw(base, "POST", "/batches", "123"),
    () => apiRaw(base, "POST", "/batches", "true"),
    () => api(base, "POST", `/batches/${batch.id}/recall`), // 空请求体
    () => apiRaw(base, "POST", `/batches/${batch.id}/recall`, "null"),
    () => apiRaw(base, "POST", `/batches/${batch.id}/recall`, "[]"),
    () => api(base, "POST", `/batches/${batch.id}/replacements`), // 空请求体
    () => apiRaw(base, "POST", `/batches/${batch.id}/replacements`, "null")
  ];
  for (const send of badRequests) {
    const res = await send();
    assert.equal(res.status, 400, `应返回400，实际 ${res.status}: ${JSON.stringify(res.body)}`);
    assert.equal(typeof res.body.error, "string");
  }

  // 不得新增批次、召回或锁定记录
  const after = await readPersisted(dbFile);
  assert.deepEqual(after, before);
  const detail = await api(base, "GET", `/batches/${batch.id}`);
  assert.equal(detail.body.data.status, "active");
  assert.equal(detail.body.data.recall, null);
});

test("输入边界：空字段与错误类型一律400且不落库", { timeout: 60000 }, async (t) => {
  const { base, dbFile } = await freshServer(t);
  const { batch, clocks } = await createBatchWithClocks(base, 1);
  const clock = clocks[0];
  const before = await readPersisted(dbFile);

  // 批次编号、部件名称显式空值/空白/错误类型
  const badBatchBodies = [
    { code: null, partName: "擒纵叉" },
    { code: "", partName: "擒纵叉" },
    { code: "   ", partName: "擒纵叉" },
    { code: 123, partName: "擒纵叉" },
    { code: {}, partName: "擒纵叉" },
    { code: "BATCH-BAD", partName: null },
    { code: "BATCH-BAD", partName: "" },
    { code: "BATCH-BAD", partName: "  " },
    { code: "BATCH-BAD", partName: 5 },
    // clockIds 错误类型
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: clock.id },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: 5 },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: {} },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: null },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: [123] },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: [""] },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: ["  "] },
    { code: "BATCH-BAD", partName: "擒纵叉", clockIds: [clock.id, null] },
    // 可选字段错误类型
    { code: "BATCH-BAD", partName: "擒纵叉", supplier: 1 },
    { code: "BATCH-BAD", partName: "擒纵叉", note: false }
  ];
  for (const body of badBatchBodies) {
    const res = await api(base, "POST", "/batches", body);
    assert.equal(res.status, 400, `应拒绝 ${JSON.stringify(body)}，实际 ${res.status}`);
    assert.equal(typeof res.body.error, "string");
  }

  // 召回原因显式空值/空白/错误类型
  for (const body of [{ reason: null }, { reason: "" }, { reason: "  " }, { reason: 0 }, { reason: "有效原因", note: 1 }]) {
    const res = await api(base, "POST", `/batches/${batch.id}/recall`, body);
    assert.equal(res.status, 400, `应拒绝 ${JSON.stringify(body)}，实际 ${res.status}`);
  }
  // 召回原因非法不得产生召回单与锁定
  let detail = await api(base, "GET", `/batches/${batch.id}`);
  assert.equal(detail.body.data.status, "active");
  assert.equal(detail.body.data.recall, null);

  // 合法召回后，替换件 clockId 空值/错误类型
  const recall = await api(base, "POST", `/batches/${batch.id}/recall`, { reason: "批次缺陷" });
  assert.equal(recall.status, 201);
  for (const body of [{ clockId: null }, { clockId: "" }, { clockId: "  " }, { clockId: 1 }, { clockId: clock.id, note: 3 }]) {
    const res = await api(base, "POST", `/batches/${batch.id}/replacements`, body);
    assert.equal(res.status, 400, `应拒绝 ${JSON.stringify(body)}，实际 ${res.status}`);
  }

  // 除该次合法召回外无任何新增记录；锁定未被解除
  const after = await readPersisted(dbFile);
  assert.equal(after.batches.length, before.batches.length);
  assert.equal(after.recalls.length, 1);
  assert.equal(after.replacements.length, 0);
  detail = await api(base, "GET", `/recalls/${recall.body.data.id}`);
  assert.equal(detail.body.data.items[0].status, "locked");
});

test("输入边界：合法请求正常写入，字符串字段去除首尾空白", { timeout: 60000 }, async (t) => {
  const { base } = await freshServer(t);
  const clock = await createClock(base, "CLK-VALID");

  // 合法登记：首尾空白被修剪，clockIds 去重
  const created = await api(base, "POST", "/batches", {
    code: "  BATCH-TRIM  ",
    partName: " 擒纵叉 ",
    supplier: "供应商A",
    clockIds: [clock.id, clock.id]
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.code, "BATCH-TRIM");
  assert.equal(created.body.data.partName, "擒纵叉");
  assert.equal(created.body.data.supplier, "供应商A");
  assert.deepEqual(created.body.data.clockIds, [clock.id]);

  // 修剪后的编号参与唯一性判断
  const dup = await api(base, "POST", "/batches", { code: "BATCH-TRIM", partName: "摆轮" });
  assert.equal(dup.status, 409);

  // 不带 clockIds 也合法
  const noClocks = await api(base, "POST", "/batches", { code: "BATCH-EMPTY", partName: "游丝" });
  assert.equal(noClocks.status, 201);
  assert.deepEqual(noClocks.body.data.clockIds, []);

  // 合法召回：原因修剪空白；合法替换：clockId 容忍首尾空白
  const recall = await api(base, "POST", `/batches/${created.body.data.id}/recall`, { reason: "  批次缺陷 " });
  assert.equal(recall.status, 201);
  assert.equal(recall.body.data.reason, "批次缺陷");
  const dupRecall = await api(base, "POST", `/batches/${created.body.data.id}/recall`, { reason: "批次缺陷" });
  assert.equal(dupRecall.status, 200);
  assert.equal(dupRecall.body.duplicated, true);
  const replacement = await api(base, "POST", `/batches/${created.body.data.id}/replacements`, {
    clockId: `  ${clock.id}  `
  });
  assert.equal(replacement.status, 201);
  assert.equal(replacement.body.data.clockId, clock.id);
  const recalls = await api(base, "GET", "/recalls");
  assert.equal(recalls.body.data[0].progress.done, true);
});
