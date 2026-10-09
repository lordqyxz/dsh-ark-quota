# dsh-ark-quota

简体中文 · [English](./README.en.md)

[DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）插件：在侧栏常驻显示**火山方舟 Coding Plan 订阅额度**——各周期用量、燃烧节奏与耗尽预测，并随当前会话模型自动切换火山账号。

![方舟额度侧栏卡片](./docs/images/widget.webp)

## 功能

- **侧栏卡片 / 折叠胶囊**：5 小时 / 近 1 周 / 近 1 月用量条与重置倒计时；最紧的档位常驻在折叠胶囊上，悬停看全部档位
- **燃烧节奏与耗尽预测**：5 小时档按滑窗水位动力学（净增速），周 / 月档按额度进度 ÷ 时间进度的平均节奏；最近燃烧速率用指数加权最小二乘拟合；预测段直接画在进度条上，快照经 `storageDomain` 落盘、跨重启保留
- **跟随会话模型**：卡片身份取自 DSH 的 llm provider 路由——会话里切换模型，卡片自动切到对应火山账号；可手动固定某一路由
- **多账号**：按路由保存密钥即自动建组，多路由填同一对 AK/SK 自动合并成一个账号；未订阅 Coding Plan 时自动回落 Agent Plan（`GetAFPUsage`）
- **设置页「方舟额度」分区**：选路由、粘贴 AK/SK，保存即热生效——**无需重启**

## 要求

- DeepSeek Harness `dsh web`（DSH **0.2.0-rc.1 / rc.2**；见[兼容性说明](./docs/install.md#dsh-版本兼容性)）
- 火山方舟订阅及一对 **AK/SK**（控制台 → 访问控制 → API 访问密钥）

## 安装

**方式一（推荐）**：DSH 设置页 → 插件 → 安装，填入：

```
https://github.com/lordqyxz/dsh-ark-quota
```

**方式二（CLI）**：

```sh
dsh plugin --profile <profile> add https://github.com/lordqyxz/dsh-ark-quota
```

**方式三（手动 patch）**：不经过插件管理器的传统方式，见[手动安装](./docs/install.md#手动安装)。

装好后：**设置 → 方舟额度** → 选模型路由 → 填 AK/SK → 保存。侧栏底部即出现卡片。

> ⚠️ AK/SK 是火山账号的**真实凭据**：只填在设置页或自己机器的 profile 配置里，切勿提交进 git 或发给任何人。密钥在 schema 中声明为 `role('secret')`，设置界面只写不读、任何路由响应都不回显。安全细节见 [docs/architecture.md](./docs/architecture.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/install.md](./docs/install.md) | 安装、升级、卸载；DSH 版本兼容性；常见安装报错 |
| [docs/settings.md](./docs/settings.md) | 配置项与多账号模型（凭据组、路由绑定/合并/解绑、旧版单账号迁移） |
| [docs/widget.md](./docs/widget.md) | 小组件交互与预测口径（滑窗、平均节奏、预测段、状态色） |
| [docs/api.md](./docs/api.md) | 同源 HTTP 路由参考（`/ark-quota` 及全部子路由） |
| [docs/architecture.md](./docs/architecture.md) | 架构与安全模型（宿主/客户端半区、签名、CSRF、密钥红线） |

校验密钥（不经过浏览器）：`ARK_AK=… ARK_SK=… node tools/check.mjs`

## Contributing

欢迎参与，见 [CONTRIBUTING.md](./CONTRIBUTING.md)（简体中文：[CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)）；AI agent / 深度开发者请先读 [AGENTS.md](./AGENTS.md)。

## License

[MIT](./LICENSE)
