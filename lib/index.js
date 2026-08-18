// dsh-ark-quota host half.
// Proxies the Volcano Ark subscription-quota OpenAPI (GetCodingPlanUsage /
// GetAFPUsage) for the browser widget. The console quota API is not CORS-open
// to the DSH origin, so the browser half fetches this same-origin route.
//
// Auth: Volcengine access keys (AccessKey ID + Secret Access Key, created in
// 控制台 → 访问控制 → API 访问密钥). Every upstream call is signed with the
// volcano SigV4 variant (lib/signature.js) against the control-plane gateway
// open.volcengineapi.com. No browser, no cookies, no CSRF rotation, no CDP.
//
// Live maintenance: the plugin registers an `ark-quota` settings namespace
// (dsh-settings-file backs it at $DSH_HOME/settings.yaml, hot-reloaded). The
// patch entry config is the composition `base`; the user layer can override
// the access keys from the GUI or by editing settings.yaml — the scope watcher
// drops the cache immediately, so an AK/SK change needs no server restart.
import z from "@deepseek-ai/schemastery";
import { buildSignedRequest, DEFAULT_REGION, DEFAULT_VERSION } from "./signature.js";

export const name = "ark-quota";
export const inject = ["webServer", "settings"];

/** Settings namespace the user layer may override (access keys etc.). */
export const ARK_QUOTA_NS = "ark-quota";

const DEFAULT_REFRESH_MS = 300000;
const UPSTREAM_TIMEOUT_MS = 20000;

export const Config = z.object({
  // Volcengine access keys — sign every control-plane OpenAPI call.
  // `role('secret')` keeps them off every wire surface (redacted descriptor).
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  // How long the proxy serves a cached upstream response before refetching.
  refreshMs: z.number().min(1000).default(DEFAULT_REFRESH_MS)
});

/** Settings-layer schema (resolves base + user layer). */
export const SettingsSchema = z.object({
  accessKeyId: z.string().role("secret").default(""),
  secretAccessKey: z.string().role("secret").default(""),
  region: z.string().default(DEFAULT_REGION),
  version: z.string().default(DEFAULT_VERSION),
  refreshMs: z.number().min(1000).default(DEFAULT_REFRESH_MS)
});

// OpenAPI actions probed in order: Coding Plan first (the plugin's home),
// falling back to Agent Plan when the account is not subscribed to coding.
const ACTIONS = {
  codingPlan: "GetCodingPlanUsage",
  agentPlan: "GetAFPUsage"
};

// Path segments interpolate into the signature only; keep them to a strict
// allowlist so a mis-typed region/version can never alter the (hardcoded)
// gateway host or request path.
const SEGMENT = /^[A-Za-z0-9-]+$/;
function assertSegment(part) {
  if (typeof part !== "string" || !SEGMENT.test(part)) {
    throw upstreamError("upstream", `ark-quota: invalid region/version segment: ${JSON.stringify(part)}`);
  }
}

function upstreamError(code, message, extra) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Coerce a value to a finite number, or null when absent/non-numeric. */
function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Gate on auth-shaped error codes (hard-stop; credentials are wrong). */
function isAuthError(code) {
  const c = String(code ?? "").toLowerCase();
  return /auth|signature|accessdenied|denied|unauthorized|forbidden|credential|token/.test(c);
}

/** JSON helper for the plugin's own routes (never echoes credentials). */
function sendJson(res, status, obj) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(obj));
}

/** Read and parse a JSON request body; `{ _parseError: true }` on malformed input. */
function readBody(req) {
  return new Promise((resolvePromise) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolvePromise(text ? JSON.parse(text) : {});
      } catch {
        resolvePromise({ _parseError: true });
      }
    });
  });
}

/** Parse GetCodingPlanUsage Result.QuotaUsage → [{ level, percentUsed, resetAt }]. */
function parseCodingPlan(result) {
  const arr = result?.QuotaUsage ?? result?.Usages ?? result?.Details ?? [];
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const level = String(item.Level ?? item.Type ?? item.Period ?? "").toLowerCase();
    if (!level) continue;
    const raw = item.Percent ?? item.UsedPercent ?? item.UsagePercent ?? 0;
    const percent = typeof raw === "number" ? raw : Number(raw) || 0;
    const resetAt = typeof item.ResetTime === "number" ? item.ResetTime
      : typeof item.ResetTimestamp === "number" ? item.ResetTimestamp
      : null;
    // Absolute counts (when the console returns them). Units are opaque; we
    // just surface the numbers so the widget can show "used / total" on hover.
    const used = numOrNull(item.Used ?? item.UsedCount ?? item.Consumed);
    const total = numOrNull(item.Total ?? item.Quota ?? item.Limit ?? item.TotalCount);
    out.push({ level, percentUsed: percent, resetAt, used, total });
  }
  return out;
}

