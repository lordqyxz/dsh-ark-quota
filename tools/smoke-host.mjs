#!/usr/bin/env node
// 宿主侧冒烟测试：mock ctx + stub fetch，不起监听服务器。
//
// 本轮重构后插件只保留「额度快照 + burn 消耗速度预测」，整套请求统计
// （foldStats/shapeStats/健康点状图/token/llm-stream 钩子、/ark-quota/stats
// 路由）已移除。本文件只测试仍存在的导出与路由。
import { Readable } from "node:stream";
import {
  apply,
  normalizeRefreshMs,
  ALLOWED_REFRESH_MS,
  migrateAccounts,
  resolveActiveAccountId,
  accountIdFromRoute,
  accountForRoute,
  ensureRouteAccount,
  detachRoute,
  clearRouteCredentials,
  findAccountByKeys,
  migrateStatsState,
  snapshotStatsState,
  mergeStatsState,
  isArkProvider,
  isSameOriginRequest,
  foldSnap,
  foldSnapFor,
  dropAccountSnaps,
  pruneSnaps,
  burnRate,
  burnRatesFor,
  ACCOUNT_ID_RE,
  LEGACY_ACCOUNT_ID
} from "../lib/index.js";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error("FAIL:", msg);
  } else {
    console.log("ok:", msg);
  }
}

function makeReq(method, url, json, headers) {
  const text = json === undefined ? "" : JSON.stringify(json);
  const req = Readable.from([Buffer.from(text)]);
  req.method = method;
  req.url = url;
  // 小写键，与 Node IncomingMessage.headers 形状一致。
  req.headers = headers ? { ...headers } : {};
  return req;
}

function makeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: undefined,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ?? "";
    }
  };
}

// mock 的 llm 提供方路由清单：两个火山方舟路由 + 一个内置 deepseek 直连
// （无 baseURL，走名称判定）+ 一个第三方中转（非方舟域名）。
const DEFAULT_PROVIDERS = [
  { id: "ark-coding-plan", name: "火山 Coding Plan" },
  { id: "ark-coding-plan-company", name: "火山 Agent Plan" },
  { id: "deepseek-official", name: "DeepSeek" },
  { id: "newapi-mo", name: "第三方中转" }
];

function mockCtx(opts = {}) {
  const routes = new Map();
  let stored = opts.stored === undefined ? null : opts.stored;
  let openedSpec = null;
  // 与 dsh-storage 的 UNIT_NAME_RE 保持一致：域名含连字符会被拒，
  // open() 抛错后插件静默退回内存态，重启快照历史全丢。
  const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;
  const storageDomain = {
    async open(spec) {
      if (!UNIT_NAME_RE.test(spec.name)) {
        throw new Error(`invalid-name: domain '${spec.name}' must match ${UNIT_NAME_RE}`);
      }
      for (const table of Object.keys(spec.tables || {})) {
        if (!UNIT_NAME_RE.test(table)) {
          throw new Error(`invalid-name: table '${table}' must match ${UNIT_NAME_RE}`);
        }
      }
      // 全局 schema 不得接受 null（storage-domain 的硬约束）。
      if (spec.global !== undefined && spec.global.schema.safeParse(null).success) {
        throw new Error("global schema must not accept null");
      }
      openedSpec = spec;
      if (stored === null) stored = spec.global.initial;
      return {
        name: spec.name,
        global: {
          get() { return stored; },
          async set(v) { stored = v; }
        },
        async close() {}
      };
    }
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect(fn) { fn(); },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      }
    },
    settings: {
      register(_ns, _schema, { base }) {
        let current = { ...base };
        const watchers = [];
        return {
          get: () => current,
          watch(cb) {
            watchers.push(cb);
            return () => {};
          },
          async update(patch) {
            current = { ...current, ...patch };
            for (const w of watchers) w();
          }
        };
      },
      // 别的插件的命名空间：/ark-quota/providers 读它拿 baseURL 判定方舟路由。
      // opts.otherSettings === false 时模拟"读不到"，验证名称特征兜底路径。
      get: (ns) => {
        if (opts.otherSettings === false) return undefined;
        if (ns !== "llm-pi-ai") return undefined;
        return opts.otherSettings ?? {
          providers: {
            "ark-coding-plan": { baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3" },
            "ark-coding-plan-company": { baseURL: "https://ark.cn-beijing.volces.com/api/plan/v3" },
            "newapi-mo": { baseURL: "https://sub2api.example.invalid" }
            // 注意：deepseek-official 是内置 deepseek 适配器路由，这里不给
            // baseURL，强制走名称特征判定（应判为非方舟）。
          }
        };
      }
    },
    storageDomain: opts.storageDomain === false ? undefined : storageDomain,
    llm: opts.llm === false ? undefined : {
      listProviders: () => opts.providers ?? DEFAULT_PROVIDERS,
      // 适配器自注册的可配置目录：本测试用命名空间扫描路径兜底，返回空即可。
      listConfigurableProviders: () => []
    },
    __routes: routes,
    __openedSpec: () => openedSpec,
    __stored: () => stored
  };
  return ctx;
}

/** 多账号配置：两个火山账号，各关联一个方舟路由。 */
function multiConfig(extra = {}) {
  return {
    accounts: [
      {
        id: "personal",
        label: "个人 Pro",
        accessKeyId: "ak-personal",
        secretAccessKey: "sk-personal",
        region: "cn-beijing",
        version: "2024-01-01",
        providers: ["ark-coding-plan"]
      },
      {
        id: "company",
        label: "公司 Agent Plan",
        accessKeyId: "ak-company",
        secretAccessKey: "sk-company",
        region: "cn-beijing",
        version: "2024-01-01",
        providers: ["ark-coding-plan-company"]
      }
    ],
    activeAccountId: "company",
    refreshMs: 300000,
    ...extra
  };
}

async function call(ctx, path, method, url, json, headers) {
  const route = ctx.__routes.get(path);
  if (!route) return { res: { statusCode: 404 }, json: null, __missing: true };
  const req = makeReq(method, url ?? path, json, headers);
  const res = makeRes();
  await route.handler(req, res);
  const parsed = res.body ? JSON.parse(res.body) : null;
  return { res, json: parsed };
}

const codingBody = {
  ResponseMetadata: {},
  Result: {
    Status: "Normal",
    UpdateTimestamp: Math.floor(Date.now() / 1000) - 600,
    HasReward: false,
    QuotaUsage: [
      { Level: "monthly", Percent: 150, ResetTime: Math.floor(Date.now() / 1000) + 3600, Used: 12, Total: 100 },
      { Level: "weekly", Percent: -3, ResetTime: Math.floor(Date.now() / 1000) + 3600 },
      { Level: "session", Percent: 40, ResetTime: Math.floor(Date.now() / 1000) + 3600 }
    ]
  }
};

