# AGENTS.md

Guidance for AI agents (and deep-dive developers) working in this repository.
This file is the machine-actionable counterpart of [CONTRIBUTING.md](./CONTRIBUTING.md):
it exists because most of the "how to touch this code" knowledge here is execution
detail, not human onboarding.

This is a **DeepSeek Harness (DSH) web plugin**: everything runs as a plugin on
Cordis. The host half runs inside the DSH server; the browser half is a
hand-written bundle consumed by the DSH client module loader.

## Repo layout

| path | what it is |
| --- | --- |
| `lib/index.js` | Host half (ESM): registers the `ark-quota` settings namespace + the same-origin `/ark-quota` proxy route (signed control-plane OpenAPI), plus the plugin-owned routes (`/status`, `/credentials`, `/routes`, `/providers`, `/settings`) that read/write the namespace straight through the host seam (see "Settings write path" below). |
| `lib/signature.js` | Volcengine SigV4-variant signer (pure `node:crypto`, no network/state) — shared by host and `tools/check.mjs`. |
| `lib/client.js` | Browser half: shipped client bundle in `window.__ModuleLoader__.load({ id, factory })` format. **No build step — edit this file directly.** |
| `tools/check.mjs` | Standalone Node CLI (no DSH imports): signs one `GetCodingPlanUsage`/`GetAFPUsage` request with AK/SK and prints the quota — for verifying keys. |
| `tools/patch-settings-icon.mjs` | Idempotent shell patch (run manually, not on load): gives the 方舟额度 settings-nav tab its own icon. DSH's settings nav icon is hardcoded by section id in `dsh-client-ui-settings-general` (unknown ids → gear) with no plugin hook, so the 火山方舟 mark is injected as one extra `navIcon("ark-quota")` branch in that shell's client bundle. Re-run after any DSH upgrade resets `node_modules`; `--revert` restores from the `.ark-orig` backup. |
| `cordis.patch.yml.example` | Example profile entry; AK/SK may be left empty and filled from the DSH Settings UI. |
| `README.md` / `README.zh-CN.md` | User docs — keep bilingual in sync. |

## Load mechanics (know before editing)

- **Plugin-set changes (adding/removing the entry in `cordis.patch.yml`) are hot-applied by DSH's HMR watcher on recent versions** — the profile's patch file is watched (`watchUserPatches`), so the composed tree, the host plugin, and the client boot graph (the Node half of `dsh-client-modules` re-scans entries for `dsh.client` packages, resolves `exports["./client"]`, hashes and serves the bundle under `/plugins`) all recompose without a restart. Verify with `curl -i http://127.0.0.1:3080/ark-quota`; if the route isn't live, restart the server and refresh the browser.
- **Host half changes always require a server restart.** The host does not hot-reload file packages; the dynamic runner only sandboxes inline packages.
- **Client bundle changes hot-reload only with a rebuild watcher**: the HMR chain (`dsh-client-hmr`, browser polls `GET /plugins/events`) stays idle unless `pnpm run dev:web` from a DSH source checkout rewrites the bundle. Without the watcher, editing `lib/client.js` + manual browser refresh is the loop. HMR reload is coarse: React state inside the reloaded plugin is lost.
- The client bundle is lazy: executing the script only registers the factory; the factory body runs at materialization (`factory(require)` → `module.exports` with `apply` + `inject`).

## Conventions — host (`lib/index.js`)

- Register everything through `ctx.effect(fn, label)` (fiber-scoped teardown).
- The settings namespace (`ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base })`) is the live-maintenance seam: read the **effective** config from the scope (`scope.get()`), never the static `config`; the `scope.watch` handler must drop the cache so an AK/SK change applies without restart.
- Sign every upstream call with `lib/signature.js` (`buildSignedRequest`) against `open.volcengineapi.com`; probe Coding Plan first (`GetCodingPlanUsage`), fall back to Agent Plan (`GetAFPUsage`) when coding is not subscribed.
- Keep AK/SK off every wire surface: declare them `role("secret")` in `Config`/`SettingsSchema`, never log full values, never echo them in responses.
- Validate config with `Config['~standard'].validate(config)` (schemastery implements Standard Schema).
- The route must never echo credentials; accept only fixed-shape inputs (no user-controlled URLs — no SSRF surface).
- Proxy failures map to honest statuses: `unauthorized`/`missing-auth` → 401, `network` → 504, else 502; HEAD returns no body.

## Conventions — client (`lib/client.js`)