/** Parse GetAFPUsage Result windows → [{ level, percentUsed, resetAt }]. */
function parseAgentPlan(result) {
  const windows = [
    ["AFPFiveHour", "session"],
    ["AFPWeekly", "weekly"],
    ["AFPMonthly", "monthly"]
  ];
  const out = [];
  for (const [key, level] of windows) {
    const win = result?.[key];
    const quota = Number(win?.Quota ?? 0);
    if (!(quota > 0)) continue;
    const used = Number(win?.Used ?? 0);
    out.push({
      level,
      percentUsed: (used / quota) * 100,
      resetAt: typeof win.ResetTime === "number" ? win.ResetTime : null,
      used,
      total: quota
    });
  }
  return out;
}

/** Map a resolved tier list into the widget-friendly payload. */
function shapeResult(tiers, plan, raw) {
  const quota = tiers.map((t) => ({
    level: t.level,
    percentUsed: t.percentUsed,
    percentRemaining: Math.max(0, Math.min(100, 100 - t.percentUsed)),
    cap: 100,
    rewardTotalPercent: 0,
    resetAt: t.resetAt,
    used: typeof t.used === "number" && Number.isFinite(t.used) ? t.used : null,
    total: typeof t.total === "number" && Number.isFinite(t.total) ? t.total : null
  }));
  return {
    ok: true,
    plan,
    status: raw?.Status ?? null,
    updatedAt: typeof raw?.UpdateTimestamp === "number"
      ? raw.UpdateTimestamp
      : Math.floor(Date.now() / 1000),
    hasReward: raw?.HasReward === true,
    quota
  };
}