// --- normalizeRefreshMs ---
assert(normalizeRefreshMs(300000) === 300000, "合法值 5 分钟透传");
assert(normalizeRefreshMs(1000) === 60000, "1s 的 YAML 笔误 snap 到 1 分钟，不会打爆上游");
assert(normalizeRefreshMs(120000) === 60000, "2 分钟 snap 到最近的合法值 1 分钟");
assert(normalizeRefreshMs(NaN) === 300000, "NaN 回落到默认 5 分钟");
assert(normalizeRefreshMs(-5) === 300000, "负数回落到默认 5 分钟");
assert(ALLOWED_REFRESH_MS.length === 5, "刷新档位共 5 个");

// --- 缺密钥 → 401 missing-auth ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "", secretAccessKey: "", region: "cn-beijing", version: "2024-01-01", refreshMs: 300000 });
  const { res, json } = await call(ctx, "/ark-quota", "GET", "/ark-quota");
  assert(res.statusCode === 401 && json.code === "missing-auth", "缺密钥 → 401 missing-auth");
  assert(!Object.prototype.hasOwnProperty.call(json, "secretAccessKey"), "错误体不含 secretAccessKey 字段");
}

// --- /ark-quota/settings 的 refreshMs allowlist ---
{
  const ctx = mockCtx();
  apply(ctx, { accessKeyId: "", secretAccessKey: "", region: "cn-beijing", version: "2024-01-01", refreshMs: 1000 });
  const snapped = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(snapped.json.refreshMs === 60000, "apply() 把 refreshMs=1000 snap 成 60000");
  const get = await call(ctx, "/ark-quota/settings", "GET", "/ark-quota/settings");
  assert(get.res.statusCode === 405, "GET /ark-quota/settings → 405");
  const bad = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 1000 });
  assert(bad.res.statusCode === 400 && bad.json.code === "bad-value", "非法 refreshMs=1000 被拒 → 400");
  const ok = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 60000, accessKeyId: "nope" });
  assert(ok.res.statusCode === 200 && ok.json.refreshMs === 60000, "合法 1 分钟被接受，多余字段忽略");
  assert(ok.json.accessKeyIdSet === false, "settings 路由不回显/不落密钥");
  const status = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(status.json.refreshMs === 60000, "保存后 status 反映新 refreshMs");
}

// --- /ark-quota/credentials：空 body 400、写入不回显 ---
{
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  const empty = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials", {});
  assert(empty.res.statusCode === 400 && empty.json.code === "noop", "空 body / 无密钥字段 → 400 noop");
  // 路由维度写入：ark-coding-plan 已绑 personal，应直接更新该凭据组。
  const saved = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials", {
    route: "ark-coding-plan",
    accessKeyId: "  ak-new  ",
    secretAccessKey: "sk-new"
  });
  assert(saved.res.statusCode === 200, "指定路由写入密钥 200");
  assert(saved.json.accounts.find((a) => a.id === "personal").configured === true, "路由所属凭据组变为已配置");
  assert(Array.isArray(saved.json.routes) && saved.json.routes.some((r) => r.route === "ark-coding-plan" && r.configured), "status 带出 routes 视图");
  assert(!JSON.stringify(saved.json).includes("ak-new") && !JSON.stringify(saved.json).includes("sk-new"), "响应不回显任何密钥");
  // 旧的 account 入口仍可用（兼容）。
  const byAccount = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials", {
    account: "company", accessKeyId: "ak-company", secretAccessKey: "sk-company"
  });
  assert(byAccount.res.statusCode === 200, "account 入口（兼容）写入 200");
  const ghost = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials", {
    account: "ghost", accessKeyId: "a", secretAccessKey: "b"
  });
  assert(ghost.res.statusCode === 404, "写入未知账号 → 404");
  // 新路由首次绑定：自动建凭据组（id 由路由名清洗而来）。
  const fresh = mockCtx();
  apply(fresh, { refreshMs: 300000 });
  const first = await call(fresh, "/ark-quota/credentials", "POST", "/ark-quota/credentials",
    { route: "ark-new-route", accessKeyId: "ak", secretAccessKey: "sk" });
  assert(first.res.statusCode === 200, "空配置下按路由首次保存 200");
  const created = first.json.accounts[0];
  assert(created && created.id === accountIdFromRoute("ark-new-route"), "新路由自动建凭据组 id（" + accountIdFromRoute("ark-new-route") + "）");
  assert(created.providers.includes("ark-new-route"), "新凭据组挂着该路由");
  // 同 AK/SK 填给第二个路由 → 并入同一凭据组，不重复建组。
  const same = await call(fresh, "/ark-quota/credentials", "POST", "/ark-quota/credentials",
    { route: "ark-second-route", accessKeyId: "ak", secretAccessKey: "sk" });
  assert(same.res.statusCode === 200, "同密钥第二个路由保存 200");
  assert(same.json.accounts.length === 1, "同 AK/SK 并入同一凭据组（不新增账号）");
  assert(same.json.accounts[0].providers.sort().join(",") === "ark-new-route,ark-second-route", "合并后两个路由同属一组");
  // 无路由无账号的旧路径：自动建 default。
  const legacy = mockCtx();
  apply(legacy, { refreshMs: 300000 });
  const leg = await call(legacy, "/ark-quota/credentials", "POST", "/ark-quota/credentials", { accessKeyId: "ak", secretAccessKey: "sk" });
  assert(leg.res.statusCode === 200 && leg.json.accounts[0].id === LEGACY_ACCOUNT_ID, "无路由入口自动创建 default 账号");
}

// --- 路由维度纯函数：accountIdFromRoute / accountForRoute / ensure / detach / 去重 ---
{
  assert(accountIdFromRoute("ark-coding-plan") === "r_ark_coding_plan", "accountIdFromRoute：连字符→下划线并加 r_ 前缀");
  assert(ACCOUNT_ID_RE.test(accountIdFromRoute("a.b-c!")), "accountIdFromRoute：清洗后仍合法");
  const accs = migrateAccounts(multiConfig());
  assert(accountForRoute(accs, "ark-coding-plan")?.id === "personal", "accountForRoute：路由反查到凭据组");
  assert(accountForRoute(accs, "nope") === null, "accountForRoute：未知路由返回 null");
  // ensureRouteAccount：已归属 → 原样；新路由 → 建组
  const existed = ensureRouteAccount(accs, "ark-coding-plan");
  assert(existed.accountId === "personal" && existed.accounts === accs, "ensureRouteAccount：已归属路由不重建");
  const ensured = ensureRouteAccount(accs, "brand-new-route");
  assert(ensured.accountId === "r_brand_new_route" && ensured.accounts.length === accs.length + 1, "ensureRouteAccount：新路由建新组");
  assert(ensured.accounts.at(-1).providers[0] === "brand-new-route", "ensureRouteAccount：新组挂着路由");
  // detachRoute：解绑后空且无密钥的组被清掉
  const withRoute = ensureRouteAccount([], "lonely-route");
  const detached = detachRoute(withRoute.accounts, "lonely-route");
  assert(detached.removed === true && detached.droppedAccount === true && detached.accounts.length === 0, "detachRoute：空组（无密钥）被清掉");
  const detachedKeep = detachRoute(accs, "ark-coding-plan");
  assert(detachedKeep.droppedAccount === false, "detachRoute：有密钥的组解绑单条路由后组保留");
  assert(detachedKeep.accounts.find((a) => a.id === "personal").providers.length === 0, "detachRoute：路由从组里移除");
  // clearRouteCredentials：整组清除（AK/SK + 同账号所有路由）
  const accs2 = migrateAccounts(multiConfig());
  const cleared = clearRouteCredentials(accs2, "ark-coding-plan");
  assert(cleared.removed === true && cleared.droppedAccount === true, "clearRouteCredentials：整组删除标记");
  assert(cleared.accounts.every((a) => a.id !== "personal"), "clearRouteCredentials：personal 组被删除（AK/SK 一并清除）");
  assert(clearRouteCredentials(accs2, "unbound-route").removed === false, "clearRouteCredentials：未绑定路由返回 removed=false");
  // findAccountByKeys：同 AK/SK 命中
  assert(findAccountByKeys(accs, "ak-personal", "sk-personal")?.id === "personal", "findAccountByKeys：同密钥命中");
  assert(findAccountByKeys(accs, "ak-personal", "wrong-sk") === null, "findAccountByKeys：SK 不同不算同一账号");
}

