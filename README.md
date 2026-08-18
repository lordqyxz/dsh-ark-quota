# dsh-ark-quota

**English** · [简体中文](./README.zh-CN.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) web plugin that shows your **火山方舟 (Volcano Ark) Coding Plan subscription quota** as a fixed widget in the sidebar footer — without ever leaving the DSH GUI.

> Current version: `v0.1.0` (see [VERSION](./VERSION))

- Host half (`lib/index.js`) signs the **control-plane OpenAPI** `GetCodingPlanUsage` (falling back to `GetAFPUsage` for Agent Plan) with your Volcengine **AK/SK** (SigV4 variant) behind a same-origin route (`/ark-quota`), because the OpenAPI gateway does not allow CORS from the DSH origin. No browser, no cookies, no CSRF.
- Browser half (`lib/client.js`) renders the quota card / rail pill and auto-refreshes when the settings change; a dedicated **Settings → 方舟额度** section lets you paste the AK/SK straight into the DSH settings UI.
- `tools/check.mjs` is a zero-dependency CLI that signs one request with your AK/SK and prints your subscription quota — use it to verify keys before/after configuring.

> ⚠️ **Security note**: the quota API is authenticated with your **火山方舟 access keys (AccessKey ID + Secret)**. These are real credentials for your Volcengine account. Keep them private, never commit them, and never paste them anywhere except your own `cordis.patch.yml` / `settings.yaml` (or the DSH settings UI, which marks them `role('secret')` and never returns their values to the browser).

## Features

- Sidebar footer widget: wide card (5-hour / weekly / monthly usage bars, switchable between used % and remaining %) on the footer action row, or a compact pill. Hover any row for precise percentages, absolute counts (when returned by the API), and the exact wall-clock reset time.
- Agent Plan fallback: when the account is not subscribed to Coding Plan, the proxy auto-detects `GetAFPUsage` and renders the absolute quota windows instead.
- Live maintenance: keys are read from the `ark-quota` settings namespace (`$DSH_HOME/settings.yaml`, hot-reloaded by `dsh-settings-file`). A change drops the cache immediately — **no server restart**.
- Settings UI: a top-level **方舟额度** section in the DSH settings (sibling of the 侧边卡片 / 配置同步 sections) saves AK/SK with one click (write-only fields, hot-applied).

## Requirements

- DeepSeek Harness web runtime (`dsh web`), with `dsh-settings-file` composed (it is in the default web profile).
- A 火山方舟 Coding Plan subscription and a logged-in `console.volcengine.com` session.

## Installation

1. Make the package resolvable from your profile. The loader resolves `name: dsh-ark-quota`
   from the profile directory, so the package must physically live at
   `$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota` (Node's normal `node_modules` walk).
   Get it there either by cloning straight into the module path:

   ```sh
   git clone https://github.com/lordqyxz/dsh-ark-quota \
     "$DSH_HOME/profiles/<profile>/node_modules/dsh-ark-quota"
   ```

   or by installing it as a dependency of the profile, e.g.
   `dsh plugin --profile <profile> add github:lordqyxz/dsh-ark-quota` (forwards to `pnpm add`).

2. Add the package to your profile's workspace (`pnpm-workspace.yaml` under `$DSH_HOME/profiles/<profile>/`)
   so pnpm treats the installed copy as a workspace member and links its dependencies:

   ```yaml
   packages:
     - .
     - 'node_modules/dsh-ark-quota'
   ```

   Then run `pnpm install` in the profile directory. If your harness already provides the
   profile's dependencies (e.g. the `$DSH_HOME/profiles/node_modules` module fallback of an
   `npx`-installed harness), `pnpm install` is optional — the package's deps
   (`@deepseek-ai/schemastery`) already resolve, so placing the package is enough.

3. Add an entry to your profile's `cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ark-quota
         name: dsh-ark-quota
         config:
           accessKeyId: ''        # optional here — fill it in the DSH Settings UI instead
           secretAccessKey: ''
           region: cn-beijing
           version: '2024-01-01'
           refreshMs: 300000
   ```

4. Apply and verify. Editing `cordis.patch.yml` is hot-applied by DSH's HMR watcher on recent
   versions (the host route and client boot graph recompose without a restart) — check it with
   `curl -i http://127.0.0.1:3080/ark-quota`. If the route isn't live, restart the DSH server
   and refresh the browser. The widget appears at the bottom of the sidebar.

