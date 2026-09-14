// burn-rate 模型回归断言（无框架，直接 node tools/verify-burn.mjs）：
// 滑窗净额模型、老化速率、恢复时刻、回落阈值截断、加权 OLS、固定周期投影。
import { burnRate, foldSnap, migrateStatsState } from "../lib/index.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
let pass = 0;
function assert(cond, msg) {
  if (!cond) { console.error("✗ " + msg); process.exitCode = 1; }
  else { console.log("✓ " + msg); pass++; }
}
// 构造快照：[[多少分钟前, 百分比], ...]
function mk(level, arr) {
  const now = Date.now();
  return arr.map(([agoMin, pct]) => ({ t: now - agoMin * 60000, p: { [level]: pct } }));
}

// ── 1. 滑窗小幅回落不再被当成重置截断 ────────────────────────────
{
  const now = Date.now();
  // 老化段（40~30 分钟前）平缓：20→22（≈12%/时）；近期猛烧：22→50，
  // 中间一次 40→38 的老化回落。
  const snaps = mk("session", [[40, 20], [30, 22], [20, 40], [10, 38], [0, 50]]);
  const r = burnRate(snaps, "session", 50, now, null);
  assert(r !== null, "小幅回落场景仍能算出 session burn");
  assert(r.perDay > 800, "近期速率合理（≈1000%/天），实际 " + Math.round(r.perDay));
  assert(r.netPerDay !== null && r.netPerDay > 0, "滑窗净增速为正（水位还在涨），实际 " + Math.round(r.netPerDay));
  assert(r.exhaustAt !== null && r.exhaustAt > now, "净增速为正 → 给出用完时刻");
  assert(r.projectedAtReset === null, "滑窗档不做时间进度投影");
  assert(r.agingPerDay !== null, "窗口前 [60,30] 分钟有快照 → 算出老化速率");
}

// ── 2. 滑窗净增速 ≤ 0 时不报用完（老化兜得住）────────────────────
{
  const now = Date.now();
  // 30 分钟 10% → 12%（≈4%/时，远低于预算 20%/时）。
  const snaps = mk("session", [[30, 10], [20, 10.5], [10, 11], [0, 12]]);
  const r = burnRate(snaps, "session", 12, now, null);
  assert(r.netPerDay !== null && r.netPerDay <= 0.05, "低速使用净增速 ≈ 0，实际 " + Math.round(r.netPerDay));
  assert(r.exhaustAt === null, "净增速 ≤ 0 → 不报用完时刻");
}

// ── 3. 撞线后给恢复时刻 ─────────────────────────────────────────
{
  const now = Date.now();
  // 老化段（60~30 分钟前）：约 20%/时 ≈ 480%/天，30 分钟前水位 ≈20。
  const agingPts = [[60, 10], [50, 13.3], [40, 16.6]];
  // 近期段（30~0 分钟前）从 20 猛烧到 100。
  const recentPts = [[30, 20], [20, 50], [10, 80], [0, 100]];
  const snaps = mk("session", agingPts.concat(recentPts));
  const r = burnRate(snaps, "session", 100, now, null);
  assert(r.agingPerDay !== null && r.agingPerDay > 300, "老化速率 ≈预算（480%/天），实际 " + Math.round(r.agingPerDay));
  assert(r.recoverAt !== null && r.recoverAt > now, "撞线后给出恢复到 95% 的时刻");
  const recoverMin = (r.recoverAt - now) / 60000;
  assert(recoverMin > 5 && recoverMin < 40, "恢复时刻量级合理（≈15 分钟），实际 " + Math.round(recoverMin) + " 分钟");
}

// ── 4. 大幅回落（真重置）仍然截断 ───────────────────────────────
{
  const now = Date.now();
  // 50 分钟前 95%，40 分钟前重置到 3%，之后缓慢回升。
  const snaps = mk("weekly", [[50, 95], [40, 3], [20, 8], [0, 12]]);
  const r = burnRate(snaps, "weekly", 12, now, null);
  // 截断后只剩 40 分钟样本 < 周档最小跨度 3 小时 → 近期速率为 null（不猜）。
  assert(r === null || r.perDay === null, "重置截断后样本不足 → 不报速率（未被 95% 老点带飞）");
}

// ── 5. 周档时间进度投影仍工作（固定周期口径未被破坏）──────────────
{
  const now = Date.now();
  const resetAt = Math.floor((now + 3.5 * DAY) / 1000); // 周周期过半
  const snaps = mk("weekly", [[180, 45]]);
  const r = burnRate(snaps, "weekly", 50, now, resetAt);
  assert(r.projectedAtReset !== null, "周档仍给节奏投影");
  assert(Math.abs(r.projectedAtReset - 100) < 5, "半周期用 50% → 投影 ≈100，实际 " + Math.round(r.projectedAtReset));
  assert(r.agingPerDay === null, "固定周期档不算老化速率");
}