// --- /ark-quota?route= 按路由查额度 ---
{
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const auth = String(init?.headers?.Authorization ?? "");
    const m = /Credential=([^/,\s]+)/.exec(auth);
    seen.push(m === null ? "?" : m[1]);
    return { status: 200, async text() { return JSON.stringify(codingBody); } };
  };
  try {
    const ctx = mockCtx();
    apply(ctx, multiConfig());
    const byRoute = await call(ctx, "/ark-quota", "GET", "/ark-quota?route=ark-coding-plan");
    assert(byRoute.res.statusCode === 200 && byRoute.json.accountId === "personal", "?route= 反查到 personal 凭据组");
    assert(seen[0] === "ak-personal", "?route= 用 personal 的 AK 签名");
    const unbound = await call(ctx, "/ark-quota", "GET", "/ark-quota?route=unbound-route");
    assert(unbound.res.statusCode === 404 && unbound.json.code === "unknown-account", "未绑定路由 → 404");
    assert(Array.isArray(unbound.json.routes), "404 也带出 routes 视图");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- 配额 payload：clamp + cachedAt 毫秒 + 缓存命中不重复打上游 ---
{
  let fetches = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    fetches += 1;
    return { status: 200, async text() { return JSON.stringify(codingBody); } };
  };
  try {
    const ctx = mockCtx();
    apply(ctx, {
      accessKeyId: "test-ak-id", secretAccessKey: "test-sk",
      region: "cn-beijing", version: "2024-01-01", refreshMs: 300000
    });
    const first = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(first.res.statusCode === 200 && first.json.ok === true, "额度查询 200");
    const monthly = first.json.quota.find((q) => q.level === "monthly");
    const weekly = first.json.quota.find((q) => q.level === "weekly");
    assert(monthly.percentUsed === 100, "percentUsed 超过 100 被 clamp 到 100");
    assert(monthly.percentRemaining === 0, "percentRemaining 跟随 clamp 后的已用");
    assert(weekly.percentUsed === 0, "负数 percentUsed 被 clamp 到 0");
    assert(typeof first.json.cachedAt === "number" && first.json.cachedAt > 1e12, "cachedAt 是毫秒级时间戳");
    assert(first.json.refreshMs === 300000, "payload.refreshMs 取自合法档位");
    assert(typeof first.json.burn === "object" && first.json.burn !== null, "响应带 burn 字段");
    const head = await call(ctx, "/ark-quota", "HEAD", "/ark-quota");
    assert(head.res.statusCode === 200 && head.res.body === "", "HEAD 无响应体");
    const second = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(fetches === 1, "第二次 GET 命中缓存，只打了一次上游");
    assert(second.json.cachedAt === first.json.cachedAt, "缓存响应保留原始 cachedAt");
    // force=1 强制刷新
    await call(ctx, "/ark-quota", "GET", "/ark-quota?force=1");
    assert(fetches === 2, "force=1 绕过缓存再打一次上游");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- 多账号：独立签名、独立缓存 ---
{
  const orig = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (_url, init) => {
    const auth = String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "");
    const m = /Credential=([^/,\s]+)/.exec(auth);
    seen.push(m === null ? "?" : m[1]);
    return { status: 200, async text() { return JSON.stringify(codingBody); } };
  };
  try {
    const ctx = mockCtx();
    apply(ctx, multiConfig());
    const dflt = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(dflt.json.accountId === "company", "缺省取 activeAccountId=company");
    assert(seen[0] === "ak-company", "company 用自己的 AK 签名");
    assert(!JSON.stringify(dflt.json).includes("sk-company"), "响应不泄露密钥");
    const personal = await call(ctx, "/ark-quota", "GET", "/ark-quota?account=personal");
    assert(personal.json.accountId === "personal", "?account= 切到 personal");
    assert(seen[1] === "ak-personal", "personal 用自己的 AK 签名（缓存不串账号）");
    await call(ctx, "/ark-quota", "GET", "/ark-quota");
    await call(ctx, "/ark-quota", "GET", "/ark-quota?account=personal");
    assert(seen.length === 2, "两个账号各自命中缓存，不再打上游");
    const ghost = await call(ctx, "/ark-quota", "GET", "/ark-quota?account=ghost");
    assert(ghost.res.statusCode === 404 && ghost.json.code === "unknown-account", "未知账号 → 404");
    const bare = mockCtx();
    apply(bare, { refreshMs: 300000 });
    const none = await call(bare, "/ark-quota", "GET", "/ark-quota");
    assert(none.res.statusCode === 401 && none.json.code === "missing-auth", "一个账号都没配 → 401 missing-auth");
    assert(Array.isArray(none.json.accounts) && none.json.accounts.length === 0, "无账号时 accounts 为空数组");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- resetAt / updatedAt 单位归一化（秒 vs 毫秒）---
{
  const RESET_S = Math.floor(Date.now() / 1000) + 3 * 3600;
  const RESET_MS = RESET_S * 1000;
  const orig = globalThis.fetch;
  const creds = {
    accessKeyId: "test-ak-id", secretAccessKey: "test-sk",
    region: "cn-beijing", version: "2024-01-01", refreshMs: 300000
  };
  const quotaOnce = async (body) => {
    globalThis.fetch = async () => ({ status: 200, async text() { return JSON.stringify(body); } });
    const ctx = mockCtx();
    apply(ctx, creds);
    return (await call(ctx, "/ark-quota", "GET", "/ark-quota")).json;
  };
  try {
    // Agent Plan 上游给毫秒 → 归一化成秒
    const afp = await quotaOnce({ Result: { AFPFiveHour: { Quota: 100, Used: 25, ResetTime: RESET_MS } } });
    const session = afp.quota.find((q) => q.level === "session");
    assert(session.resetAt === RESET_S, "Agent Plan 毫秒 ResetTime 归一化为秒");
    const days = Math.floor((session.resetAt * 1000 - Date.now()) / 86400000);
    assert(days === 0, "重置时间在几小时后，而不是 20678903 天后");
    // Coding Plan 上游给秒 → 原样保留
    const coding = await quotaOnce({ Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTime: RESET_S }] } });
    assert(coding.quota[0].resetAt === RESET_S, "Coding Plan 秒级 ResetTime 不变");
    // 同一时刻两种单位结果一致
    const asMs = await quotaOnce({ Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTime: RESET_MS }] } });
    assert(asMs.quota[0].resetAt === coding.quota[0].resetAt, "秒/毫秒两种输入得到相同 resetAt");
    // 缺失/0/非数字 → null，绝不回落到 1970
    const junk = await quotaOnce({
      Result: { QuotaUsage: [
        { Level: "weekly", Percent: 40 },
        { Level: "monthly", Percent: 40, ResetTime: 0 },
        { Level: "session", Percent: 40, ResetTime: "soon" }
      ] }
    });
    assert(junk.quota.every((q) => q.resetAt === null), "缺失/0/非数字 ResetTime → null");
    const alias = await quotaOnce({ Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTimestamp: RESET_MS }] } });
    assert(alias.quota[0].resetAt === RESET_S, "ResetTimestamp 别名同样归一化");
    const updated = await quotaOnce({ Result: { UpdateTimestamp: RESET_MS, QuotaUsage: [{ Level: "weekly", Percent: 1 }] } });
    assert(updated.updatedAt === RESET_S, "updatedAt 毫秒 UpdateTimestamp 归一化");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- foldSnap：最小采样间隔、变化才覆盖、超窗口裁剪 ---
{
  const T = 1_700_000_000_000;
  const q = (pct) => [{ level: "monthly", percentUsed: pct }];
  let snaps = foldSnap([], q(10), T);
  assert(snaps.length === 1 && snaps[0].p.monthly === 10, "foldSnap：记下第一条快照");
  snaps = foldSnap(snaps, q(10), T + 60000);
  assert(snaps.length === 1, "foldSnap：5 分钟内且无变化不新增");
  snaps = foldSnap(snaps, q(12), T + 120000);
  assert(snaps.length === 1 && snaps[0].p.monthly === 12, "foldSnap：5 分钟内但有变化 → 覆盖最后一条");
  snaps = foldSnap(snaps, q(15), T + 10 * 60000);
  assert(snaps.length === 2, "foldSnap：超过最小间隔后追加");
  assert(foldSnap(snaps, [], T + 20 * 60000).length === 2, "foldSnap：空 quota 不记快照");
  const old = pruneSnaps([{ t: T - 20 * 86400000, p: {} }, { t: T - 60000, p: {} }], T);
  assert(old.length === 1, "pruneSnaps：超出 14 天保留窗口的快照被裁掉");
  // 多账号包装：互不干扰；state 形状只有 snapsByAccount
  let ms = { snapsByAccount: {} };
  ms = foldSnapFor(ms, "personal", q(5), T);
  ms = foldSnapFor(ms, "company", q(50), T);
  assert(ms.snapsByAccount.personal[0].p.monthly === 5, "foldSnapFor：personal 快照独立");
  assert(ms.snapsByAccount.company[0].p.monthly === 50, "foldSnapFor：company 快照独立");
  assert(foldSnapFor(ms, null, q(1), T) === ms, "foldSnapFor：accountId 为 null 时原样返回");
}