- Keep the loader format exactly: `window.__ModuleLoader__.load({ id: "dsh-ark-quota", factory: (require) => {...} })`.
- `require` only `react` / `react/jsx-runtime` (plus `react-dom` in tests) — the bundle purity gate forbids cross-plugin value imports; collaborate via cordis services.
- Register the widget with `ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({ name, id, order, label, inject }, Component))` — the slot is shell-declared; `slots.inject` waits for the declaration.
- Register the settings section with `ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "ark-quota", order, label }, SectionComponent))` — a top-level entry in the Settings nav (sibling of the built-in sections), not a card nested under 插件.
- **Settings write path (why NOT settingsScope):** the DSH configuration client only exposes the platform's own namespaces — third-party namespaces answer `settings-not-exposed` for both `settings.describe` and writes, and the client silently swallows the refusal (so a "已保存" message can lie). Real reads/writes therefore go through the plugin-owned host routes (`GET /ark-quota/status`, `POST /ark-quota/credentials` → `settingsScope.update(patch)` on the host side, bypassing the proxy allowlist). Same pattern as dsh-config-sync. After a save, the client fires the module-scope `refreshSignal` so every mounted widget re-reads the quota immediately. Never echo credential values back in route responses — booleans only.
- Render everything through React elements/attributes (React escapes). **Never** `dangerouslySetInnerHTML` / `innerHTML` with console-derived strings.
- Look up level labels with `Object.prototype.hasOwnProperty.call(...)`, never bare `obj[key] || fallback` (prototype keys).
- **Identity model (route-centric):** the UI never creates/names accounts — identity is the llm **provider route id**. The settings page picks a route (from the `/ark-quota/providers` ark-filtered list) and saves AK/SK for it (`POST /ark-quota/credentials { route, accessKeyId, secretAccessKey }`); the host auto-creates/reuses a credential group (`accounts[]` item, id from `accountIdFromRoute`), merges groups sharing the same AK/SK (`findAccountByKeys`), and drops empty keyless groups on unbind (`detachRoute`). The sidebar widget follows the live session's model route: it observes `ctx.modelDirectories.directoryFor(sessionId).store` (per-session `current.provider`) via `ctx.inject(["sessions","modelDirectories"])` and re-queries `/ark-quota?route=<id>`; manual pin is also a route (`POST /ark-quota/routes { action:"pin", route }`, persisted as `pinnedRoute`; `route:""` = auto-follow). `accounts[]` stays the storage/signing/snapshot-bucketing kernel; `routesSummary()` is the route view. Missing services (old host / SSR) → follow silently disables.

## Conventions — host (route-centric identity, additions)

- `accounts[]` (credential groups, one per Volcengine account = one AK/SK pair) is the internal kernel; the `providers: string[]` field on each is the route→group ownership table, maintained by writing credentials for a route — never hand-edited in the UI.
- Pure helpers (unit-tested in smoke-host): `accountIdFromRoute(routeId)` (route id → `r_`-prefixed underscore id legal for `ACCOUNT_ID_RE`/storage buckets), `accountForRoute(accounts, routeId)`, `ensureRouteAccount(accounts, routeId)` (idempotent bind), `detachRoute(accounts, routeId)` (removes route; drops the group when it has no routes and no keys), `findAccountByKeys(accounts, ak, sk)` (dedup → merge).
- `/ark-quota` accepts `?route=<providerId>` (preferred) or `?account=<id>` (compat); quota/status/error responses all carry `routes: routesSummary()` and `pinnedRoute` so the client needs no extra round trip. The old `/ark-quota/accounts` CRUD route is gone — replaced by `/ark-quota/routes` (pin/unbind/rename). CSRF same-origin guard covers every mutating POST.

## Conventions — tools (`tools/check.mjs`)

- Zero-dependency CLI: reuse `lib/signature.js` (`buildSignedRequest`) to sign one `GetCodingPlanUsage`/`GetAFPUsage` request.
- Accept keys from argv (`node tools/check.mjs <ak> <sk>`) or `ARK_AK`/`ARK_SK` env; never write them to disk.
- Never print full key values — truncate (`slice(0,12) + "…"`).
- Exit code: 0 = verified + quota, 2 = auth failure with a fix hint, 1 = usage/other error.

## Security invariants (MANDATORY)

This plugin moves **real credentials** (Volcengine access keys: `accessKeyId` / `secretAccessKey`). Treat them as passwords.

1. Never commit real keys/tokens — any file, any commit, any branch. `PASTE_*` placeholders only in docs/examples.
2. Never log full key values.
3. Never echo keys in HTTP responses; keep them `role("secret")` in the settings schema so the DSH UI treats them as write-only.
4. `.gitignore` is the last line of defense (`settings.yaml`, `cordis.patch.yml`, `.dsh/`, `.env`, `.npmrc`); ignore any new file that could hold credentials.
5. Before any push, run the secret scan:

   ```sh
   grep -rInE 'eyJhbGciOi|ark-[A-Za-z0-9]{20,}|AKLT[A-Za-z0-9]{10,}|gho_|ghp_|github_pat_|AKIA|Bearer [A-Za-z0-9._-]{20,}' .
   ```

   Output must contain no real values (code references like `accessKeyId` field names and `PASTE_*` are acceptable).

## Testing (no framework — plain Node scripts)

