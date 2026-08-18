# dsh-ark-quota

[English](./README.md) · **简体中文**

**火山方舟（Volcano Ark）Coding Plan 订阅套餐剩余额度** —— DeepSeek Harness（DSH）Web 插件，在侧边栏底部以固定小组件实时展示你的套餐额度，无需离开 DSH 界面。

> 当前版本：`v0.1.0`（版本号见 [VERSION](./VERSION)）

- 宿主半区（`lib/index.js`）：由于 OpenAPI 网关不允许来自 DSH 源（127.0.0.1:3080）的跨域（CORS）请求，由宿主用你的火山引擎**访问密钥 AK/SK**（SigV4 变体签名）在同源路由 `/ark-quota` 上代理控制面 OpenAPI `GetCodingPlanUsage`（未订阅时自动回落到 Agent Plan 的 `GetAFPUsage`）。**无浏览器、无 Cookie、无 CSRF**。
- 浏览器半区（`lib/client.js`）：渲染额度卡片 / 窄条百分比胶囊，并在设置变更时自动刷新；同时在 **设置 → 方舟额度** 提供独立的顶级配置分区，可直接在 DSH 设置界面粘贴 AK/SK。
- `tools/check.mjs`：零依赖 CLI，用你的 AK/SK 签名一次请求并打印套餐额度——配置前后用它验证密钥是否正确。

> ⚠️ **安全提醒**：额度接口使用你的**火山方舟访问密钥（AccessKey ID + Secret）**鉴权，属于火山账号的真实凭据。请务必妥善保管：不要提交到任何仓库、不要粘贴到任何地方（只允许写入你自己的 `cordis.patch.yml` / `settings.yaml`，或 DSH 设置界面——那里以 `role('secret')` 标记、只写不回显）。

## 功能特性

- **侧边栏固定小组件**：侧边栏底部操作区显示宽版卡片（5小时 / 近1周 / 近1月三条用量进度，可切换显示已用或剩余百分比），窄版显示近1月百分比胶囊。悬停任意一行可查看精确百分比、绝对用量（如有）与精确重置时刻。
- **Agent Plan 自动回落**：账号未订阅 Coding Plan 时，代理自动探测 `GetAFPUsage` 并渲染绝对额度窗口。
- **免重启维护**：密钥从 `ark-quota` 设置命名空间读取（`$DSH_HOME/settings.yaml`，由 `dsh-settings-file` 热重载）。任何变更立即清空缓存——**无需重启服务**。
- **设置界面配置**：DSH 设置 → **方舟额度** 顶级分区（与「侧边卡片」「配置同步」同级），一键保存 AK/SK（只写字段、热生效）。

## 环境要求

- DeepSeek Harness Web 运行时（`dsh web`），且组合了 `dsh-settings-file`（默认 Web profile 已包含）。
- 拥有火山引擎账号，已开通方舟 Coding Plan 套餐，并有可用的访问密钥（AK/SK）。

## 安装

1. 让本包从你的 profile 可被解析。加载器从 profile 目录解析 `name: dsh-ark-quota`，因此包必须**实体存在**于 `$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota`（Node 常规的 `node_modules` 向上查找）。两种方式：

   - 直接把仓库克隆进模块路径：

     ```sh
     git clone https://github.com/lordqyxz/dsh-ark-quota \
       "$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota"
     ```

   - 或将其作为 profile 的依赖安装，例如 `dsh plugin --profile <profile> add github:lordqyxz/dsh-ark-quota`（内部转发给 `pnpm add`）。

2. 将本包加入你 profile 的 workspace（`$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`），让 pnpm 把已安装的副本视为 workspace 成员并链接其依赖：

   ```yaml
   packages:
     - .
     - 'node_modules/dsh-ark-quota'
   ```

   随后在 profile 目录运行 `pnpm install`。如果你的 harness 已提供 profile 的依赖（例如 `npx` 安装方式的 `$DSH_HOME/profiles/node_modules` 模块回退），`pnpm install` 可省略——本包的依赖（`@deepseek-ai/schemastery`、`yaml`）已可直接解析，放好包即可。

3. 在 profile 的 `cordis.patch.yml` 中加入条目：

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           accessKeyId: ''        # 可留空——更推荐直接在 DSH 设置界面填写
           secretAccessKey: ''
           region: cn-beijing
           version: '2024-01-01'
           refreshMs: 300000
   ```

4. 应用并验证。较新版本的 DSH 会通过 HMR 监听器热应用 `cordis.patch.yml` 的变更（宿主路由与客户端启动图无需重启即可重组）——用 `curl -i http://127.0.0.1:3080/ark-quota` 检查；若路由未生效，再重启 DSH 服务并刷新浏览器。侧边栏底部即出现小组件。

