const http = require("http");
const { readFile, writeFile, mkdir, rename } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  batches: [],
  recalls: [],
  replacements: []
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /batches",
  "GET /batches",
  "GET /batches/:id",
  "POST /batches/:id/recall",
  "GET /batches/:id/affected",
  "POST /batches/:id/replacements",
  "GET /recalls",
  "GET /recalls/:id"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeDb(initialData);
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 旧版本库文件没有批次相关字段，读取时补齐，保证重启后平滑迁移
  db.clocks ||= [];
  db.adjustments ||= [];
  db.retests ||= [];
  db.batches ||= [];
  db.recalls ||= [];
  db.replacements ||= [];
  return db;
}

async function writeDb(data) {
  // 先写临时文件再原子改名，避免写一半留下损坏的库文件
  const tmpFile = `${DB_FILE}.${process.pid}.tmp`;
  await writeFile(tmpFile, JSON.stringify(data, null, 2));
  await rename(tmpFile, DB_FILE);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    const error = new Error("请求体必须是JSON对象");
    error.status = 400;
    throw error;
  }
  return data;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

// 批次/召回接口的严格校验：必填字段必须是非空字符串（拒绝 null、数字、空白串）
function requiredStrings(body, fields) {
  const invalid = fields.filter((field) => typeof body[field] !== "string" || body[field].trim() === "");
  if (invalid.length) {
    const error = new Error(`字段必须是非空字符串：${invalid.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function optionalStrings(body, fields) {
  const invalid = fields.filter(
    (field) => body[field] !== undefined && body[field] !== null && typeof body[field] !== "string"
  );
  if (invalid.length) {
    const error = new Error(`字段必须是字符串：${invalid.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function parseClockIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    const error = new Error("clockIds 必须是字符串数组");
    error.status = 400;
    throw error;
  }
  const ids = [...new Set(value)];
  if (ids.some((id) => typeof id !== "string" || id.trim() === "")) {
    const error = new Error("clockIds 元素必须是非空字符串");
    error.status = 400;
    throw error;
  }
  return ids;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false
  };
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) {
    const error = new Error("批次不存在");
    error.status = 404;
    throw error;
  }
  return batch;
}

function findRecallByBatch(db, batchId) {
  return db.recalls.find((item) => item.batchId === batchId) || null;
}

function lockedRecallFor(db, clockId) {
  return db.recalls.find((recall) =>
    recall.items.some((item) => item.clockId === clockId && item.status === "locked")
  ) || null;
}

function assertClockNotLocked(db, clockId) {
  const recall = lockedRecallFor(db, clockId);
  if (recall) {
    const error = new Error(`钟表涉及批次召回（召回单 ${recall.id}），调校与复测已锁定，请先登记替换件解除`);
    error.status = 409;
    throw error;
  }
}

function recallProgress(recall) {
  const total = recall.items.length;
  const released = recall.items.filter((item) => item.status === "released").length;
  return { total, released, pending: total - released, done: released === total };
}

function batchSummary(db, batch) {
  const recall = findRecallByBatch(db, batch.id);
  return {
    ...batch,
    affectedCount: batch.clockIds.length,
    recallId: recall ? recall.id : null,
    progress: recall ? recallProgress(recall) : null
  };
}