// --- burnRate：够用 / 撞线 / 样本不足 / 重置回落 ---
{
  const T = 1_700_000_000_000;
  const DAY = 86400000;
  // 三点（-48h:10 基线、-23h:16 窗口内、现在:20）加权最小二乘：半衰期
  // 8h，近期点权重高，斜率偏向近期（≈4.3%/天；旧等权口径为 5%/天）。
  const snaps = [
    { t: T - 2 * DAY, p: { monthly: 10, weekly: 10, session: 0 } },
    { t: T - 23 * 3600000, p: { monthly: 16, weekly: 20, session: 0 } }
  ];
  const r = burnRate(snaps, "monthly", 20, T);
  assert(r !== null, "burnRate：样本充足返回结果");
  assert(Math.abs(r.perDay - 4.3) < 0.4, "burnRate：加权 OLS 斜率 ≈ 4.3%/天（偏向近期），实际 " + r.perDay.toFixed(2));
  assert(r.samples === 3, "burnRate：样本数 = 两条快照 + 当前水位");
  assert(Math.abs(r.budgetPerDay - 100 / 30) < 1e-9, "burnRate：月度预算速率 = 100%/30 天");
  assert(r.ratio > 1, "burnRate：4.3%/天 快于预算 → 倍率 > 1");
  assert(r.status === "warn", "burnRate：无投影时 1.0~1.5 倍判为偏快");
  assert(Math.abs(r.exhaustAt - (T + 18.6 * DAY)) < 2 * DAY, "burnRate：剩余 80% 按 4.3%/天 → 约 19 天后耗尽");
  // 样本不足
  assert(burnRate([], "monthly", 50, T) === null, "burnRate：没有快照返回 null");
  assert(burnRate([{ t: T - 30000, p: { monthly: 10 } }], "monthly", 11, T) === null, "burnRate：观测跨度不足月档最小跨度（6 小时）返回 null");
  // 周期重置导致百分比回落（98% → 3%）→ OLS 截断后只剩当前点，不当负消耗
  assert(burnRate([{ t: T - DAY, p: { monthly: 98 } }], "monthly", 3, T) === null, "burnRate：百分比回落（换周期）返回 null");
  // 已用满时无耗尽时间
  const full = burnRate([{ t: T - DAY, p: { monthly: 90 } }], "monthly", 100, T);
  assert(full.exhaustAt === null, "burnRate：已用满时 exhaustAt 为 null");
  // session 用 5 小时周期算预算速率
  const sess = burnRate([{ t: T - 3600000, p: { session: 0 } }], "session", 10, T);
  assert(sess !== null && Math.abs(sess.budgetPerDay - (100 / (5 * 3600000)) * DAY) < 1e-6, "burnRate：session 用 5 小时周期");

  // ── 节奏投影（主角口径：额度进度 ÷ 时间进度）──
  // 重置在 10 天后：时间进度 = 1 - 10/30 = 2/3；额度进度 0.2 ÷ 2/3 = 0.3
  // → 平均节奏投影 30%（时间过了三分之二才用五分之一，非常安全）。
  const proj = burnRate(snaps, "monthly", 20, T, (T + 10 * DAY) / 1000);
  assert(Math.abs(proj.timeProgress - (1 - 10 / 30)) < 1e-9, "burnRate：时间进度 = 1 - 剩余/周期");
  assert(Math.abs(proj.quotaProgress - 0.2) < 1e-9, "burnRate：额度进度 = 当前已用比例");
  assert(Math.abs(proj.paceRatio - 0.3) < 1e-9, "burnRate：平均倍率 = 额度进度 ÷ 时间进度");
  assert(Math.abs(proj.projectedAtReset - 30) < 1e-9, "burnRate：节奏投影 = 额度进度 ÷ 时间进度 × 100");
  assert(proj.status === "ok", "burnRate：投影 30% < 85% 判 ok（投影优先于近期倍率）");
  // 时间过了 2/3、额度已用 95%：平均节奏投影 = 95 ÷ (2/3) = 142.5% → over
  const willHit = burnRate([{ t: T - DAY, p: { monthly: 94 } }], "monthly", 95, T, (T + 10 * DAY) / 1000);
  assert(Math.abs(willHit.projectedAtReset - 142.5) < 1e-9, "burnRate：撞线投影 = 142.5%");
  assert(willHit.status === "over", "burnRate：投影 ≥100% 判 over");
  assert(willHit.exhaustAt !== null && willHit.exhaustAt < (T + 10 * DAY), "burnRate：近期速率耗尽时刻早于重置");
  // 投影落在 85%~100% → warn：时间过了 2/3、额度用了 60% → 投影 90%
  const tight = burnRate([{ t: T - DAY, p: { monthly: 59 } }], "monthly", 60, T, (T + 10 * DAY) / 1000);
  assert(Math.abs(tight.projectedAtReset - 90) < 1e-9, "burnRate：60% ÷ (2/3) → 投影 90%");
  assert(tight.status === "warn", "burnRate：投影 85%~100% 判 warn");
  // 周期刚起步（时间进度 <10%）：小分母让平均倍率失真，不下节奏结论，退回近期倍率
  const early = burnRate(snaps, "monthly", 20, T, (T + 29 * DAY) / 1000);
  assert(early.projectedAtReset === null && early.paceRatio === null, "burnRate：时间进度不足 10% 时节奏投影为 null");
  assert(early.status === "warn", "burnRate：起步期状态退回近期倍率口径");
  // 重置时刻已过 → 无投影，退回倍率口径
  const past = burnRate(snaps, "monthly", 20, T, (T - 3600000) / 1000);
  assert(past.projectedAtReset === null && past.timeProgress === null && past.paceRatio === null, "burnRate：重置时刻已过时投影为 null");
  assert(past.status === "warn", "burnRate：无投影时状态退回倍率口径");
  // 重置时刻比整周期还远 → 无投影
  const far = burnRate(snaps, "monthly", 20, T, (T + 40 * DAY) / 1000);
  assert(far.projectedAtReset === null, "burnRate：重置时刻超出周期+容差时投影为 null");
  // 不传 resetAt → 投影字段为 null
  assert(r.projectedAtReset === null && r.timeProgress === null && r.paceRatio === null, "burnRate：不传 resetAt 时投影为 null");

  // ── OLS 抗突发：一次突发把水位拉起后长期持平，斜率不应被突发主导 ──
  // 19 小时前 10% → 19%（突发），之后持平在 19.2%。
  // 旧端点法（最早点 vs 当前）算成 (19.2-10)/20h ≈ 11%/天；OLS 摊薄后 ≈ 6.7%/天。
  const burst = burnRate([
    { t: T - 20 * 3600000, p: { monthly: 10 } },
    { t: T - 19 * 3600000, p: { monthly: 19 } },
    { t: T - 10 * 3600000, p: { monthly: 19.1 } }
  ], "monthly", 19.2, T);
  assert(burst.perDay < 9, "burnRate：突发后持平时 OLS 速率被摊薄（< 9%/天，端点法会给到 ~11%/天）");
}

