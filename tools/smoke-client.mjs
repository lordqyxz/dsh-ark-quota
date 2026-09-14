#!/usr/bin/env node
// Client-half smoke test. react / react-dom / jsdom are test-only — install
// them into the gitignored scratch-test/ dir, never into package.json:
//   mkdir -p scratch-test && cd scratch-test && npm i react react-dom jsdom
// Run from the repo root:  node tools/smoke-client.mjs
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, "scratch-test");
const scratchReq = existsSync(join(scratch, "node_modules", "react"))
  ? createRequire(join(scratch, "package.json"))
  : null;
if (!scratchReq) {
  console.error("scratch-test/node_modules/react 缺失；请在 scratch-test/ 里安装 react / react-dom / jsdom（该目录已被 gitignore）。");
  process.exit(1);
}

const React = scratchReq("react");
const { createRoot } = scratchReq("react-dom/client");
const { JSDOM } = scratchReq("jsdom");

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed += 1; console.error("FAIL:", msg); }
  else console.log("ok:", msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── jsdom 环境 ───────────────────────────────────────────────
const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "http://127.0.0.1:3080/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// ── mock fetch ───────────────────────────────────────────────
const calls = [];
const nowSec = Math.floor(Date.now() / 1000);
const accounts = [
  { id: "company", label: "公司号", configured: true, providers: ["ark-coding-plan-company"] },
  { id: "personal", label: "个人号", configured: true, providers: ["ark-coding-plan"] }
];
// 路由维度视图：已绑定凭据的路由（侧栏切换器与设置页的权威身份）。
const routes = [
  { route: "ark-coding-plan", name: "火山Coding Plan", accountId: "personal", accountLabel: "个人号", configured: true, monthlyPct: 23 },
  { route: "ark-coding-plan-company", name: "火山Agent Plan", accountId: "company", accountLabel: "公司号", configured: true, monthlyPct: 90 }
];
const quotaBase = {
      ok: true, plan: "coding-plan", refreshMs: 300000, cachedAt: Date.now(),
      accountId: "personal", accounts, routes, pinnedRoute: "", hasReward: true,
      quota: [
        // 99.9% 用例：绝不能显示成 100%
        { level: "session", percentUsed: 99.9, percentRemaining: 0.1, resetAt: nowSec + 2 * 3600, used: null, total: null },
        // 周档：撞线投影（>100%）→ 应出现「用完」结论
        { level: "weekly", percentUsed: 80, percentRemaining: 20, resetAt: nowSec + 3 * 86400, used: null, total: null },
        // 月档：安全投影
        { level: "monthly", percentUsed: 23, percentRemaining: 77, resetAt: nowSec + 20 * 86400, used: null, total: null }
      ],
      burn: {
        monthly: {
          // 月档固定走平均口径：额度进度 23% ÷ 时间进度 33% = 0.7× → 投影 69%，正常
          perDay: 3.2, budgetPerDay: 3.33, ratio: 0.96, paceRatio: 0.7, trendRatio: 1.37, status: "ok",
          exhaustAt: Date.now() + 20 * 86400000,
          projectedAtReset: 69, forecast: 69, forecastBasis: "average",
          timeProgress: 0.33, quotaProgress: 0.23, sampleMs: 86400000, samples: 14
        },
        weekly: {
          // 平均节奏投影 140%；近期样本充足（8 个）→ forecast 走近期口径 200%，
          // 按近期速度 12 小时后用完（比重置早）
          perDay: 40, budgetPerDay: 14.3, ratio: 2.8, paceRatio: 1.4, trendRatio: 2.0, status: "over",
          exhaustAt: Date.now() + 12 * 3600000,
          projectedAtReset: 140, recentProjected: 200, forecast: 200, forecastBasis: "recent",
          timeProgress: 0.57, quotaProgress: 0.8, sampleMs: 12 * 3600000, samples: 8
        }
      }
    };
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push(u);
  let body = { ok: false };
  if (u.startsWith("/ark-quota/stats")) {
    body = { ok: false, code: "should-not-be-called" };
  } else if (u.startsWith("/ark-quota/status")) {
    body = { ok: true, configured: true, refreshMs: 300000, activeAccountId: "personal", accounts, routes, pinnedRoute: "" };
  } else if (u.startsWith("/ark-quota/providers")) {
    body = {
      ok: true,
      providers: [
        { id: "ark-coding-plan", name: "火山Coding Plan" },
        { id: "ark-coding-plan-company", name: "火山Agent Plan" }
      ],
      claimed: { "ark-coding-plan-company": "company", "ark-coding-plan": "personal" },
      foreignClaimed: [],
      filtered: 1
    };
  } else if (u.startsWith("/ark-quota/routes")) {
    body = { ok: true, accounts, routes, activeAccountId: "personal", pinnedRoute: "", configured: true, refreshMs: 300000 };
  } else if (u.startsWith("/ark-quota/credentials")) {
    body = { ok: true, accounts, routes, activeAccountId: "personal", pinnedRoute: "", configured: true, refreshMs: 300000 };
  } else if (u.startsWith("/ark-quota")) {
    body = { ...quotaBase };
  }
  return { json: async () => body, status: 200, ok: true };
};