function recallView(db, recall) {
  const batch = db.batches.find((item) => item.id === recall.batchId) || null;
  return {
    ...recall,
    batchCode: batch ? batch.code : null,
    items: recall.items.map((item) => {
      const clock = db.clocks.find((entry) => entry.id === item.clockId) || null;
      const replacement = db.replacements.find((entry) => entry.id === item.replacementId) || null;
      return { ...item, clockCode: clock ? clock.code : null, replacement };
    }),
    progress: recallProgress(recall)
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    assertClockNotLocked(db, clock.id);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    assertClockNotLocked(db, clock.id);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
    const qualified = body.qualified !== undefined
      ? Boolean(body.qualified)
      : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId,
      testedAt: body.testedAt || new Date().toISOString(),
      dailyRateSeconds: Number(body.dailyRateSeconds),
      amplitude: Number(body.amplitude),
      qualified,
      note: body.note || ""
    };
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // 登记批次并关联调校中的钟表；任何校验失败都不会写入
  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    requiredStrings(body, ["code", "partName"]);
    optionalStrings(body, ["supplier", "note"]);
    const code = body.code.trim();
    const partName = body.partName.trim();
    const clockIds = parseClockIds(body.clockIds);
    if (db.batches.some((item) => item.code === code)) {
      const error = new Error("批次编号已存在");
      error.status = 409;
      throw error;
    }
    const missing = clockIds.filter((id) => !db.clocks.some((clock) => clock.id === id));
    if (missing.length) {
      const error = new Error(`批次关联的钟表不存在：${missing.join(", ")}`);
      error.status = 400;
      throw error;
    }
    const batch = {
      id: makeId("batch"),
      code,
      partName,
      supplier: body.supplier || "",
      note: body.note || "",
      clockIds,
      status: "active",
      createdAt: new Date().toISOString(),
      recalledAt: null
    };
    db.batches.push(batch);
    await writeDb(db);
    return send(res, 201, { data: batchSummary(db, batch) });
  }

  if (req.method === "GET" && pathname === "/batches") {
    const status = url.searchParams.get("status");
    let data = db.batches.map((batch) => batchSummary(db, batch));
    if (status !== null) {
      data = data.filter((item) => item.status === status);
    }
    return send(res, 200, { data });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    const clocks = batch.clockIds.map((id) => db.clocks.find((clock) => clock.id === id)).filter(Boolean);
    const recall = findRecallByBatch(db, batch.id);
    return send(res, 200, {
      data: { ...batchSummary(db, batch), clocks, recall: recall ? recallView(db, recall) : null }
    });
  }

  // 批次召回：一个批次只建一张召回单，重复/并发提交返回已有单据且不重置处置进度
  const recallMatch = pathname.match(/^\/batches\/([^/]+)\/recall$/);
  if (recallMatch && req.method === "POST") {
    const batch = findBatch(db, recallMatch[1]);
    const body = await parseBody(req);
    requiredStrings(body, ["reason"]);
    optionalStrings(body, ["note"]);
    const existing = findRecallByBatch(db, batch.id);
    if (existing) {
      return send(res, 200, { data: recallView(db, existing), duplicated: true });
    }
    const now = new Date().toISOString();
    const recall = {
      id: makeId("recall"),
      batchId: batch.id,
      reason: body.reason.trim(),
      note: body.note || "",
      createdAt: now,
      items: batch.clockIds.map((clockId) => ({
        clockId,
        status: "locked",
        lockedAt: now,
        releasedAt: null,
        replacementId: null
      }))
    };
    batch.status = "recalled";
    batch.recalledAt = now;
    db.recalls.push(recall);
    await writeDb(db);
    return send(res, 201, { data: recallView(db, recall) });
  }

  // 受影响钟表清单
  const affectedMatch = pathname.match(/^\/batches\/([^/]+)\/affected$/);
  if (affectedMatch && req.method === "GET") {
    const batch = findBatch(db, affectedMatch[1]);
    const recall = findRecallByBatch(db, batch.id);
    return send(res, 200, { data: recall ? recallView(db, recall).items : [] });
  }

  // 替换件登记：逐只解除锁定；同一钟表重复登记返回已有记录，不重复建单
  const replacementMatch = pathname.match(/^\/batches\/([^/]+)\/replacements$/);
  if (replacementMatch && req.method === "POST") {
    const batch = findBatch(db, replacementMatch[1]);
    const body = await parseBody(req);
    requiredStrings(body, ["clockId"]);
    optionalStrings(body, ["note"]);
    const clockId = body.clockId.trim();
    const recall = findRecallByBatch(db, batch.id);
    if (!recall) {
      const error = new Error("批次尚未召回，不能登记替换件");
      error.status = 409;
      throw error;
    }
    const item = recall.items.find((entry) => entry.clockId === clockId);
    if (!item) {
      const error = new Error("该钟表不在本批次召回影响清单中");
      error.status = 404;
      throw error;
    }
    if (item.status === "released") {
      const existing = db.replacements.find((entry) => entry.id === item.replacementId) || null;
      return send(res, 200, { data: existing, duplicated: true });
    }
    const now = new Date().toISOString();
    const replacement = {
      id: makeId("replacement"),
      recallId: recall.id,
      batchId: batch.id,
      clockId,
      note: body.note || "",
      createdAt: now
    };
    db.replacements.push(replacement);
    item.status = "released";
    item.releasedAt = now;
    item.replacementId = replacement.id;
    await writeDb(db);
    return send(res, 201, { data: replacement, recall: recallView(db, recall) });
  }

  if (req.method === "GET" && pathname === "/recalls") {
    const batchId = url.searchParams.get("batchId");
    const data = db.recalls
      .filter((item) => !batchId || item.batchId === batchId)
      .map((item) => recallView(db, item));
    return send(res, 200, { data });
  }

  const recallDetailMatch = pathname.match(/^\/recalls\/([^/]+)$/);
  if (recallDetailMatch && req.method === "GET") {
    const recall = db.recalls.find((item) => item.id === recallDetailMatch[1]);
    if (!recall) {
      const error = new Error("召回单不存在");
      error.status = 404;
      throw error;
    }
    return send(res, 200, { data: recallView(db, recall) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

// 写请求串行执行：读-改-写不交错，并发召回/替换不会重复建单或互相覆盖
let writeChain = Promise.resolve();
function enqueueWrite(task) {
  const result = writeChain.then(() => task());
  writeChain = result.catch(() => {});
  return result;
}

const server = http.createServer((req, res) => {
  const run = () =>
    handle(req, res).catch((error) => {
      try {
        send(res, error.status || 500, { error: error.message || "服务器错误" });
      } catch {
        // 连接已断开等情况，忽略
      }
    });
  if (req.method === "GET" || req.method === "HEAD") return run();
  return enqueueWrite(run);
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
