# 安装 / 升级 / 卸载

## 前置要求

- DeepSeek Harness `dsh web`，DSH **0.2.0-rc.1 或 0.2.0-rc.2**
- 火山方舟订阅及一对 AK/SK（控制台 → 访问控制 → API 访问密钥）

## 通过插件管理器安装（推荐）

**GUI**：设置页 → 插件 → 安装，填入 `https://github.com/lordqyxz/dsh-ark-quota`。

**CLI**：

```sh
dsh plugin --profile <profile> add https://github.com/lordqyxz/dsh-ark-quota
```

本包声明了 `dsh.bundle`（见 `dsh.bundle.yml`），插件管理器会一次性完成：

1. 依赖写入 profile 的 `package.json`（`dependencies`）；
2. 追加到 `dsh.profile.bundles`（自动维护，无需手写 manifest）；
3. 应用 bundle patch（`dsh.bundle.yml` 的 `- insert: - id: ark-quota, name: dsh-ark-quota`），宿主半区随之挂载；
4. 客户端半区由 boot graph 扫描 `dsh.client` 声明后经 `/plugins` 下发。

装完**重启 DSH**（bundle 成员变化不热加载），刷新浏览器，侧栏底部出现卡片。

### 密钥填写

**设置 → 方舟额度** → 选模型路由 → 填 AK/SK → 保存。密钥持久化到 profile `cordis.patch.yml` 中该 entry 的用户层，热应用、无需重启；也可直接编辑 `cordis.patch.yml` 的 `ark-quota` 条目（改已有 id 的 config 走 loader 热重组）。

## 手动安装（不经插件管理器）

1. 让包可从 profile 目录被 Node 解析——克隆或复制到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota`，或 `pnpm add` 进 profile：

   ```sh
   git clone https://github.com/lordqyxz/dsh-ark-quota \
     "$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota"
   ```

2. 在 profile 的 `cordis.patch.yml` 追加（bundle 安装方式会自动做这一步）：

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
   ```

   不需要手写 `config`：密钥等全部字段有默认值，装后在设置页填写即可。`accounts` / `refreshMs` 等字段结构见 [settings.md](./settings.md)，示例见仓库根的 `cordis.patch.yml.example`。

3. 重启 DSH 并 `curl -i http://127.0.0.1:3080/ark-quota` 验证路由；侧栏底部出现卡片。

> ⚠️ 若之前手动 insert 过 `id: ark-quota`，改用 bundle 安装前**先删掉手写行**，否则 duplicate loader entry id（bundle 已 add、patch 又 insert 同一 id）。用户层只保留 `- id: ark-quota` + `config` 的覆盖行。

## 升级

```sh
dsh plugin --profile <profile> add https://github.com/lordqyxz/dsh-ark-quota
```

重新执行同一命令即解析到默认分支最新 commit 并重装；已保存的密钥在 entry 用户层，升级保留。升级后重启 DSH。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-ark-quota
```

同时移除 `dependencies` 与 `dsh.profile.bundles` 里的条目。手动安装方式则需自行清理 `node_modules` 内的副本、`cordis.patch.yml` 的 insert 行与用户层覆盖行。卸载后检查（异常中断可能留残留）：`package.json`、`dsh.profile.bundles`、`cordis.patch.yml`、`node_modules/dsh-ark-quota`。

## DSH 版本兼容性

| DSH 版本 | 兼容 | 说明 |
| --- | --- | --- |
| 0.2.0-rc.1 | ✅ | 已真机验证 |
| 0.2.0-rc.2 | ✅ | settings/loader/plugin-manager 源码逐项比对，接缝 API 一致 |

插件用到的接缝（均为两版一致的官方 API）：

- `ctx.settings`（SettingsForms）：**没有 `register()`**。可写命名空间 = 插件自己的 profile entry；读 `config` 的 volatile refs，写 `settings.update(entry.options.id, patch)`（ns 用 `ctx.fiber.entry?.options.id`，不是 `loader.locate()` 的 include 前缀组合 id）。
- Config 可写字段必须声明 `.volatile()`（需要 `@deepseek-ai/schemastery` ≥3.18.4，插件已声明 `^3.18.4`）。
- 客户端经 `dsh.client` + `ctx.slots.inject` 注册。

### 常见安装报错

- **`ERR_PNPM_ADDING_TO_ROOT`**：profile 目录含 `pnpm-workspace.yaml`（模板 profile 默认就有，`packages: [.]`），`pnpm add` 不带 `-w` 会拒绝写入 workspace root。rc.1/rc.2 的 dsh-plugin-manager 都不加 `-w`，属宿主侧问题，两种解法：
  1. 给宿主的 `dsh-plugin-manager/lib/index.js` 安装调用点插入 `"-w"`（改前备份）；
  2. 或临时移除 profile 的 `pnpm-workspace.yaml` 再装（若你的 profile 依赖 `nodeLinker: hoisted` 等设置，保留该文件、只删 `packages` 段会导致 `packages field missing` 错误——保留 `packages: [.]` 即可）。
  CLI 侧也可直接 `dsh plugin --profile <profile> add -w <spec>` 显式带上。
- **`Host key verification failed` / `git ls-remote git+ssh://…`**：pnpm 对 GitHub spec 走 ssh 解析。宿主无 GitHub 密钥时改走 https：
  `git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"`
- **GitHub 连接超时**：服务器到 GitHub 链路抖动，重试即可；或先用 `dsh plugin add -w <本地路径>` 从已克隆的目录安装。
- **`ERR_PNPM_ADDING_TO_ROOT` 之外**：git 托管包依赖 prepare 构建脚本时 pnpm 会拦截，按提示在 `pnpm-workspace.yaml` 的 `allowBuilds` 下补键（本插件无构建脚本，不会遇到）。

## 校验密钥

```sh
ARK_AK=<accessKeyId> ARK_SK=<secretAccessKey> node tools/check.mjs
# 或 node tools/check.mjs <accessKeyId> <secretAccessKey>
```

退出码：0 = 签名与额度查询成功；2 = 认证失败（附修正提示）；1 = 其他错误。密钥不落盘、不完整打印。
