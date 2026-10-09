# 同源 HTTP 路由参考

全部路由由宿主半区注册在 DSH 服务器上，**仅本机可达**。浏览器侧通过同源 `fetch` 调用；`GET` 无需凭据，改状态类 `POST` 需要 CSRF capability + loopback `Host` + 同源元数据（见 [architecture.md](./architecture.md)）。

## `GET /ark-quota[?route=<providerId>|?account=<id>][&force=1]`

当前路由/账号的额度 JSON。`route=` 按 provider 路由解析到凭据组（侧栏跟随/固定用）；`?account=` 按内部组 id 查询（兼容）。`force=1` 跳过缓存。

```json
{
  "ok": true,
  "plan": "coding-plan",
  "status": "Normal",
  "updatedAt": 1786639101,
  "cachedAt": 1786639101000,
  "refreshMs": 300000,
  "hasReward": false,
  "accountId": "r_41571ef5438e3671",
  "accountLabel": "",
  "accounts": [{ "id": "r_41571ef5438e3671", "label": "", "configured": true, "providers": ["ark-coding-plan"] }],
  "routes": [{ "route": "ark-coding-plan", "name": "火山Coding Plan", "accountId": "r_41571ef5438e3671", "configured": true, "monthlyPct": 23 }],
  "activeAccountId": "r_41571ef5438e3671",
  "pinnedRoute": "",
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101, "used": 90, "total": 100 }
  ]
}
```

- `cachedAt` 为毫秒；`updatedAt` / `resetAt` 为 unix 秒。
- `routes` 是路由维度视图（绑定路由 + 显示名 + configured + 绑定账号最近月度已用 `monthlyPct`）；`pinnedRoute` 空 = 自动跟随。
- `quota[].burn` 携带节奏信号（字段明细见 [widget.md](./widget.md)）：
  - 周 / 月档（平均节奏为主）：`paceRatio`、`projectedAtReset`、`timeProgress` / `quotaProgress`；
  - 最近燃烧：`perDay`（指数加权 OLS 斜率，%/天）、`budgetPerDay`（恰好踩线匀速）、`ratio`、`trendRatio`、`recentProjected`（周档）、`exhaustAt`（预计耗尽时刻，ms）、`sampleMs` / `samples`；
  - 权威预测：`forecast`（预测段终点 %）、`forecastBasis`（`recent` / `average`；月档恒 `average`）；
  - 仅 5 小时滑窗档：`agingPerDay`（老化流出率）、`netPerDay`（净增速）、`recoverAt`（封顶后回落到 95% 的预计时刻）；`status` 判定口径见 [widget.md](./widget.md)。
- 失败：`{ "ok": false, "code": "unauthorized" | "missing-auth" | "unknown-account" | "upstream" | "network", "message": "…", "accounts": [...], "routes": [...] }`（HTTP 401 / 404 / 502 / 504）。路由列表随失败一起返回，坏密钥不破坏切换器。

## `GET /ark-quota/status`

布尔摘要，不携带密钥：`{ ok, configured, accessKeyIdSet, secretAccessKeySet, refreshMs, accounts, routes, activeAccountId, pinnedRoute }`。

## `GET /ark-quota/providers`

`{ ok, providers: [{ id, name }], claimed: { <providerId>: <groupId> }, foreignClaimed: [...], filtered, totalProviders }`——`llm` 服务注册的路由及各组归属。默认只列火山方舟端点路由，`?all=1` 全列。绝不携带凭据。

## `GET|HEAD /ark-quota/csrf`

`{ ok: true, token }`——每插件实例随机 CSRF capability；浏览器改状态 POST 必须以 `X-Ark-Quota-CSRF` 头携带。`HEAD` 无响应体。

## `POST /ark-quota/credentials`

`{ route?: <providerId>, account?: <id>, accessKeyId, secretAccessKey }`。按路由保存（推荐）：首次绑定自动建组，相同 AK/SK 自动合并；`account` 为兼容入口。只接受固定形状字符串，密钥不回显（响应仅布尔与组/路由 id）。空 body → 400，GET → 405。

## `POST /ark-quota/routes`

`{ action: "pin" | "clear" | "rename", route, label? }`：`pin` 固定侧栏目标（`route: ""` = 自动跟随）、`clear` 解绑（空且无密钥的组随之移除）、`rename` 改组显示名。`unbind` 作为 `clear` 的兼容别名。返回与 `/status` 相同的负载。

## `POST /ark-quota/settings`

`{ refreshMs }`：改轮询节奏，值必须命中允许档位（见 [settings.md](./settings.md)），写入后热应用。