// ── 加载 bundle ──────────────────────────────────────────────
let captured = null;
dom.window.__ModuleLoader__ = { load: (reg) => { captured = reg; } };
const source = readFileSync(join(root, "lib", "client.js"), "utf8");
(0, eval)(source);
if (!captured) { console.error("bundle 没有注册工厂"); process.exit(1); }
const mod = captured.factory((id) => {
  if (id === "react") return React;
  if (id === "react/jsx-runtime") return scratchReq("react/jsx-runtime");
  throw new Error("unexpected require: " + id);
});

// ── 捕获 slot 注册 + 模型跟随服务 mock ───────────────────────
const slots = new Map();
// 模型跟随：mock sessions.list（当前会话）与 modelDirectories（per-session
// 模型目录 store）。smoke 里手动驱动它们，断言卡片跟随 provider 切账号。
const sessionListeners = new Set();
const sessionStore = {
  snap: { current: "sess-1" },
  subscribe: (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); },
  getSnapshot: () => sessionStore.snap
};
const dirListeners = new Set();
const directory = {
  store: {
    snap: { current: null, status: "loading" },
    subscribe: (fn) => { dirListeners.add(fn); return () => dirListeners.delete(fn); },
    getSnapshot: () => directory.store.snap
  }
};
const modelDirectories = {
  directoryFor: (id) => {
    if (id !== sessionStore.snap.current) throw new Error("unknown session " + id);
    return directory;
  }
};
let injectCb = null;
const ctx = {
  slots: {
    inject: (name, cb) => { slots.set(name, cb()); },
    register: (desc, Component) => ({ desc, Component })
  },
  // 与宿主一致：依赖就绪后回调，参数是带 effect 的 scope。
  inject: (deps, cb) => { injectCb = { deps, cb }; }
};
mod.apply(ctx);
if (injectCb && injectCb.deps.includes("modelDirectories")) {
  let cleanup = null;
  const scope = {
    sessions: { list: sessionStore },
    modelDirectories,
    effect: (fn) => { cleanup = fn(); }
  };
  injectCb.cb(scope);
  if (typeof cleanup !== "function") throw new Error("跟随 effect 未返回清理函数");
} else {
  throw new Error("apply 未注册 modelDirectories inject");
}
// 工具：改当前会话的 provider 并通知订阅者。
async function setProvider(provider) {
  directory.store.snap = { current: provider ? { provider, model: "m1" } : null, status: "ready" };
  dirListeners.forEach((fn) => fn());
  await wait(150);
}
async function setSession(id) {
  sessionStore.snap = { current: id };
  sessionListeners.forEach((fn) => fn());
  await wait(150);
}
const widgetReg = [...slots.values()].find((r) => r.desc.id === "ark-quota" && r.desc.name === "sidebar.footer.action");
const settingsReg = [...slots.values()].find((r) => r.desc.id === "ark-quota" && r.desc.name === "settings.section");
if (!widgetReg || !settingsReg) { console.error("slot 注册缺失：", [...slots.keys()]); process.exit(1); }