## Getting the access keys

1. Open the Volcengine console → **访问控制 (Access Control) → API 访问密钥 (API Access Keys)**.
2. Create an AccessKey (or reuse one) and note the **AccessKey ID** and **Secret Access Key**.
3. Fill them into the plugin — easiest from the DSH Settings UI: **Settings → 方舟额度**
   (saved to `$DSH_HOME/settings.yaml`, hot-applied, **no restart needed**). Or set
   `accessKeyId` / `secretAccessKey` in `cordis.patch.yml`.

> 💡 **Verify**: run `node tools/check.mjs <accessKeyId> <secretAccessKey>` (or
> `ARK_AK=… ARK_SK=… node tools/check.mjs`) to confirm the keys sign correctly against the Ark
> control-plane OpenAPI and print your subscription quota — no browser involved.

## Usage

- The widget adaptively polls `/ark-quota` at `refreshMs` (default 5 min; change it in Settings → 方舟额度 to 1/5/10/30 min or 1 hour), and immediately refreshes whenever the settings namespace changes.
- Click the **⟳** button (or `?force=1`) for an immediate refetch.
- When the keys are missing or wrong you'll see an error card; fix them in Settings → 方舟额度 (or re-run `node tools/check.mjs`) and the widget updates itself.

## Configuration

All settings live in the `ark-quota` settings namespace. The composition entry config in `cordis.patch.yml` is the **base**; the user layer in `$DSH_HOME/settings.yaml` overrides it and is hot-applied.

| key             | type   | default      | description                                       |
| --------------- | ------ | ------------ | ------------------------------------------------- |
| `accessKeyId`   | string | `""` (secret)| Volcengine AccessKey ID (signs every OpenAPI call)|
| `secretAccessKey`| string | `""` (secret)| Volcengine Secret Access Key                       |
| `region`        | string | `cn-beijing` | Ark region                                        |
| `version`       | string | `2024-01-01` | control-plane OpenAPI version                     |
| `refreshMs`     | number | `300000`     | proxy cache TTL before refetching                 |

## API

`GET /ark-quota` → same-origin JSON:

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

On failure: `{ "ok": false, "code": "unauthorized" | "upstream" | "network", "message": "…" }` (HTTP 401 / 502 / 504 respectively).

## Security notes

- The `/ark-quota`, `/ark-quota/status`, `/ark-quota/credentials`, and `/ark-quota/settings` routes are **localhost-only** (bound to the DSH server) and are **unauthenticated**: any process on the same machine can read your quota figures, force an authenticated refresh, overwrite your access keys via `POST /ark-quota/credentials`, or change the `refreshMs` polling cadence via `POST /ark-quota/settings` (the same exposure as directly editing `settings.yaml` on that machine). They **never echo your access keys** (responses carry only booleans / quota numbers); `/ark-quota/credentials` accepts only a fixed-shape `accessKeyId` / `secretAccessKey` pair of strings, and `/ark-quota/settings` accepts only `refreshMs` from a fixed allowlist — no user-controlled URL, so they cannot be used as a proxy/SSRF vector or leak the Volcengine credentials. Don't expose the DSH server beyond loopback while this plugin is loaded.
- Access keys are real credentials. They are stored in `cordis.patch.yml` / `settings.yaml` under `$DSH_HOME`, declared with `role('secret')` in the settings schema (the DSH settings UI shows them as write-only fields and never sends their values back to the browser), and are **excluded from git** (see `.gitignore`).
- `tools/check.mjs` only signs one request with the keys you pass on the command line / via `ARK_AK`/`ARK_SK`; it never writes them to disk and never prints them in full.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) for how to get involved, commit/PR guidelines, and the release process (简体中文见 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)). AI agents and deep-dive developers: read [AGENTS.md](./AGENTS.md) first — it covers the plugin load mechanics, coding conventions, mandatory security invariants, and the testing checklist.

## License

[MIT](./LICENSE)