// --- burnRatesFor：多周期，样本不足的周期不出现 ---
{
  const T = 1_700_000_000_000;
  const DAY = 86400000;
  const rates = burnRatesFor(
    { snapsByAccount: { a: [{ t: T - DAY, p: { monthly: 79 } }] } },
    "a",
    [
      { level: "monthly", percentUsed: 80, resetAt: (T + 10 * DAY) / 1000 },
      { level: "weekly", percentUsed: 5 }
    ],
    T
  );
  assert(rates.monthly !== undefined, "burnRatesFor：有节奏的 monthly 出结果");
  assert(rates.weekly === undefined, "burnRatesFor：weekly 无 resetAt 且无样本不出现");
  // 平均节奏投影 = 80% ÷ (2/3 时间进度) = 120%
  assert(Math.abs(rates.monthly.projectedAtReset - 120) < 1e-9, "burnRatesFor：resetAt 透传，平均节奏投影 = 120%");
  assert(rates.monthly.status === "over", "burnRatesFor：投影 120% 判 over");
}

// --- migrateStatsState：旧统计字段丢弃，只留快照 ---
{
  const T = 1_700_000_000_000;
  const DAY = 86400000;
  const oldDoc = {
    // 旧的请求统计字段（v1 扁平 + v2 byAccount）：必须全部丢弃
    startedAt: T - 10 * DAY,
    total: 1234, ok: 1200, fail: 34,
    buckets: [{ m: 1, ok: 10, fail: 0 }],
    byAccount: { default: { total: 1234, ok: 1200, fail: 34, buckets: [{ m: 1 }] } },
    snapsByAccount: {
      default: [
        { t: T - 2 * DAY, p: { monthly: 10 } },
        { t: T - DAY, p: { monthly: 20 } }
      ],
      "bad-id!": [{ t: T, p: { monthly: 99 } }],          // 非法账号 id → 过滤
      expired: [{ t: T - 30 * DAY, p: { monthly: 1 } }]   // 超出 14 天 → 裁剪 → 空键不留
    }
  };
  const m = migrateStatsState(oldDoc, T);
  assert(!("startedAt" in m) && !("total" in m) && !("byAccount" in m) && !("buckets" in m),
    "migrateStatsState：旧统计字段（startedAt/total/byAccount/buckets）全部丢弃");
  assert(Array.isArray(m.snapsByAccount.default) && m.snapsByAccount.default.length === 2, "合法账号快照保留（2 条）");
  assert(!("bad-id!" in m.snapsByAccount), "非法账号 id 的快照被过滤");
  assert(!("expired" in m.snapsByAccount), "全部过期的账号不留空键");
  // 空态/undefined
  const empty = migrateStatsState(undefined, T);
  assert(empty && Object.keys(empty.snapsByAccount).length === 0, "migrateStatsState：undefined 入参返回空快照态");
}

// --- snapshotStatsState：只输出 { snapsByAccount } ---
{
  const T = 1_700_000_000_000;
  const out = snapshotStatsState({
    // 即使传入带旧统计字段的 state，也只落 snapsByAccount
    startedAt: T, byAccount: { x: { total: 9 } },
    snapsByAccount: { a: [{ t: T, p: { monthly: 1 } }] }
  });
  assert(JSON.stringify(Object.keys(out).sort()) === JSON.stringify(["snapsByAccount"]), "snapshotStatsState：输出只有 snapsByAccount 一个键");
  assert(out.snapsByAccount.a.length === 1, "snapshotStatsState：快照内容保留");
}