// ── 挂载 ─────────────────────────────────────────────────────
const rootEl = document.getElementById("root");
const root2 = createRoot(rootEl);
root2.render(React.createElement(
  "div", null,
  React.createElement("div", { id: "wide" }, React.createElement(widgetReg.Component, { wide: true })),
  React.createElement("div", { id: "rail" }, React.createElement(widgetReg.Component, { wide: false })),
  React.createElement("div", { id: "settings" }, React.createElement(settingsReg.Component, {}))
));

await wait(500);

const wideEl = document.getElementById("wide");
const wide = wideEl.textContent;
const rail = document.getElementById("rail").textContent;
const settings = document.getElementById("settings").textContent;

// 宽卡：核心内容
assert(wide.includes("方舟额度"), "宽卡渲染标题");
assert(wide.includes("5小时") && wide.includes("近1周") && wide.includes("近1月"), "宽卡渲染三档额度");
assert(wide.includes("Coding Plan"), "底部信息行有套餐徽章");
assert(wide.includes("含奖励额度"), "hasReward 时显示含奖励额度");
assert(wide.includes("分钟前更新") || wide.includes("刚刚更新"), "显示更新时间");

// 99.9% 不得显示成 100%
assert(!wide.includes("100%"), "99.9% 没有被四舍五入成 100%");
assert(wide.includes("99.9%"), "99.9% 保留一位小数显示");

// 结论行已下线：状态靠进度条与速率颜色表达，细节全在悬停提示（title）里
assert(!wide.includes("节奏正常") && !wide.includes("余量偏紧"), "行内不再渲染结论文字");
assert(wideEl.innerHTML.includes("用完"), "用完时刻细节在悬停提示里");
assert(wideEl.innerHTML.includes("比重置早"), "「比重置早…」细节在悬停提示里");
assert(wideEl.innerHTML.includes("时间 ") && wideEl.innerHTML.includes("额度 "), "时间/额度进度细节在悬停提示里");
// 速率胶囊在行内
assert(wide.includes("%/天"), "行内显示速率胶囊（%/天）");

// 提供方切换器：头部 <select>，多个已绑定路由
const selects = wideEl.querySelectorAll("select");
assert(selects.length >= 1, "头部渲染提供方下拉 <select>");
const opts = [...(selects[0]?.querySelectorAll("option") || [])].map((o) => o.textContent);
assert(opts.some((t) => t.includes("火山")) && opts.length >= 3, "下拉含两个路由 + 自动项");
assert(opts.some((t) => t.trim() === "自动"), "下拉首项为「自动」");
assert(!opts.some((t) => t.includes("自动跟随当前模型")), "首项不再用长文案「自动跟随当前模型」");