// ── 6. 近期停用时，预测以近期势头为准，不被平均口径带飞 ────────────
{
  const now = Date.now();
  // 6a：周周期过了 15%、额度用了 2%（平均投影 13%），但近 12 小时水位
  // 几乎不动（样本充足、≈0.1%/天）→ forecast 应停在 3% 左右、口径 recent。
  const resetA = Math.floor((now + 5.95 * DAY) / 1000);
  const snapsA = mk("weekly", [[700, 1.9], [620, 1.94], [500, 1.97], [380, 1.99], [240, 2.0], [120, 2.0], [0, 2.0]]);
  const ra = burnRate(snapsA, "weekly", 2, now, resetA);
  assert(Math.abs(ra.projectedAtReset - 13.3) < 1, "平均投影 ≈13%，实际 " + Math.round(ra.projectedAtReset));
  assert(ra.forecastBasis === "recent" && ra.forecast < 6, "forecast 走近期口径停在低位（≈3%），实际 " + (ra.forecast || 0).toFixed(1));
  assert(ra.status === "ok", "已停用 → 状态 ok");
  // 6b：周周期过半用了 80%（平均投影 160% → over），但近 12 小时已停用
  //（样本充足、≈1%/天）→ 近期外推 ≈84% 不会撞线，状态降回 ok。
  const resetB = Math.floor((now + 3.5 * DAY) / 1000);
  const snapsB = mk("weekly", [[700, 79.3], [620, 79.5], [500, 79.7], [380, 79.8], [240, 79.9], [120, 79.95], [0, 80]]);
  const rb = burnRate(snapsB, "weekly", 80, now, resetB);
  assert(rb.projectedAtReset >= 150, "平均口径投影 ≥150%（" + Math.round(rb.projectedAtReset) + "%）");
  assert(rb.forecastBasis === "recent" && rb.forecast < 88, "forecast ≈84% 不会撞线，实际 " + (rb.forecast || 0).toFixed(1));
  assert(rb.status === "ok", "近期明显放缓 → 状态降为 ok，不被平均口径误报 over（实际 " + rb.status + "）");
  // 6c：同样 80% 水位但近期只有 1 个基线点（样本 2，不可信）→ 保守保持
  // 平均口径 over，不被两点巧合解除告警。
  const rc = burnRate(mk("weekly", [[240, 79], [0, 80]]), "weekly", 80, now, resetB);
  assert(rc.forecastBasis === "average" && rc.status === "over",
    "近期样本不足 → 保守保持平均口径 over（basis=" + rc.forecastBasis + "，status=" + rc.status + "）");
}

// ── 7. 滑窗预测段按净增速外推到重置，不画理论稳态 ─────────────────
{
  const now = Date.now();
  // 已用 35%、25 分钟后重置；近期 18%/时，老化按预算 20%/时（先验）→
  // 净增速为负，host 不给 exhaustAt；客户端预测段也不应延伸（无 netPerDay>0）。
  const snaps = mk("session", [[25, 28], [15, 31], [5, 33], [0, 35]]);
  const r = burnRate(snaps, "session", 35, now, Math.floor((now + 25 * 60000) / 1000));
  // 近期斜率 ≈(35-28)/(25min)=16.8%/时 < 预算 20%/时 → 净额 ≤ 0。
  assert(r.netPerDay !== null && r.netPerDay <= 0.05, "低速使用净增速 ≈ 0，实际 " + Math.round(r.netPerDay));
  assert(r.exhaustAt === null, "净增速 ≤ 0 → 无用完时刻（不会画到 88% 稳态）");
  // 猛烧场景：窗口前（60~30 分钟前）很闲 ≈8%/时，近期半小时烧到 40%
  //（≈60%/时）→ 净增速为正；但 1 小时后（重置/滚动）水位才到 ~92%、到不
  // 了顶，因此耗尽时刻晚于重置，宿主应返回 exhaustAt=null（越过重置的外推
  // 无意义——这正是「4h31m 后重置却算出更晚用完」的 bug 修正）。
  const hot = mk("session", [[60, 4], [50, 5], [40, 6], [30, 8], [20, 18], [10, 29], [0, 40]]);
  const rh = burnRate(hot, "session", 40, now, Math.floor((now + 3600000) / 1000));
  assert(rh.netPerDay > 0, "猛烧且老化低 → 净增速为正");
  const projected = 40 + rh.netPerDay / 24 * 1;
  assert(projected < 100, "净增速外推到重置时的水位（" + Math.round(projected) + "%）到不了顶");
  assert(rh.exhaustAt === null, "重置前到不了顶 → exhaustAt 为 null（不把越过重置的时刻报成用完）");
  // 反例：同样的速率但水位已 90%，重置前确实会撞线 → 给出耗尽时刻。
  const rh2 = burnRate(hot, "session", 90, now, Math.floor((now + 3600000) / 1000));
  assert(rh2.exhaustAt !== null && rh2.exhaustAt <= now + 3600000,
    "高水位时重置前会撞线 → 给用完时刻且不晚于重置");
}

// ── 7. foldSnap 采样与 migrate 不回归 ───────────────────────────
{
  const now = Date.now();
  let snaps = [];
  snaps = foldSnap(snaps, [{ level: "monthly", percentUsed: 10 }], now - 10 * 60000);
  snaps = foldSnap(snaps, [{ level: "monthly", percentUsed: 12 }], now);
  assert(snaps.length === 2, "间隔 >5 分钟的快照都保留（" + snaps.length + " 条）");
  const migrated = migrateStatsState({ snapsByAccount: { ok: snaps, bad: "not-array" } }, now);
  assert(Array.isArray(migrated.snapsByAccount.ok) && migrated.snapsByAccount.bad === undefined,
    "migrate 丢弃非法账号桶");
}

console.log("\n" + pass + " 项断言通过");
