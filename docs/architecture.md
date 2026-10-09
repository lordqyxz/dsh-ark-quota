# 架构与安全模型

## 两半区

```
浏览器（lib/client.js）                    宿主（lib/index.js）
┌──────────────────────────┐   同源 fetch   ┌───────────────────────────────┐
│ sidebar.footer.action 卡片 │ ───────────→ │ /ark-quota* 路由（webServer）    │
│ settings.section 设置分区   │ ←─────────── │ settings.update（entry 用户层）  │
└──────────────────────────┘   JSON        │ storageDomain 快照落盘           │
                                            └──────────┬────────────────────┘
                                                       │ SigV4 变体签名（lib/signature.js）
                                                       ▼
                                            open.volcengineapi.com
                                            GetCodingPlanUsage / GetAFPUsage
```

- **宿主半区**：注册同源路由与 `ark-quota` entry 配置；每次上游调用用火山 SigV4 变体签名（AK/SK 不落任何日志/响应）；按凭据组缓存并探测 Coding Plan → Agent Plan 回落；经 `settings.update` 写 entry 用户层（热应用）。
- **客户端半区**：`window.__ModuleLoader__.load` 格式的手写 bundle（无构建步骤），只 `require` react / react-jsx-runtime；经 `ctx.slots.inject` 注册侧栏卡片与设置页分区；全部数据来自同源路由。
- 额度 OpenAPI 网关不允许 DSH origin 跨域，且不接受浏览器 cookie——同源代理 + AK/SK 签名是唯一通路。

## 密钥处理（红线）

- AK/SK 在 Config schema 声明 `role("secret")`：设置界面只写不读，describe/redact 链路返回存在标记而非值。
- **任何**路由响应不回显密钥（只回布尔、额度数字、组/路由 id）。
- 持久化位置：profile `cordis.patch.yml` 的 `ark-quota` entry（基础层 + 用户层），位于 `$DSH_HOME` 下；`.gitignore` 兜底排除（`settings.*` / `cordis.patch.*` 等）。
- 日志不打印完整密钥；`tools/check.mjs` 不落盘、只截断显示。

## 路由防护

- **同源校验**：改状态 POST 校验 `sec-fetch-site` 同源 / Origin-Host 一致 / loopback `Host` 兜底，跨站表单与 DNS-rebinding 请求 403。
- **CSRF capability**：`GET /ark-quota/csrf` 发放每实例随机 token（`X-Ark-Quota-CSRF`），时序安全比较。
- **固定形状输入**：POST 只接受白名单字段（`route`/`account`/`accessKeyId`/`secretAccessKey`、`action`+`route`+`label`、允许档位的 `refreshMs`）；无任何用户可控 URL——不存在代理/SSRF 面。
- **响应映射诚实**：`unauthorized`/`missing-auth` → 401，`network` → 504，其余上游错误 → 502；`HEAD` 无响应体。

## 暴露面（如实说明）

这些路由绑定在 DSH 服务器上、**未做认证**：同机的任意进程可以读额度、取 CSRF token、改写密钥（与直接编辑该机 `settings.yaml` 等效）。CSRF 防的是浏览器侧跨站请求，不是本机认证——**加载本插件期间不要把 DSH 服务器暴露到 loopback 之外**。

## 依赖

- 运行时：`@deepseek-ai/schemastery ^3.18.4`（Config schema 与 volatile refs）、`zod ^4.5.4`（内部持久化校验）。
- `@deepseek-ai/dsh-*` 宿主包一律走 `peerDependencies` + 同版本 `devDependencies` 镜像，避免遮蔽宿主。
- `react` / `react-dom` / `jsdom` 仅测试用（scratch 目录），不进插件依赖。