// ── 模型跟随：切 provider → 取数路由自动切换（route= 查询参数）──
{
  const quotaUrls = () => calls.filter((u) => u.startsWith("/ark-quota?") || u === "/ark-quota");
  // 初始：directory 还没有 current（loading）→ 请求不带 route（宿主默认）
  assert(quotaUrls().some((u) => !u.includes("route=") && !u.includes("account=")), "无 provider 时取默认");
  // 切到 company 关联路由 → 请求应带 route=ark-coding-plan-company
  await setProvider("ark-coding-plan-company");
  assert(quotaUrls().some((u) => u.includes("route=ark-coding-plan-company")),
    "provider=ark-coding-plan-company → 跟随到该路由");
  // 下拉应处于自动模式（select 值为 __auto__）
  const rtSelect = wideEl.querySelectorAll("select")[0];
  assert(rtSelect && rtSelect.value === "__auto__", "自动模式下下拉值为 __auto__");
  // 切到 personal 关联路由
  await setProvider("ark-coding-plan");
  assert(quotaUrls().some((u) => u.includes("route=ark-coding-plan")),
    "provider=ark-coding-plan → 跟随到该路由");
  // 切到无关联的 provider（deepseek 官方直连）→ 回落（不带 route）
  await setProvider("deepseek-official");
  assert(quotaUrls().filter((u) => !u.includes("route=") && !u.includes("account=")).length > 0,
    "无关联 provider → 回落宿主默认");
  await setProvider(null);
  assert(true, "provider 为空时不抛错");
  // 切会话：新会话 directoryFor 抛错（模拟子代理/已销毁会话）→ 静默降级
  sessionStore.snap = { current: "sess-dead" };
  modelDirectories.directoryFor = () => { throw new Error("no scope"); };
  sessionListeners.forEach((fn) => fn());
  await wait(150);
  assert(true, "directoryFor 抛错时静默降级不崩");
  // 恢复正常会话
  modelDirectories.directoryFor = (id) => {
    if (id !== "sess-2") throw new Error("unknown session " + id);
    return directory;
  };
  await setSession("sess-2");
  await setProvider("ark-coding-plan-company");
  assert(quotaUrls().some((u) => u.includes("route=ark-coding-plan-company")), "切会话后仍能跟随");
  // 手动固定：在下拉里选 ark-coding-plan → POST /routes pin，之后 provider 变化不再跟随
  const freshSelect = wideEl.querySelectorAll("select")[0];
  const planOpt = [...freshSelect.querySelectorAll("option")].find((o) => o.value === "ark-coding-plan");
  assert(!!planOpt, "找到 ark-coding-plan 选项");
  freshSelect.value = planOpt.value;
  freshSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await wait(200);
  assert(calls.some((u) => u.startsWith("/ark-quota/routes")), "手动固定 POST /ark-quota/routes");
  const fixedSelect = wideEl.querySelectorAll("select")[0];
  assert(fixedSelect.value === "ark-coding-plan", "手动固定后下拉值为该路由");
  // provider 再切到 company，也不应出现新的 company 路由请求（固定在 plan）
  const beforeFixed = quotaUrls().filter((u) => u.includes("route=ark-coding-plan-company")).length;
  await setProvider("ark-coding-plan-company");
  const afterFixed = quotaUrls().filter((u) => u.includes("route=ark-coding-plan-company")).length;
  assert(afterFixed === beforeFixed, "手动固定后 provider 变化不再跟随");
  // 选回「自动跟随当前模型」→ 恢复跟随
  const autoOpt = [...wideEl.querySelectorAll("select")[0].querySelectorAll("option")]
    .find((o) => o.textContent.trim() === "自动");
  const autoSelect = wideEl.querySelectorAll("select")[0];
  autoSelect.value = autoOpt.value;
  autoSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await wait(200);
  assert(quotaUrls().filter((u) => u.includes("route=ark-coding-plan-company")).length > afterFixed,
    "选回自动跟随后恢复跟随");
}

// 已移除的 stats / 显示模式
assert(!wide.includes("请求总数"), "不再显示请求总数");
assert(!wide.includes("成功率"), "不再显示成功率");
assert(!wide.includes("健康"), "不再显示健康条");
assert(!/已用|剩余/.test(wide.replace(/已用百分比|近1月已用/g, "")), "头部没有已用/剩余切换胶囊");
assert(!wide.includes("个提供方"), "底部不再显示 N 个提供方");

// rail 药丸：近1月已用百分比
assert(/\d+%/.test(rail), "rail 药丸显示百分比");
assert(!rail.includes("100%"), "rail 药丸不出现 100%");