// --- mergeStatsState：落盘 + 内存合并、按时间排序、空键不留 ---
{
  const T = 1_700_000_000_000;
  const DAY = 86400000;
  const stored = { snapsByAccount: {
    default: [{ t: T - 3 * DAY, p: { monthly: 5 } }, { t: T - DAY, p: { monthly: 20 } }],
    stale: [{ t: T - 30 * DAY, p: { monthly: 1 } }]   // 全过期 → 合并不留空键
  } };
  const live = { snapsByAccount: {
    default: [{ t: T - 2 * DAY, p: { monthly: 12 } }, { t: T, p: { monthly: 30 } }],
    personal: [{ t: T, p: { monthly: 8 } }]
  } };
  const merged = mergeStatsState(stored, live, T);
  assert(merged.snapsByAccount.default.length === 4, "mergeStatsState：同账号落盘+内存快照合并（4 条）");
  assert(merged.snapsByAccount.default.every((s, i, arr) => i === 0 || arr[i - 1].t <= s.t), "mergeStatsState：合并后按时间升序");
  assert(merged.snapsByAccount.personal.length === 1, "mergeStatsState：仅内存里的账号保留");
  assert(!("stale" in merged.snapsByAccount), "mergeStatsState：全过期账号不留空键");
  assert(!("startedAt" in merged) && !("byAccount" in merged), "mergeStatsState：输出不含旧统计字段");
}

// --- 账号解析纯函数：迁移、当前账号、provider 归属、中文 label ---
{
  // 旧单账号配置 → 合成 default 账号
  const migrated = migrateAccounts({ accessKeyId: "ak", secretAccessKey: "sk", region: "cn-beijing", version: "v1" });
  assert(migrated.length === 1 && migrated[0].id === LEGACY_ACCOUNT_ID, "migrateAccounts：旧单账号迁移成 default");
  assert(migrated[0].accessKeyId === "ak", "migrateAccounts：密钥搬进账号");
  assert(migrated[0].providers.length === 0, "migrateAccounts：迁移出的账号默认不关联 provider");
  assert(migrateAccounts({}).length === 0, "migrateAccounts：空配置返回空列表");
  // 中文显示名原样保留
  const zh = migrateAccounts({ accounts: [
    { id: "personal", label: "  个人号  ", accessKeyId: "a", secretAccessKey: "b", providers: [] }
  ] });
  assert(zh[0].label === "个人号", "migrateAccounts：中文 label 保留并裁剪首尾空白");
  // accounts 存在时忽略顶层旧字段；provider 去重去空
  const both = migrateAccounts({
    accessKeyId: "old",
    accounts: [{ id: "a", label: "A", accessKeyId: "new", secretAccessKey: "s", providers: ["p1", "p1", ""] }]
  });
  assert(both[0].accessKeyId === "new", "migrateAccounts：accounts 优先于顶层旧字段");
  assert(both[0].providers.length === 1, "migrateAccounts：provider 去重且剔除空串");
  // 脏 id / 重复 id 丢弃；标签留空回落 id
  const dirty = migrateAccounts({ accounts: [
    { id: "Bad-Id", label: "x" },
    { id: "ok1", label: "" },
    { id: "ok1", label: "dup" },
    { id: "", label: "empty" }
  ] });
  assert(dirty.length === 1 && dirty[0].id === "ok1", "migrateAccounts：丢弃不合法与重复 id");
  assert(dirty[0].label === "ok1", "migrateAccounts：标签留空回落到 id");
  assert(ACCOUNT_ID_RE.test("company_2") && !ACCOUNT_ID_RE.test("Company") && !ACCOUNT_ID_RE.test("中文"),
    "ACCOUNT_ID_RE：只允许小写字母开头的英文/数字/下划线");
  // 当前账号回落
  const accs = migrateAccounts(multiConfig());
  assert(resolveActiveAccountId(accs, "company") === "company", "resolveActiveAccountId：命中已存在账号");
  assert(resolveActiveAccountId(accs, "ghost") === "personal", "resolveActiveAccountId：失效 id 回落到第一个");
  assert(resolveActiveAccountId([], "x") === null, "resolveActiveAccountId：无账号返回 null");
  // migrateAccounts 保留各账号的 providers 归属
  assert(Array.isArray(accs.find((a) => a.id === "personal").providers), "migrateAccounts：providers 归属随账号保留");
  assert(accs.find((a) => a.id === "personal").providers.includes("ark-coding-plan"), "migrateAccounts：personal 关联 ark-coding-plan");
}

// --- isArkProvider：域名硬证据优先，读不到退回名称特征 ---
{
  const urls = {
    "ark-coding-plan": "https://ark.cn-beijing.volces.com/api/coding/v3",
    "ark-other": "https://open.volcengine.com/api/v1",
    "deepseek": "https://api.deepseek.com/v1",
    "relay": "https://sub2api.example.invalid",
    "fake": "https://volces.com.evil.example/api"
  };
  assert(isArkProvider({ id: "ark-coding-plan" }, urls), "isArkProvider：volces.com 域名 → true");
  assert(isArkProvider({ id: "ark-other" }, urls), "isArkProvider：volcengine.com 域名 → true");
  assert(!isArkProvider({ id: "deepseek" }, urls), "isArkProvider：deepseek.com 域名 → false");
  assert(!isArkProvider({ id: "relay" }, urls), "isArkProvider：第三方域名 → false");
  assert(!isArkProvider({ id: "fake" }, urls), "isArkProvider：伪造前缀 volces.com.evil.example 不被误判");
  // 有 baseURL 时名字不参与判定
  assert(!isArkProvider({ id: "relay", name: "ark 中转" }, urls), "isArkProvider：有 baseURL 时名字不算数");
  // 无 baseURL → 名称特征兜底
  assert(isArkProvider({ id: "ark-coding-plan" }, {}), "isArkProvider：无 baseURL 时 id 含 ark → true");
  assert(isArkProvider({ id: "x1", name: "火山 Agent Plan" }, {}), "isArkProvider：无 baseURL 时名称含火山 → true");
  assert(!isArkProvider({ id: "deepseek-official", name: "DeepSeek" }, {}), "isArkProvider：deepseek-official 名称不含方舟特征 → false");
  assert(!isArkProvider({ id: "newapi-mo", name: "第三方中转" }, {}), "isArkProvider：无特征词路由 → false");
  assert(!isArkProvider({ id: "my-coding-plan" }, {}), "isArkProvider：通用词 coding/plan 不构成方舟特征");
}