1. Syntax: `node --check lib/index.js lib/signature.js lib/client.js tools/check.mjs`.
2. Signature unit checks (`lib/signature.js`): deterministic signing, URL/header shape (`host;x-date;x-content-sha256;content-type`), `X-Date` `YYYYMMDDTHHMMSSZ` format, `Authorization: HMAC-SHA256 Credential=…` structure.
3. Host smoke test (mock `ctx` with `webServer`/`settings`/`effect`/`logger`, no server): namespace registers with patch config as base; `scope.get()` drives effective config; a settings change (watch callback) drops the cache; missing keys → `missing-auth` 401; broken keys → 401 with a signed request; coding-plan success shape; agent-plan fallback; HEAD → no body; network → 504.
4. Client render smoke test: load the bundle under a `window.__ModuleLoader__` stub, `apply` with mock `slots` (inject = `["slots"]` only, no settingsScope), SSR with `react-dom/server` (wide + rail + settings section). The test now also mocks `sessions` + `modelDirectories` (the `ctx.inject(["sessions","modelDirectories"])` follow seam) and drives provider switches — assert route-dimension queries (`?route=`), pin/unpin (`POST /ark-quota/routes`), and the settings-page route selector.
5. Host route smoke test (mock `ctx`, no server): `/ark-quota/status` returns booleans without leaking keys; `POST /ark-quota/credentials` trims + allowlists only `accessKeyId`/`secretAccessKey`, persists via `scope.update`, returns no secret echo, empty body → 400 / GET → 405; with a `route` field it auto-creates the credential group (id from `accountIdFromRoute`) and same AK/SK across routes merges groups (`findAccountByKeys`); `POST /ark-quota/routes` handles pin/unbind/rename; `?route=` resolves a route to its group. Credential groups are internal — the UI never creates/names accounts; identity is the llm provider route.
6. Burn-model regression (`node tools/verify-burn.mjs`, plain Node, no server): sliding-window net rise (inflow − aging), aging rate from pre-window snapshots, recovery time when capped, thresholded reset-drop truncation, weighted-OLS sanity, and fixed-period projection — the `burnRate`/`foldSnap` pure functions only.
7. End-to-end: restart DSH → `curl http://127.0.0.1:3080/ark-quota?force=1` returns fresh quota → widget renders in the sidebar footer → save AK/SK in the Settings → 方舟额度 section and confirm the widget updates without restart.

## Release gate

Before tagging a release: full testing checklist + secret scan + **pro-model security review of the diff** (secret leakage, proxy SSRF/header injection, widget XSS, refresh-tool lifecycle). Then:

```sh
git tag vX.Y.Z
git push origin main --tags
gh release create vX.Y.Z --generate-notes
```

## Reference docs

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — official repo; see its [AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/AGENTS.md) for agent conventions upstream.
- `@deepseek-ai/dsh-client-modules` — boot graph, `/plugins` serving, lazy `__ModuleLoader__` factory model.
- `@deepseek-ai/dsh-client-hmr` — `GET /plugins/events` reload chain, `pnpm run dev:web` watcher requirement.
- `@deepseek-ai/dsh-client-ui-slots` — slot registration contract.
- `@deepseek-ai/dsh-client-runtime` — `ctx.slots.inject` declaration injection, `bindSettingsScope`.
- `@deepseek-ai/dsh-settings` / `dsh-settings-file` — host settings registry, hot-reloaded `settings.yaml`.
- [Cordis](https://github.com/cordiverse/cordis) — the plugin framework everything runs on.

## Cursor Cloud specific instructions

- **No standalone app / dev server lives in this repo.** This package is a *plugin*; it only runs inside a DeepSeek Harness host (`npx @deepseek-ai/dsh web`) that is not vendored here. There is nothing to `pnpm dev` from this repo — don't look for one.
- **True end-to-end (`curl /ark-quota` → real quota → widget in the DSH sidebar) is not reproducible in the cloud VM.** It needs (a) a running DSH host and (b) real, live `console.volcengine.com` session cookies for a 火山方舟 Coding Plan account, reaching a geo/auth-restricted Chinese console API. Treat that as a user-credentialed step, not a local one.
- **Validate changes with the plain-Node smoke tests in the Testing section above** (there is no test framework, no ESLint config; `node --check` is the syntax gate). Recipe used successfully in this environment:
  - Host half: mock `ctx` (`webServer`/`settings`/`effect`/`logger`) and stub global `fetch`, then `apply(ctx, config)` and drive `ctx.__route.handler(req,res)` — this exercises config resolution, cookie hot-refresh via `scope.watch`, CSRF rotation, and the 401/HEAD/405 paths without a server.
  - Client half: execute `lib/client.js` under a `window.__ModuleLoader__` stub to capture the factory, `factory(require)` with a `require` that returns only `react` / `react/jsx-runtime`, then SSR (`react-dom/server`) or mount (`react-dom/client` + `jsdom`, set the jsdom window as the global `window` before mounting) with a mocked `/ark-quota` payload.
- **`react` / `react-dom` / `jsdom` are test-only and intentionally NOT plugin dependencies** (the bundle-purity gate forbids bundling React). Install them in a throwaway scratch dir to run the client test; never add them to `package.json`.
- **Dependency caveat:** the public npm registry only publishes `@deepseek-ai/schemastery` `3.18.x` (the older `0.1.0-rc.x` pins referenced in history were never published there). This repo targets `^3.18.1`, which is API-compatible with the `z.object` / `.default()` / `Config['~standard'].validate` usage in `lib/index.js`.