// 设置页：以模型提供方路由为入口；首次加载自动选中第一个路由
assert(settings.includes("模型提供方"), "设置页有「模型提供方」选择器");
assert(settings.includes("AccessKey"), "自动选中第一个路由后直接显示 AK/SK 输入框");
assert(settings.includes("刷新频率"), "刷新频率是全局偏好，直接显示");
assert(!settings.includes("添加账号") && !settings.includes("设为默认"), "设置页不再有账号增删/设为默认按钮");
assert(!settings.includes("解绑"), "设置页不出现「解绑」措辞");
{
  const settingsEl = document.getElementById("settings");
  const routeSelect = settingsEl.querySelector("select");
  assert(!!routeSelect, "设置页渲染提供方下拉");
  const opt = [...routeSelect.querySelectorAll("option")].find((o) => o.value === "ark-coding-plan");
  assert(!!opt, "提供方下拉含 ark-coding-plan");
  // 自动选中的应该是已配置的第一个路由（status 里 routes[0]=ark-coding-plan，configured）。
  assert(routeSelect.value === "ark-coding-plan", "首次加载自动选中第一个已配置路由（实际 " + routeSelect.value + "）");
  const after = settingsEl.textContent;
  assert(after.includes("AccessKey") && after.includes("Secret Access Key"), "自动选中后出现 AK/SK 输入");
  // 标签不带路由后缀：AK/SK 标题就是纯字段名。
  assert(!after.includes("AccessKey ID ·"), "AK 标签不带路由后缀");
  // 下拉选项不再标注「已配置」后缀（无「· 已配置」）。
  const optionTexts = [...routeSelect.querySelectorAll("option")].map((o) => o.textContent);
  assert(!optionTexts.some((t) => t.includes("已配置")), "下拉选项不显示「已配置」后缀");
  // 「清除配置」紧挨保存按钮。
  const buttons = [...settingsEl.querySelectorAll("button")].map((b) => b.textContent);
  const saveIdx = buttons.indexOf("保存");
  const clearIdx = buttons.indexOf("清除配置");
  assert(saveIdx >= 0, "保存按钮文案为「保存」");
  assert(clearIdx >= 0 && clearIdx === saveIdx + 1, "「清除配置」按钮紧挨在「保存」之后");
  // 切换到另一个已配置路由：仍有一个清除按钮、且在保存旁。
  routeSelect.value = "ark-coding-plan-company";
  routeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await wait(150);
  const btns2 = [...settingsEl.querySelectorAll("button")].map((b) => b.textContent);
  assert(btns2.indexOf("清除配置") === btns2.indexOf("保存") + 1, "切换路由后「清除配置」仍紧挨保存");
}
// 侧栏自动模式不再显示 ⛓ 图标。
assert(!wide.includes("⛓"), "侧栏自动模式无 ⛓ 图标");
// 设置页顶部提示精简：不再出现 deepseek / 域名等技术细节。
assert(!settings.includes("deepseek") && !settings.includes("volces.com"), "设置页顶部提示已精简（无 deepseek/域名细节）");
// 防自动填充诱饵
assert(!!document.querySelector('input[name="ark-decoy-username"]'), "存在防填充诱饵用户名框");
assert(!!document.querySelector('input[name="ark-decoy-password"]'), "存在防填充诱饵密码框");

// 网络：从未请求 /ark-quota/stats
const statsCalls = calls.filter((u) => u.startsWith("/ark-quota/stats"));
assert(statsCalls.length === 0, "客户端不再请求 /ark-quota/stats（实际 " + statsCalls.length + " 次）");

// rail 药丸不再是死按钮：aria-label 说明点击行为，点击不抛错
const railBtn = document.getElementById("rail").querySelector("button");
assert(!!railBtn, "rail 药丸渲染为 button");
assert((railBtn.getAttribute("aria-label") || "").includes("展开侧边栏"), "正常态 rail 按钮 aria-label 提示展开侧边栏");
railBtn.click();
assert(true, "点击 rail 药丸不抛错（无宿主按钮时静默降级）");

// 标签页切回前台 → 补一次拉取（后台定时器会被浏览器节流）
{
  // jsdom 默认 visibilityState 为 "hidden"，这里模拟浏览器里前台标签页的状态。
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  const before = calls.filter((u) => u.startsWith("/ark-quota?") || u === "/ark-quota").length;
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await wait(200);
  const after = calls.filter((u) => u.startsWith("/ark-quota?") || u === "/ark-quota").length;
  assert(after > before, "visibilitychange 回到前台触发一次额度拉取（" + before + " → " + after + "）");
}