// --- /ark-quota/providers：默认只列火山、claimed + foreignClaimed、?all=1 ---
{
  const ctx = mockCtx();
  // company 误关联了内置 deepseek-official 路由 → 应进 foreignClaimed 警告
  apply(ctx, {
    accounts: [
      { id: "personal", label: "个人", accessKeyId: "ak-p", secretAccessKey: "sk-p", region: "cn-beijing", version: "2024-01-01", providers: ["ark-coding-plan"] },
      { id: "company", label: "公司", accessKeyId: "ak-c", secretAccessKey: "sk-c", region: "cn-beijing", version: "2024-01-01", providers: ["ark-coding-plan-company", "deepseek-official"] }
    ],
    activeAccountId: "company",
    refreshMs: 300000
  });
  const { res, json } = await call(ctx, "/ark-quota/providers", "GET", "/ark-quota/providers");
  assert(res.statusCode === 200, "/providers：200");
  assert(json.providers.length === 2, "/providers：默认只列 2 个火山路由");
  assert(json.providers.every((p) => p.id.startsWith("ark-")), "/providers：列出的都是方舟路由");
  assert(json.filtered === 2 && json.totalProviders === 4, "/providers：报告隐藏了 2 个非方舟路由（共 4）");
  assert(json.claimed["ark-coding-plan"] === "personal", "/providers：带出 claimed 归属");
  assert(json.claimed["deepseek-official"] === "company", "/providers：误关联路由也在 claimed 里");
  // 误关联的非方舟路由单独点名
  assert(Array.isArray(json.foreignClaimed) && json.foreignClaimed.length === 1, "/providers：foreignClaimed 有 1 条");
  assert(json.foreignClaimed[0].id === "deepseek-official" && json.foreignClaimed[0].owner === "company",
    "/providers：foreignClaimed 点名 deepseek-official 属于 company");
  assert(!JSON.stringify(json).includes("ak-p") && !JSON.stringify(json).includes("sk-c"), "/providers：不泄露密钥");
  // ?all=1 列出全部
  const allRes = await call(ctx, "/ark-quota/providers", "GET", "/ark-quota/providers?all=1");
  assert(allRes.json.providers.length === 4, "/providers?all=1：列出全部 4 个路由");
  assert(allRes.json.providers.some((p) => p.id === "deepseek-official"), "/providers?all=1：包含 deepseek-official");
  assert(allRes.json.filtered === 0, "/providers?all=1：filtered 为 0");
  // 无 llm 服务时回空列表而不是 500
  const bare = mockCtx({ llm: false });
  apply(bare, multiConfig());
  const bareRes = await call(bare, "/ark-quota/providers", "GET", "/ark-quota/providers");
  assert(bareRes.res.statusCode === 200 && bareRes.json.providers.length === 0, "无 llm 服务时 providers 返回空列表");
  // 读不到别插件设置时，靠名称特征仍能筛出方舟路由
  const nameOnly = mockCtx({ otherSettings: false });
  apply(nameOnly, multiConfig());
  const noSettings = await call(nameOnly, "/ark-quota/providers", "GET", "/ark-quota/providers");
  assert(noSettings.json.providers.length === 2, "无 baseURL 时按名称特征仍筛出 2 个 ark- 路由");
}

// --- /ark-quota/routes：pin / unbind / rename（旧 /accounts 已下线）---
{
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  // pin：固定到某路由（它必须已绑定凭据组）
  const pinned = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "ark-coding-plan" });
  assert(pinned.res.statusCode === 200, "routes pin：200");
  assert(pinned.json.pinnedRoute === "ark-coding-plan" && pinned.json.activeAccountId === "personal", "routes pin：pinnedRoute 与默认账号更新");
  // pin 未绑定路由 → 404
  const pinGhost = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "no-such-route" });
  assert(pinGhost.res.statusCode === 404 && pinGhost.json.code === "route-not-bound", "routes pin 未绑定路由 → 404");
  // pin 空串 = 恢复自动跟随
  const unpinned = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "" });
  assert(unpinned.res.statusCode === 200 && unpinned.json.pinnedRoute === "", "routes pin 空串：恢复自动跟随");
  // rename：改凭据组显示名（按路由定位）
  const renamed = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "rename", route: "ark-coding-plan", label: "我的个人号" });
  assert(renamed.res.statusCode === 200, "routes rename：200");
  assert(renamed.json.routes.find((r) => r.route === "ark-coding-plan")?.accountLabel === "我的个人号", "routes rename：显示名更新");
  // clear：清除配置（整组凭据作废；company 组仍在，路由视图里只剩它）
  const clearedRes = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "clear", route: "ark-coding-plan" });
  assert(clearedRes.res.statusCode === 200, "routes clear：200");
  assert(!clearedRes.json.routes.some((r) => r.route === "ark-coding-plan"), "routes clear：路由从视图移除");
  assert(!clearedRes.json.accounts.some((a) => a.id === "personal"), "routes clear：该火山账号凭据组整个删除");
  // 被清组若正是固定目标，固定解除
  const pinThenClear = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "ark-coding-plan-company" });
  assert(pinThenClear.json.pinnedRoute === "ark-coding-plan-company", "先 pin 到 company 路由");
  const clearPinned = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "clear", route: "ark-coding-plan-company" });
  assert(clearPinned.json.pinnedRoute === "", "routes clear：固定目标被清后自动解除固定");
  // clear 未绑定路由 → 404
  const unGhost = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "clear", route: "never-bound" });
  assert(unGhost.res.statusCode === 404 && unGhost.json.code === "route-not-bound", "routes clear 未绑定 → 404");
  // 非法 action / GET
  const badAction = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes", { action: "nope" });
  assert(badAction.res.statusCode === 400 && badAction.json.code === "bad-action", "routes：非法 action → 400");
  const getRes = await call(ctx, "/ark-quota/routes", "GET", "/ark-quota/routes");
  assert(getRes.res.statusCode === 405, "routes：GET → 405");
  assert(!JSON.stringify(clearPinned.json).includes("ak-company"), "routes：响应不泄露密钥");
  // 旧 /ark-quota/accounts 路由已下线
  assert(!ctx.__routes.has("/ark-quota/accounts"), "/ark-quota/accounts 已下线");
}

// --- routes 视图：routesSummary 以路由为单位、带显示名与配置状态 ---
{
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  const status = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(Array.isArray(status.json.routes) && status.json.routes.length === 2, "status 带出 2 个已绑定路由");
  const cp = status.json.routes.find((r) => r.route === "ark-coding-plan");
  assert(cp && cp.name === "火山 Coding Plan" && cp.configured === true && cp.accountId === "personal",
    "routes 视图：id/显示名/配置状态/归属账号齐全");
}

// --- /ark-quota/stats 路由已移除（请求统计功能下线）---
{
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  assert(!ctx.__routes.has("/ark-quota/stats"), "/ark-quota/stats 路由已不再注册");
  const gone = await call(ctx, "/ark-quota/stats", "GET", "/ark-quota/stats");
  assert(gone.__missing === true, "调用 /ark-quota/stats 找不到 handler（功能已下线）");
  // 其余路由仍在
  for (const p of ["/ark-quota", "/ark-quota/status", "/ark-quota/providers", "/ark-quota/credentials", "/ark-quota/routes", "/ark-quota/settings"]) {
    assert(ctx.__routes.has(p), `路由仍注册：${p}`);
  }
  assert(!ctx.__routes.has("/ark-quota/accounts"), "/ark-quota/accounts 已下线");
}

// --- 快照域正常打开（域名合法、schema 不接受 null）---
{
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  await new Promise((r) => setTimeout(r, 20));
  const spec = ctx.__openedSpec();
  assert(spec !== null, "快照域成功打开");
  assert(/^[a-z][a-z0-9_]*$/.test(spec.name) && !spec.name.includes("-"), "落盘域名符合 UNIT_NAME_RE（不含连字符）");
  // storageDomain 不可用时不报错（退回内存态）
  const bare = mockCtx({ storageDomain: false });
  apply(bare, multiConfig());
  await new Promise((r) => setTimeout(r, 20));
  assert(bare.__openedSpec() === null, "无 storageDomain 时不开域，插件不报错");
}