## 获取访问密钥

1. 打开火山引擎控制台 → **访问控制 → API 访问密钥**。
2. 创建一个访问密钥（AccessKey），记下 **AccessKey ID** 与 **Secret Access Key**。
3. 填入插件——最省事的方式是在 DSH 设置界面：**设置 → 方舟额度**（写入 `$DSH_HOME/settings.yaml`，热生效、**无需重启**）；也可以在 `cordis.patch.yml` 里配置 `accessKeyId` / `secretAccessKey`。

> 💡 **验证**：运行 `node tools/check.mjs <accessKeyId> <secretAccessKey>`（或 `ARK_AK=… ARK_SK=… node tools/check.mjs`），确认密钥能正确通过火山控制面 OpenAPI 签名并打印你的套餐额度——全程无浏览器。

## 使用

- 小组件按 `refreshMs`（默认 5 分钟，可在"设置 → 方舟额度"里改为 1/5/10/30 分钟或 1 小时）自适应轮询 `/ark-quota`，并在设置命名空间变更时立即刷新。
- 点击 **⟳** 按钮（或访问 `/ark-quota?force=1`）可强制立即刷新。
- 密钥缺失或错误时显示错误卡片；在 **设置 → 方舟额度** 里修正（或重跑 `node tools/check.mjs`），组件会自动更新。

## 配置说明

所有配置存放在 `ark-quota` 设置命名空间。`cordis.patch.yml` 中的组合条目配置作为**基础层（base）**，`$DSH_HOME/settings.yaml` 中的用户层可覆盖它并热生效。

| 键              | 类型   | 默认值       | 说明                                        |
| --------------- | ------ | ------------ | ------------------------------------------- |
| `accessKeyId`   | string | `""`（secret）| 火山引擎 AccessKey ID（签名每次 OpenAPI 调用）|
| `secretAccessKey`| string | `""`（secret）| 火山引擎 Secret Access Key                    |
| `region`        | string | `cn-beijing` | 方舟地域                                    |
| `version`       | string | `2024-01-01` | 控制面 OpenAPI 版本                          |
| `refreshMs`     | number | `300000`     | 代理缓存有效期，超时后重新拉取              |

## API

`GET /ark-quota` → 同源 JSON：

```json
{
  "ok": true,
  "status": "Normal",
  "updatedAt": 1786639101,
  "hasReward": false,
  "quota": [
    { "level": "monthly", "percentUsed": 90.18, "percentRemaining": 9.82, "cap": 100, "rewardTotalPercent": 0, "resetAt": 1786639101 }
  ]
}
```

失败时返回：`{ "ok": false, "code": "unauthorized" | "upstream" | "network", "message": "…" }`（HTTP 状态码分别为 401 / 502 / 504）。

## 安全说明

- `/ark-quota`、`/ark-quota/status`、`/ark-quota/credentials`、`/ark-quota/settings` 四个路由**仅限本机**（绑定在 DSH 服务上）且**无鉴权**：同一台机器上的任何进程都能读取你的额度数据、触发一次带鉴权的刷新、通过 `POST /ark-quota/credentials` 覆盖访问密钥，或通过 `POST /ark-quota/settings` 修改轮询间隔（影响面等同本机可直接读写 `settings.yaml`）。但它们**绝不会回显你的访问密钥**（响应只含布尔状态 / 额度数字）；`/ark-quota/credentials` 只接受固定形状的 `accessKeyId` / `secretAccessKey` 字段，`/ark-quota/settings` 只接受固定白名单中的 `refreshMs` 数值，都不接受任何用户可控的 URL，因此无法作为代理/SSRF 跳板或泄漏火山凭据。插件加载期间请勿将 DSH 服务暴露到非回环地址。
- 访问密钥是真实凭据，存放于 `$DSH_HOME` 下的 `cordis.patch.yml` / `settings.yaml`；在设置 schema 中以 `role('secret')` 声明（DSH 设置界面以只写字段展示、绝不把值回传浏览器），并**已被 git 排除**（见 `.gitignore`）。
- `tools/check.mjs` 只用命令行 / `ARK_AK` / `ARK_SK` 传入的密钥签名一次请求，**不写盘、不全量打印**。

## 参与贡献

欢迎贡献！参与方式、提交与 PR 规范、发版流程见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)（English: [CONTRIBUTING.md](./CONTRIBUTING.md)）。AI agent 与深度开发者请先读 [AGENTS.md](./AGENTS.md)——它涵盖插件加载机制、编码约定、强制安全不变量与测试清单。

## 许可证

[MIT](./LICENSE)