// noPlan：两个套餐都无额度 → 明确提示未订阅，而不是含糊的「暂无额度数据」
{
  const standardFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/ark-quota/status")) {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 300000, activeAccountId: "personal", accounts, routes, pinnedRoute: "" }), status: 200 };
    }
    if (u.startsWith("/ark-quota/providers")) {
      return { json: async () => ({ ok: true, providers: [], claimed: {}, foreignClaimed: [], filtered: 0 }), status: 200 };
    }
    // 额度接口：成功但空 quota + noPlan
    return {
      json: async () => ({ ok: true, plan: "coding-plan", refreshMs: 300000, cachedAt: Date.now(), accountId: "personal", accounts, routes, pinnedRoute: "", quota: [], noPlan: true, burn: {} }),
      status: 200
    };
  };
  const np = document.createElement("div");
  document.body.appendChild(np);
  const npRoot = createRoot(np);
  npRoot.render(React.createElement(widgetReg.Component, { wide: true }));
  await wait(300);
  assert(np.textContent.includes("未检测到方舟套餐订阅"), "noPlan 时提示未检测到套餐订阅");
  assert(np.textContent.includes("检查账号设置"), "noPlan 空态给出检查设置的入口");
  assert(!np.textContent.includes("暂无额度数据（"), "noPlan 时不再显示通用的「暂无额度数据」");

  // 出错态 rail 药丸：点击行为指向设置
  const errRail = document.createElement("div");
  document.body.appendChild(errRail);
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("/ark-quota") && !u.includes("/status") && !u.includes("/providers")) {
      return { json: async () => ({ ok: false, code: "unauthorized", message: "访问密钥校验失败", accounts, routes }), status: 401 };
    }
    return { json: async () => ({ ok: true, configured: false, refreshMs: 300000, accounts, routes, activeAccountId: "personal", pinnedRoute: "", providers: [], claimed: {}, foreignClaimed: [], filtered: 0 }), status: 200 };
  };
  const errRoot = createRoot(errRail);
  errRoot.render(React.createElement(widgetReg.Component, { wide: false }));
  await wait(300);
  const errBtn = errRail.querySelector("button");
  assert(!!errBtn && errBtn.textContent === "!", "出错态 rail 药丸显示 !");
  assert((errBtn.getAttribute("aria-label") || "").includes("打开设置"), "出错态 rail 按钮 aria-label 提示打开设置");
  let clickThrew = false;
  try { errBtn.click(); } catch (e) { clickThrew = true; }
  assert(clickThrew === false && errRail.querySelector("button") === errBtn, "出错态点击不抛错、组件不崩");
  globalThis.fetch = standardFetch;
}

// 重置时刻已过 → 自动强制刷新一次（避免「已重置但进度条还是旧填充」）
{
  const staleFetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("/ark-quota/status")) {
      return { json: async () => ({ ok: true, configured: true, refreshMs: 300000, accounts, routes, pinnedRoute: "" }), status: 200 };
    }
    if (u.startsWith("/ark-quota/providers")) {
      return { json: async () => ({ ok: true, providers: [], claimed: {}, foreignClaimed: [], filtered: 0 }), status: 200 };
    }
    // 额度接口：resetAt 是 1 小时前（已重置），但水位仍显示高值（旧缓存）。
    return {
      json: async () => ({
        ok: true, plan: "coding-plan", refreshMs: 300000, cachedAt: Date.now(),
        accountId: "personal", accounts, routes, pinnedRoute: "",
        quota: [{ level: "monthly", percentUsed: 95, percentRemaining: 5, resetAt: Math.floor(Date.now() / 1000) - 3600 }],
        burn: {}
      }),
      status: 200
    };
  };
  globalThis.fetch = staleFetch;
  const stale = document.createElement("div");
  document.body.appendChild(stale);
  const staleRoot = createRoot(stale);
  staleRoot.render(React.createElement(widgetReg.Component, { wide: true }));
  await wait(400);
  const forceCalls = calls.filter((u) => u.includes("force=1")).length;
  assert(forceCalls >= 1, "resetAt 已过期 → 自动强制刷新（force=1 出现 " + forceCalls + " 次）");
}

console.log("\nfetch 调用：", [...new Set(calls)].join(", "));
// React 的轮询 setTimeout / useNow setInterval 会让事件循环不空，必须显式退出。
process.exit(failed > 0 ? 1 : 0);