// --- 跨站请求防护：POST 路由只接受同源调用 ---
{
  // 纯函数判定
  assert(isSameOriginRequest({ headers: { "sec-fetch-site": "same-origin" } }) === true, "Sec-Fetch-Site: same-origin 放行");
  assert(isSameOriginRequest({ headers: { "sec-fetch-site": "none" } }) === true, "Sec-Fetch-Site: none 放行");
  assert(isSameOriginRequest({ headers: { "sec-fetch-site": "cross-site" } }) === false, "Sec-Fetch-Site: cross-site 拒绝");
  assert(isSameOriginRequest({ headers: { "sec-fetch-site": "same-site" } }) === false, "Sec-Fetch-Site: same-site（别的 localhost 端口）拒绝");
  assert(isSameOriginRequest({ headers: {} }) === true, "无任何头（curl 等非浏览器客户端）放行");
  assert(isSameOriginRequest({}) === true, "headers 缺失也不抛错");
  assert(isSameOriginRequest({ headers: { origin: "http://evil.example", host: "127.0.0.1:3080" } }) === false,
    "旧浏览器兜底：Origin 主机与 Host 不一致 → 拒绝");
  assert(isSameOriginRequest({ headers: { origin: "http://127.0.0.1:3080", host: "127.0.0.1:3080" } }) === true,
    "旧浏览器兜底：Origin 与 Host 一致 → 放行");
  assert(isSameOriginRequest({ headers: { origin: "not a url" } }) === false, "Origin 非法 URL → 拒绝");

  // 路由级：三个会写配置的 POST 都拦
  const ctx = mockCtx();
  apply(ctx, multiConfig());
  const xsite = { "sec-fetch-site": "cross-site" };
  const same = { "sec-fetch-site": "same-origin" };
  const r1 = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 60000 }, xsite);
  assert(r1.res.statusCode === 403 && r1.json.code === "cross-origin", "cross-site POST /settings → 403");
  const r2 = await call(ctx, "/ark-quota/credentials", "POST", "/ark-quota/credentials",
    { route: "ark-coding-plan", accessKeyId: "a", secretAccessKey: "b" }, xsite);
  assert(r2.res.statusCode === 403 && r2.json.code === "cross-origin", "cross-site POST /credentials → 403");
  const r3 = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "ark-coding-plan" }, xsite);
  assert(r3.res.statusCode === 403 && r3.json.code === "cross-origin", "cross-site POST /routes → 403");
  // 同源请求不受影响
  const okSettings = await call(ctx, "/ark-quota/settings", "POST", "/ark-quota/settings", { refreshMs: 60000 }, same);
  assert(okSettings.res.statusCode === 200, "same-origin POST /settings 正常 200");
  const okPin = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes",
    { action: "pin", route: "ark-coding-plan" }, same);
  assert(okPin.res.statusCode === 200, "same-origin POST /routes 正常 200");
  // 被跨站拦掉的 pin 没有生效（同源 pin 生效后 pinnedRoute 应为 ark-coding-plan）
  const status = await call(ctx, "/ark-quota/status", "GET", "/ark-quota/status");
  assert(status.json.pinnedRoute === "ark-coding-plan", "同源 pin 生效、跨站 pin 被拦");
}

// --- dropAccountSnaps：删账号清快照桶（纯函数）---
{
  const state = { snapsByAccount: { a: [{ t: 1, p: { monthly: 1 } }], b: [{ t: 2, p: {} }] } };
  const next = dropAccountSnaps(state, "a");
  assert(!Object.prototype.hasOwnProperty.call(next.snapsByAccount, "a"), "dropAccountSnaps：目标桶被删除");
  assert(Object.prototype.hasOwnProperty.call(next.snapsByAccount, "b"), "dropAccountSnaps：其他账号的桶保留");
  assert(state.snapsByAccount.a !== undefined, "dropAccountSnaps：不改原状态（纯函数）");
  assert(dropAccountSnaps(state, "ghost") === state, "dropAccountSnaps：目标不存在时原样返回");
  const empty = {};
  assert(dropAccountSnaps(empty, "a") === empty, "dropAccountSnaps：空态也安全");
}

// --- noPlan：两个套餐接口都成功但没有额度行 → noPlan=true ---
{
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 200,
    async text() { return JSON.stringify({ ResponseMetadata: {}, Result: {} }); }
  });
  try {
    const ctx = mockCtx();
    apply(ctx, {
      accessKeyId: "ak", secretAccessKey: "sk",
      region: "cn-beijing", version: "2024-01-01", refreshMs: 300000
    });
    const r = await call(ctx, "/ark-quota", "GET", "/ark-quota");
    assert(r.res.statusCode === 200 && r.json.ok === true, "空额度仍是 200 ok");
    assert(Array.isArray(r.json.quota) && r.json.quota.length === 0, "quota 为空数组");
    assert(r.json.noPlan === true, "两个套餐都无额度行 → noPlan=true");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- single-flight：缓存过期瞬间的并发请求只打一次上游 ---
{
  const orig = globalThis.fetch;
  let fetches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => {
    fetches += 1;
    await gate;
    return { status: 200, async text() { return JSON.stringify(codingBody); } };
  };
  try {
    const ctx = mockCtx();
    apply(ctx, {
      accessKeyId: "ak", secretAccessKey: "sk",
      region: "cn-beijing", version: "2024-01-01", refreshMs: 300000
    });
    // 先让三个请求都飞起来（共享同一个在途 Promise），再放行闸门。
    const pending = Promise.all([
      call(ctx, "/ark-quota", "GET", "/ark-quota"),
      call(ctx, "/ark-quota", "GET", "/ark-quota"),
      call(ctx, "/ark-quota", "GET", "/ark-quota?account=default")
    ]);
    release();
    const results = await pending;
    assert(fetches === 1, "3 个并发冷请求只触发 1 次上游调用（实际 " + fetches + "）");
    assert(results.every((r) => r.json && r.json.ok === true), "3 个并发等待者都拿到了额度数据");
  } finally {
    globalThis.fetch = orig;
  }
}

// --- 解绑路由：空凭据组（无密钥）的快照桶随组一起落盘清除 ---
{
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, async text() { return JSON.stringify(codingBody); } });
  try {
    const ctx = mockCtx();
    // 一个「只绑了路由、没有密钥」的临时组：解绑后应被清掉。
    apply(ctx, {
      accounts: [
        {
          id: "r_temp_route", label: "", accessKeyId: "", secretAccessKey: "",
          region: "cn-beijing", version: "2024-01-01", providers: ["temp-route"]
        }
      ],
      activeAccountId: "r_temp_route",
      refreshMs: 300000
    });
    // 无密钥空组：清除其唯一路由后整组应被清除。
    const un = await call(ctx, "/ark-quota/routes", "POST", "/ark-quota/routes", { action: "clear", route: "temp-route" });
    assert(un.res.statusCode === 200 && un.json.accounts.length === 0, "无密钥空组：清除配置后整组移除");
    await new Promise((r) => setTimeout(r, 2300));
    const after = ctx.__stored();
    assert(!after?.snapsByAccount || after.snapsByAccount["r_temp_route"] === undefined, "空组清除后不留快照桶");
  } finally {
    globalThis.fetch = orig;
  }
}

if (failed) {
  console.error(`\n${failed} 个断言失败`);
  process.exit(1);
}
console.log("\nsmoke-host: 全部通过");