export function apply(ctx, config) {
  const base = {
    accessKeyId: config.accessKeyId || "",
    secretAccessKey: config.secretAccessKey || "",
    region: config.region || DEFAULT_REGION,
    version: config.version || DEFAULT_VERSION,
    refreshMs: config.refreshMs ?? DEFAULT_REFRESH_MS
  };

  let settingsScope = null;
  let cache = null; // { at, payload }

  // Register the settings namespace; the user layer (settings.yaml / GUI)
  // overrides the patch `base`. Watchers drop the cache so an AK/SK change
  // applies on the next request without a restart.
  ctx.effect(() => {
    const scope = ctx.settings.register(ARK_QUOTA_NS, SettingsSchema, { base });
    settingsScope = scope;
    const unwatch = scope.watch(() => {
      cache = null;
      ctx.logger.info("ark-quota: settings changed — cache reset");
    });
    return () => {
      unwatch();
      settingsScope = null;
    };
  }, "ark-quota: settings namespace");

  /** The effective config: settings scope when mounted, else the patch base. */
  const effective = () => (settingsScope !== null ? settingsScope.get() : base);

  const cacheFresh = () => cache !== null && Date.now() - cache.at < effective().refreshMs;

  const fetchOnce = async (cfg, action) => {
    assertSegment(cfg.region);
    assertSegment(cfg.version);
    const { url, headers } = buildSignedRequest({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      version: cfg.version,
      action
    });
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers,
        body: "",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
    } catch (error) {
      throw upstreamError("network", `ark-quota: OpenAPI request failed: ${String(error?.message ?? error)}`);
    }
    const text = await resp.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw upstreamError("upstream", `ark-quota: OpenAPI returned HTTP ${resp.status} with a non-JSON body`);
    }
    const meta = json?.ResponseMetadata ?? {};
    const err = meta.Error;
    if (err) {
      if (isAuthError(err.Code) || resp.status === 401 || resp.status === 403) {
        throw upstreamError("unauthorized",
          `ark-quota: 访问密钥校验失败（${err.Code}: ${err.Message}）。请检查 accessKeyId / secretAccessKey。`);
      }
      throw upstreamError("upstream", `ark-quota: OpenAPI error ${err.Code}: ${err.Message}`);
    }
    return json;
  };

  const refresh = async () => {
    const cfg = effective();
    if (!cfg.accessKeyId || !cfg.secretAccessKey) {
      throw upstreamError("missing-auth",
        "未配置访问密钥（accessKeyId / secretAccessKey）。请在设置或 cordis.patch.yml 中填写火山引擎访问密钥。");
    }
    // Coding Plan first; fall back to Agent Plan when coding is not subscribed.
    let raw = await fetchOnce(cfg, ACTIONS.codingPlan);
    let tiers = parseCodingPlan(raw?.Result);
    let plan = "coding-plan";
    if (tiers.length === 0) {
      raw = await fetchOnce(cfg, ACTIONS.agentPlan);
      tiers = parseAgentPlan(raw?.Result);
      plan = "agent-plan";
    }
    const payload = shapeResult(tiers, plan, raw?.Result);
    // Tell the browser how often to poll (it must not hardcode the interval —
    // the user can change refreshMs from the Settings card). cachedAt is the
    // moment this payload entered the host cache, so the browser can schedule
    // its next poll to fire shortly AFTER the cache expires (avoiding the
    // equal-interval race where a 5-min client tick hits a not-yet-expired
    // 5-min host cache and serves stale data for another whole interval).
    const nowMs = Date.now();
    payload.refreshMs = cfg.refreshMs;
    payload.cachedAt = nowMs;
    cache = { at: nowMs, payload };
    return payload;
  };

  const handler = async (req, res) => {
    const isHead = req.method === "HEAD";
    const send = (status, obj) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(isHead ? "" : JSON.stringify(obj));
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, { ok: false, code: "method", message: "GET only" });
      return;
    }
    try {
      const force = new URL(req.url ?? "/", "http://x").searchParams.get("force") === "1";
      const payload = !force && cacheFresh() ? cache.payload : await refresh();
      send(200, payload);
    } catch (error) {
      ctx.logger.warn(error);
      // Map proxy failures to honest HTTP statuses (the client reads the JSON
      // body regardless): 401 bad credentials, 504 gateway unreachable, else 502.
      const status = error?.code === "unauthorized" || error?.code === "missing-auth" ? 401
        : error?.code === "network" ? 504
        : 502;
      send(status, {
        ok: false,
        code: error?.code ?? "upstream",
        message: String(error?.message ?? error)
      });
    }
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota",
    handler
  }), "ark-quota: /ark-quota route");

  // The DSH configuration client (GUI settingsScope) only exposes the
  // platform's own namespaces — third-party namespaces answer
  // `settings-not-exposed` for both reads and writes. Plugin-owned routes are
  // the sanctioned surface (same pattern as dsh-config-sync): these read and
  // write the namespace straight through the host seam, bypassing the proxy
  // allowlist. Neither route ever echoes a credential — only booleans.

  const statusPayload = () => {
    const cfg = effective();
    return {
      ok: true,
      configured: !!(cfg.accessKeyId && cfg.secretAccessKey),
      accessKeyIdSet: !!cfg.accessKeyId,
      secretAccessKeySet: !!cfg.secretAccessKey,
      refreshMs: cfg.refreshMs
    };
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/status",
    handler: async (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, code: "method", message: "GET only" });
        return;
      }
      sendJson(res, 200, statusPayload());
    }
  }), "ark-quota: /ark-quota/status route");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/credentials",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (settingsScope === null) {
        sendJson(res, 503, { ok: false, code: "unavailable", message: "ark-quota 设置命名空间尚未就绪" });
        return;
      }
      const body = await readBody(req);
      if (body._parseError) {
        sendJson(res, 400, { ok: false, code: "parse", message: "请求体不是合法 JSON" });
        return;
      }
      // Fixed-shape write: only the two secret key fields (trimmed non-empty
      // strings). No user-controlled URLs/objects — no SSRF surface.
      const patch = {};
      if (typeof body.accessKeyId === "string" && body.accessKeyId.trim().length > 0) {
        patch.accessKeyId = body.accessKeyId.trim();
      }
      if (typeof body.secretAccessKey === "string" && body.secretAccessKey.trim().length > 0) {
        patch.secretAccessKey = body.secretAccessKey.trim();
      }
      if (Object.keys(patch).length === 0) {
        sendJson(res, 400, { ok: false, code: "noop", message: "没有可写入的访问密钥字段（accessKeyId / secretAccessKey 不能为空）" });
        return;
      }
      try {
        await settingsScope.update(patch);
        ctx.logger.info("ark-quota: credentials updated via /ark-quota/credentials");
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/credentials route");

  // Non-secret UI preferences (refresh cadence). The settings card writes
  // here; this is a narrow, allowlisted field — never arbitrary objects, no
  // URLs/SSRF surface. Credentials continue to go through /credentials.
  const ALLOWED_REFRESH_MS = [60000, 300000, 600000, 1800000, 3600000];
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/ark-quota/settings",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, code: "method", message: "POST only" });
        return;
      }
      if (settingsScope === null) {
        sendJson(res, 503, { ok: false, code: "unavailable", message: "ark-quota 设置命名空间尚未就绪" });
        return;
      }
      const body = await readBody(req);
      if (body._parseError) {
        sendJson(res, 400, { ok: false, code: "parse", message: "请求体不是合法 JSON" });
        return;
      }
      // Strict allowlist: refreshMs must be one of the fixed cadence choices.
      const raw = Number(body.refreshMs);
      if (!ALLOWED_REFRESH_MS.includes(raw)) {
        sendJson(res, 400, {
          ok: false,
          code: "bad-value",
          message: "refreshMs 必须是 60000 / 300000 / 600000 / 1800000 / 3600000 之一"
        });
        return;
      }
      try {
        await settingsScope.update({ refreshMs: raw });
        ctx.logger.info(`ark-quota: refreshMs updated to ${raw}ms via /ark-quota/settings`);
        sendJson(res, 200, statusPayload());
      } catch (error) {
        ctx.logger.warn(error);
        sendJson(res, 400, { ok: false, code: "config", message: String(error?.message ?? error) });
      }
    }
  }), "ark-quota: /ark-quota/settings route");
}
