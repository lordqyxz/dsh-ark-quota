window.__ModuleLoader__.load({
	id: "dsh-ark-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var react_jsx_runtime = require("react/jsx-runtime");
		var jsx = react_jsx_runtime.jsx;
		var jsxs = react_jsx_runtime.jsxs;
		//#region widget
		var DEFAULT_POLL_MS = 5 * 60 * 1000;
		// "session" is actually a 5-hour sliding window (AFPFiveHour / coding session),
		// "weekly"/"monthly" are rolling 7/30-day windows — use precise near-window labels.
		var LEVEL_LABELS = { session: "5小时", weekly: "近1周", monthly: "近1月" };
		var LEVEL_ORDER = ["session", "weekly", "monthly"];

		// Module-scope refresh fan-out: the DSH settings scope is read-only for
		// third-party namespaces, so credentials are saved through the plugin's
		// own /ark-quota/credentials route. This signal tells every mounted
		// widget to re-read the quota right after a save (and on manual refresh).
		var refreshSignal = {
			listeners: new Set(),
			subscribe: function (fn) {
				refreshSignal.listeners.add(fn);
				return function () { refreshSignal.listeners.delete(fn); };
			},
			notify: function () {
				for (var fn of Array.from(refreshSignal.listeners)) {
					try { fn(); } catch (_e) { /* keep other listeners alive */ }
				}
			}
		};

		// ── 模型提供方跟随 ─────────────────────────────────────────────
		// 侧栏卡片是全局的，而 DSH 的模型选择是 per-session 的：每个会话有自己
		// 的 ModelDirectory（宿主的 ctx.modelDirectories 服务），其 store 快照里
		// current.provider 就是当前提供方路由 id。apply 里订阅「当前会话 → 当前
		// provider」写到这个 store；卡片再用账号在设置页勾选的 providers 反查
		// 出账号 id。服务缺失（旧版 DSH / SSR / 测试环境）时 provider 恒为 null，
		// 卡片行为 = 不跟随，与旧版完全一致。
		var followSignal = {
			listeners: new Set(),
			value: { sessionId: null, provider: null },
			subscribe: function (fn) {
				followSignal.listeners.add(fn);
				return function () { followSignal.listeners.delete(fn); };
			},
			getSnapshot: function () { return followSignal.value; },
			set: function (next) {
				var prev = followSignal.value;
				if (prev.sessionId === next.sessionId && prev.provider === next.provider) return;
				followSignal.value = next;
				for (var fn of Array.from(followSignal.listeners)) {
					try { fn(); } catch (_e) { /* 一个监听者抛错不影响其他 */ }
				}
			}
		};

		/** 订阅当前会话的模型提供方路由 id（服务不可用时恒为 null）。 */
		function useFollowProvider() {
			var snap = React.useSyncExternalStore(
				followSignal.subscribe,
				followSignal.getSnapshot,
				followSignal.getSnapshot
			);
			return snap && typeof snap.provider === "string" ? snap : { sessionId: null, provider: null };
		}

		/**
		 * provider 路由 id → 账号 id 反查（账号维度视图）。
		 * 账号在设置页关联的 providers 命中即归属；一个路由最多属于一个凭据组。
		 * 查不到返回 null。
		 */
		function accountForProvider(accounts, provider) {
			if (!provider || !Array.isArray(accounts)) return null;
			for (var i = 0; i < accounts.length; i++) {
				var ps = accounts[i].providers;
				if (Array.isArray(ps) && ps.indexOf(provider) >= 0) return accounts[i].id;
			}
			return null;
		}

		/**
		 * provider 路由 id → 路由视图条目（routes 维度视图）。
		 * 宿主 /ark-quota 响应里的 routes[] 每行就是一个已绑定路由；找不到
		 * 返回 null。路由视图是侧栏切换器与设置页的权威身份。
		 */
		function routeEntry(routes, provider) {
			if (!provider || !Array.isArray(routes)) return null;
			for (var i = 0; i < routes.length; i++) {
				if (routes[i].route === provider) return routes[i];
			}
			return null;
		}

		// ── 宿主导航辅助 ────────────────────────────────────────────────
		// 插件没有公开的「打开设置 / 展开侧边栏」API（settings 壳的 openSection
		// 只在其组件内部、footer.action slot 只收到 wide 标志），这里用稳定的
		// ARIA 属性找到宿主自己的按钮并触发点击。aria-haspopup / role="dialog"
		// 是与语言无关的属性；找不到就静默放弃，绝不能抛错把小组件带崩。

		/** 展开收起状态的侧边栏（rail 模式下点胶囊用）。 */
		function expandSidebar() {
			try {
				// 宿主侧边栏开关按钮的 aria-label 是固定词典：中文「打开/收起侧边栏」、
				// 英文 "Open/Collapse sidebar"。必须精确匹配——胶囊自己的 aria-label
				// 也含「侧边栏」三字，模糊匹配会点到自己造成循环。
				var TOGGLE_LABELS = {
					"打开侧边栏": 1, "收起侧边栏": 1,
					"open sidebar": 1, "collapse sidebar": 1
				};
				var btns = document.querySelectorAll('button[aria-label]');
				for (var i = 0; i < btns.length; i++) {
					var label = String(btns[i].getAttribute("aria-label") || "").trim().toLowerCase();
					if (Object.prototype.hasOwnProperty.call(TOGGLE_LABELS, label)) {
						btns[i].click();
						return;
					}
				}
			} catch (_e) { /* 宿主结构变化时静默降级为无操作 */ }
		}

		/**
		 * 打开设置面板并选中「方舟额度」分区。
		 * 设置触发按钮是侧边栏底部带 aria-haspopup="dialog" 的按钮；
		 * 面板挂载后导航项是 role="dialog" 内文案以「方舟额度」开头的按钮。
		 */
		function openArkSettings() {
			try {
				var triggers = document.querySelectorAll('button[aria-haspopup="dialog"]');
				var trigger = null;
				for (var i = 0; i < triggers.length; i++) {
					if (triggers[i].getAttribute("aria-expanded") === "true") { trigger = triggers[i]; break; }
					if (trigger === null) trigger = triggers[i];
				}
				if (!trigger) return;
				if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
				// 面板挂载后才渲染导航项，轮询几帧等它出现（React 一帧内完成）。
				var tries = 0;
				var pick = function () {
					tries += 1;
					var cell = null;
					var dialogs = document.querySelectorAll('[role="dialog"]');
					for (var d = 0; d < dialogs.length && cell === null; d++) {
						var cells = dialogs[d].querySelectorAll("button");
						for (var j = 0; j < cells.length; j++) {
							if (String(cells[j].textContent || "").trim().indexOf("方舟额度") === 0) {
								cell = cells[j];
								break;
							}
						}
					}
					if (cell) { cell.click(); return; }
					if (tries < 6) window.setTimeout(pick, 80);
				};
				window.setTimeout(pick, 60);
			} catch (_e) { /* 静默降级 */ }
		}

		// 语义档：ok 绿（节奏正常）/ warn 橙（余量紧张）/ over 红（撞线）。
		// 严重度排序，药丸、行、通知都按它取最严重档。
		var STATE_RANK = { ok: 0, warn: 1, over: 2 };

		// 样式一次性懒注入（id 幂等，SSR 环境无 document 直接跳过）：
		// 进度条语义色、轨道淡底、预测段斜纹、告警行侧条、药丸底色、骨架
		// 脉冲、刷新旋转。颜色全部走宿主语义变量（暗色主题自动跟随），
		// color-mix 配 alpha；不支持 color-mix 的老内核经 @supports 回落到
		// 固定 rgba。动画在 prefers-reduced-motion 下全部关停。
		var STYLES_ID = "dsh-ark-quota-styles";
		function ensureStyles() {
			if (typeof document === "undefined" || document.getElementById(STYLES_ID)) return;
			var style = document.createElement("style");
			style.id = STYLES_ID;
			style.textContent = [
				"@keyframes dsh-ark-quota-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }",
				"@keyframes dsh-ark-quota-pulse { 0%, 100% { opacity: .45; } 50% { opacity: .9; } }",
				".arkq-spin { animation: dsh-ark-quota-spin .8s linear infinite; }",
				".arkq-skeleton { animation: dsh-ark-quota-pulse 1.2s ease-in-out infinite; }",
				"@media (prefers-reduced-motion: reduce) {",
				"  .arkq-spin, .arkq-skeleton { animation: none !important; }",
				"}",
				// 进度条填充：三档语义色（替换旧硬编码渐变）。
				".arkq-fill-ok { background: var(--dsw-alias-state-success-primary, #46a758); }",
				".arkq-fill-warn { background: var(--dsw-alias-state-warning-primary, #f5a524); }",
				".arkq-fill-over { background: var(--dsw-alias-state-error-primary, #e5484d); }",
				// 轨道：中性灰底（项目最初形态），不随用量变色。
				".arkq-track { background: var(--dsw-alias-track-bg, rgba(128,128,128,0.18)); }",
				// 预测段：同色系浅色实底（旧轨道淡色的用法挪到这里）——
				// 灰底 = 剩余额度，浅色块 = 按近期速度预计还要烧到的位置。
				".arkq-fc-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #46a758) 18%, transparent); }",
				".arkq-fc-warn { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f5a524) 18%, transparent); }",
				".arkq-fc-over { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 18%, transparent); }",
				// 药丸：淡底 + 语义色字（替换旧 hex 拼 alpha）。
				".arkq-pill-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #46a758) 13%, transparent); color: var(--dsw-alias-state-success-primary, #46a758); }",
				".arkq-pill-warn { background: color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f5a524) 13%, transparent); color: var(--dsw-alias-state-warning-primary, #f5a524); }",
				".arkq-pill-over { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 13%, transparent); color: var(--dsw-alias-state-error-primary, #e5484d); }",
				// 不支持 color-mix 的老内核：预测段用固定 rgba 兜底。
				"@supports not (background: color-mix(in srgb, red 50%, transparent)) {",
				"  .arkq-fc-ok { background: rgba(70,167,88,.18); }",
				"  .arkq-fc-warn { background: rgba(245,165,36,.18); }",
				"  .arkq-fc-over { background: rgba(229,72,77,.18); }",
				"  .arkq-pill-ok { background: rgba(70,167,88,.13); color: #46a758; }",
				"  .arkq-pill-warn { background: rgba(245,165,36,.13); color: #f5a524; }",
				"  .arkq-pill-over { background: rgba(229,72,77,.13); color: #e5484d; }",
				"}"
			].join("\n");
			document.head.appendChild(style);
		}

		// 按当前水位取语义档：<50% ok、50~80% warn、≥80% over。
		function toneOf(percent) {
			var p = clampPct(percent);
			if (p >= 80) return "over";
			if (p >= 50) return "warn";
			return "ok";
		}

		// 语义档 → 宿主状态色变量（暗色主题自动跟随；变量缺失时回落 hex）。
		function stateVar(tone) {
			if (tone === "over") return "var(--dsw-alias-state-error-primary, #e5484d)";
			if (tone === "warn") return "var(--dsw-alias-state-warning-primary, #f5a524)";
			if (tone === "ok") return "var(--dsw-alias-state-success-primary, #46a758)";
			return "var(--dsw-alias-label-tertiary)";
		}

		// 三档额度里最严重的一档（药丸收起态用：5 小时档红了，药丸就必须红）。
		// 同档取百分比更高的；没有有效数据返回 null。
		function worstQuota(quota) {
			var worst = null;
			for (var i = 0; i < quota.length; i++) {
				var q = quota[i];
				if (!q || typeof q.percentUsed !== "number" || !Number.isFinite(q.percentUsed)) continue;
				var tone = toneOf(q.percentUsed);
				if (worst === null
					|| STATE_RANK[tone] > STATE_RANK[worst.tone]
					|| (tone === worst.tone && q.percentUsed > worst.q.percentUsed)) {
					worst = { q: q, tone: tone };
				}
			}
			return worst;
		}

		function pad2(n) { return (n < 10 ? "0" : "") + n; }

		// Precise countdown for the card itself: "3 小时 15 分钟后重置",
		// "2 天 3 小时后重置", etc. Only the two most significant units are shown
		// (days+hours, or hours+minutes) so it stays readable at a glance.
		function fmtReset(ts, now) {
			if (!ts) return "";
			var diff = ts * 1000 - now;
			if (diff <= 0) return "已重置";
			var totalMinutes = Math.floor(diff / 60000);
			if (totalMinutes < 60) {
				return Math.max(1, totalMinutes) + " 分钟后重置";
			}
			var hours = Math.floor(totalMinutes / 60);
			var mins = totalMinutes % 60;
			if (hours < 24) {
				return mins > 0 ? hours + " 小时 " + mins + " 分钟后重置" : hours + " 小时后重置";
			}
			var days = Math.floor(hours / 24);
			var remHours = hours % 24;
			return remHours > 0 ? days + " 天 " + remHours + " 小时后重置" : days + " 天后重置";
		}

		// 紧凑倒计时，用于卡片行内的重置时间：5d16h / 4h12m / 12m。
		// 只保留最高两位单位，宽度固定，便于与百分比并排显示。
		function fmtResetShort(ts, now) {
			if (!ts) return "";
			var diff = ts * 1000 - now;
			if (diff <= 0) return "已重置";
			var totalMinutes = Math.floor(diff / 60000);
			if (totalMinutes < 60) return Math.max(1, totalMinutes) + "m";
			var hours = Math.floor(totalMinutes / 60);
			var mins = totalMinutes % 60;
			if (hours < 24) return mins > 0 ? hours + "h" + mins + "m" : hours + "h";
			var days = Math.floor(hours / 24);
			var remHours = hours % 24;
			return remHours > 0 ? days + "d" + remHours + "h" : days + "d";
		}

		// Absolute wall-clock time for tooltips: "今天 17:45 重置" /
		// "明天 00:00 重置" / "08-23 14:30 重置".
		function fmtResetAt(ts, now) {
			if (!ts) return "";
			var target = new Date(ts * 1000);
			var ref = new Date(now);
			var hhmm = pad2(target.getHours()) + ":" + pad2(target.getMinutes());
			if (target.getFullYear() === ref.getFullYear()
				&& target.getMonth() === ref.getMonth()
				&& target.getDate() === ref.getDate()) {
				return "今天 " + hhmm + " 重置";
			}
			var tomorrow = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + 1);
			if (target.getFullYear() === tomorrow.getFullYear()
				&& target.getMonth() === tomorrow.getMonth()
				&& target.getDate() === tomorrow.getDate()) {
				return "明天 " + hhmm + " 重置";
			}
			return pad2(target.getMonth() + 1) + "-" + pad2(target.getDate()) + " " + hhmm + " 重置";
		}

		function fmtClockMs(ms) {
			if (!ms) return "";
			var d = new Date(ms);
			return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
		}

		function clampPct(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return 0;
			if (n < 0) return 0;
			if (n > 100) return 100;
			return n;
		}

		// Host cachedAt is Date.now() (ms). Unix seconds (~1.7e9) would schedule
		// in the past and Math.max(500, …) would hammer every 500ms — treat
		// values below 1e12 as seconds.
		function normalizeCachedAtMs(v) {
			if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return Date.now();
			return v < 1e12 ? v * 1000 : v;
		}

		function fetchedAtMs(data) {
			if (!data) return 0;
			if (typeof data.cachedAt === "number" && data.cachedAt > 0) return normalizeCachedAtMs(data.cachedAt);
			if (typeof data.updatedAt === "number" && data.updatedAt > 0) return data.updatedAt * 1000;
			return 0;
		}

		// "x 分钟前更新" / "刚刚更新". Driven by useNow so it ticks every minute
		// without a network refetch. `atMs` is milliseconds since epoch.
		function fmtRelativeMs(atMs, now) {
			if (!atMs) return "";
			var diff = Math.max(0, now - atMs);
			var m = Math.floor(diff / 60000);
			if (m < 1) return "刚刚更新";
			if (m < 60) return m + " 分钟前更新";
			var h = Math.floor(m / 60);
			if (h < 24) return h + " 小时前更新";
			return Math.floor(h / 24) + " 天前更新";
		}

		// Compact absolute counts for the tooltip (e.g. 12345 -> "12,345").
		function fmtCount(n) {
			if (typeof n !== "number" || !Number.isFinite(n)) return "";
			return Math.round(n).toLocaleString("en-US");
		}

		var PLAN_LABELS = { "coding-plan": "Coding Plan", "agent-plan": "Agent Plan" };

		// A 1-minute tick used purely for display-local countdowns (reset countdown,
		// relative time). It does NOT trigger any network request — the adaptive
		// setTimeout poll in useQuota owns that.
		function useNow() {
			var now = React.useState(function () { return Date.now(); });
			var setNow = now[1];
			React.useEffect(function () {
				var t = window.setInterval(function () { setNow(Date.now()); }, 60000);
				return function () { window.clearInterval(t); };
			}, [setNow]);
			return now[0];
		}

		// Inline 火山方舟 (Volcano Ark) brand mark — the official ark.volcengine.com
		// console icon, flattened (masks/clipPaths removed) so mounting it twice in
		// the DOM never collides on shared <mask>/<clipPath> ids. Colors kept as-is.
		function ArkLogo(_a) {
			var size = _a.size === undefined ? 16 : _a.size;
			return jsxs("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				shapeRendering: "geometricPrecision",
				"aria-hidden": true,
				style: { flex: "none", display: "block" },
				children: [
					jsx("path", { d: "M0.347656 22.254H6.6917L3.81945 13.22C3.76717 13.05 3.58591 12.958 3.41859 13.0111C3.32099 13.043 3.2443 13.1208 3.21293 13.22L0.347656 22.254Z", fill: "#00DCFF" }),
					jsx("path", { d: "M15.7734 22.2655H23.1353L19.7576 11.6243C19.7053 11.4543 19.5241 11.3623 19.3568 11.4154C19.2592 11.4473 19.1825 11.5251 19.1511 11.6243L15.7734 22.2655Z", fill: "#00DCFF" }),
					jsx("path", { d: "M7.01172 22.2654H20.5922L14.1052 1.9564C14.0494 1.78648 13.8717 1.69444 13.7043 1.75108C13.6067 1.78294 13.5301 1.86082 13.4987 1.9564L7.01172 22.2654Z", fill: "#006AFF" }),
					jsx("path", { d: "M2.8863 22.2674H13.1657L8.32754 7.11265C8.27176 6.94273 8.09399 6.85069 7.92668 6.90733C7.82908 6.93919 7.75239 7.01707 7.72102 7.11265L2.88281 22.2674H2.8863Z", fill: "#006AFF" }),
					jsx("path", { d: "M5.73438 22.2673H14.4278L10.3844 9.67906C10.3286 9.50914 10.1508 9.4171 9.98349 9.47374C9.88589 9.5056 9.81269 9.58348 9.78132 9.67906L5.73786 22.2673H5.73438Z", fill: "#00DCFF" })
				]
			});
		}

		// Schedule the next poll to land just AFTER the host cache expires, not
		// on a fixed blind interval. Equal-interval polling races the host TTL
		// (both 5 min) and can hit a not-yet-expired cache, leaving the widget
		// showing "6 min ago · refreshes every 5 min". Using the server-provided
		// cachedAt + refreshMs plus a small buffer guarantees the next request
		// gets a fresh upstream fetch.
		var POLL_BUFFER_MS = 1500;
		function scheduleNext(timerRef, json, load) {
			if (timerRef.current) window.clearTimeout(timerRef.current);
			var refreshMs = (typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : DEFAULT_POLL_MS;
			var cachedAt = normalizeCachedAtMs(json.cachedAt);
			var nextAt = cachedAt + refreshMs + POLL_BUFFER_MS;
			var delay = Math.max(1000, nextAt - Date.now());
			timerRef.current = window.setTimeout(function () { load(false); }, delay);
		}

		// routeId：llm 提供方路由 id（路由维度查询，宿主反查到凭据组）；
		// accountId 保留兼容（内部账号 id）。两者都为空时宿主按默认账号返回。
		function useQuota(accountId, routeId) {
			var state = React.useState({ loading: true, data: null, error: null });
			var data = state[0], setState = state[1];
			var timerRef = React.useRef(null);
			var abortRef = React.useRef(null);
			var seqRef = React.useRef(0);
			var refreshMsRef = React.useRef(DEFAULT_POLL_MS);
			// 目标放进 ref：load 的依赖数组保持为空（不重建回调），
			// 但每次取数都能读到最新的路由/账号。
			var targetRef = React.useRef({ accountId: accountId, routeId: routeId });
			targetRef.current = { accountId: accountId, routeId: routeId };
			var load = React.useCallback(function (force) {
				var seq = ++seqRef.current;
				if (abortRef.current) abortRef.current.abort();
				var ac = typeof AbortController === "function" ? new AbortController() : null;
				abortRef.current = ac;
				setState(function (prev) {
					var initial = !prev.data && !prev.error;
					return {
						loading: !!(force || initial),
						data: prev.data,
						error: force || initial ? null : prev.error,
						payload: prev.payload || null
					};
				});
				var opts = { cache: "no-store" };
				if (ac) opts.signal = ac.signal;
				var qs = [];
				if (force) qs.push("force=1");
				var t = targetRef.current;
				if (t.routeId) qs.push("route=" + encodeURIComponent(t.routeId));
				else if (t.accountId) qs.push("account=" + encodeURIComponent(t.accountId));
				fetch("/ark-quota" + (qs.length > 0 ? "?" + qs.join("&") : ""), opts)
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (seq !== seqRef.current) return;
						if (json && json.ok === true) {
							if (typeof json.refreshMs === "number" && json.refreshMs > 0) refreshMsRef.current = json.refreshMs;
							setState({ loading: false, data: json, error: null, payload: json });
							scheduleNext(timerRef, json, load);
						} else {
							var auth = json && (json.code === "unauthorized" || json.code === "missing-auth");
							// 失败响应也带 accounts / code：保留整个 body，否则密钥失效时
							// 账号切换器会消失（用户就没法切到另一个可用账号了）。
							setState({ loading: false, data: null, error: (json && json.message) || "查询失败", payload: json || null });
							if (timerRef.current) window.clearTimeout(timerRef.current);
							// Auth failures: don't inherit a 1-minute cadence (would hammer
							// Volcengine with a bad key). Transient errors follow last cadence.
							var retryMs = auth ? DEFAULT_POLL_MS : refreshMsRef.current;
							timerRef.current = window.setTimeout(function () { load(false); }, retryMs);
						}
					})
					.catch(function (e) {
						if (e && e.name === "AbortError") return;
						if (seq !== seqRef.current) return;
						// 网络层失败拿不到 body：保留上一次的 payload，切换器不至于闪没。
						setState(function (prev) {
							return {
								loading: false,
								data: null,
								error: String((e && e.message) || e),
								payload: prev.payload || null
							};
						});
						if (timerRef.current) window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(function () { load(false); }, refreshMsRef.current);
					});
			}, []);
			React.useEffect(function () {
				load(false);
				return function () {
					seqRef.current += 1;
					if (timerRef.current) window.clearTimeout(timerRef.current);
					if (abortRef.current) abortRef.current.abort();
				};
			}, [load]);
			// 切换路由/账号 → 立刻重新取数（targetRef 已是新值）。
			var firstRef = React.useRef(true);
			React.useEffect(function () {
				if (firstRef.current) {
					firstRef.current = false;
					return;
				}
				load(false);
			}, [accountId, routeId, load]);
			// 标签页切回前台时补一次拉取：后台定时器会被浏览器节流，久切回来
			// 卡片可能停在很久以前的数据。load(false) 命中宿主缓存就直接返回，
			// 缓存过期才打上游，代价与一次普通轮询相同。
			React.useEffect(function () {
				var onVisible = function () {
					if (document.visibilityState === "visible") load(false);
				};
				document.addEventListener("visibilitychange", onVisible);
				return function () { document.removeEventListener("visibilitychange", onVisible); };
			}, [load]);
			return { data: data.data, loading: data.loading, error: data.error, payload: data.payload || null, load: load };
		}

		// 时间跨度的简短标签：33 分钟 / 3.3 小时 / 4 天。
		function fmtSpan(ms) {
			if (!ms || ms <= 0) return "0 分钟";
			var mins = Math.floor(ms / 60000);
			if (mins < 60) return mins + " 分钟";
			var hours = mins / 60;
			if (hours < 48) return (Math.round(hours * 10) / 10) + " 小时";
			return Math.floor(hours / 24) + " 天";
		}

		function rowTooltip(item, now) {
			var usedPct = clampPct(item.percentUsed);
			var remPct = clampPct(item.percentRemaining);
			var parts = ["已用 " + usedPct.toFixed(1) + "% · 剩余 " + remPct.toFixed(1) + "%"];
			if (typeof item.used === "number" && typeof item.total === "number" && item.total > 0) {
				parts.push(fmtCount(item.used) + " / " + fmtCount(item.total));
			}
			if (item.resetAt) {
				// 卡片内只显示紧凑倒计时（5d16h），提示里补全精确倒计时与绝对时间。
				parts.push(fmtReset(item.resetAt, now));
				parts.push(fmtResetAt(item.resetAt, now));
			}
			return parts.join("\n");
		}

		// 速率单位匹配「用户做决策的时间尺度」，而不是简单按窗口长短切：
		//   5 小时档：决策尺度是小时（接下来一两个小时还能不能跑），预算
		//             20%/时，典型值 5~30%/时，数字落在直觉区 → %/时；
		//   周 / 月档：用户按天规划用量，预算分别 14.3%/天、3.3%/天，典型值
		//             都在 0~100%/天内，且两档同单位可直接对比「短期爆发 vs
		//             长期可持续」→ %/天（与 AWS/GCP 预算告警的 daily run-rate
		//             口径一致）。周档若用 %/时，全是 0.x 的小数（预算仅
		//             0.6%/时），分辨率差且要 ×24 才能对比。
		function rateUnit(level) {
			return level === "session" ? "hour" : "day";
		}

		// 消耗速度格式化：perDay 是宿主给的「%/天」内部单位，这里按档换算成
		// 展示单位。5 小时档恒定 %/时（窗口里没有「天」的尺度，绝不外推成
		// %/天）；周 / 月档用 %/天，数字太小时放大成 %/周。
		function fmtRate(perDay, level) {
			if (typeof perDay !== "number" || !isFinite(perDay) || perDay < 0) return "—";
			if (rateUnit(level) === "hour") {
				var perHour = perDay / 24;
				if (perHour < 0.05) return "0%/时";
				if (perHour < 10) return (Math.round(perHour * 10) / 10) + "%/时";
				return Math.round(perHour) + "%/时";
			}
			if (perDay === 0) return "0%/天";
			if (perDay < 0.1) return (Math.round(perDay * 70) / 10) + "%/周";
			if (perDay < 10) return (Math.round(perDay * 10) / 10) + "%/天";
			return Math.round(perDay) + "%/天";
		}

		// 节奏分档取色：与健康条共用一套语义色，避免用户学两套配色。
		function burnColor(status) {
			return status === "ok" || status === "warn" || status === "over"
				? stateVar(status)
				: "var(--dsw-alias-label-tertiary)";
		}

		// 速率胶囊的悬浮提示：刻意压到 2~3 行——第一行近期速度 vs 预算速度
		//（同单位直接对比，倍率在括号里），第二行状态，第三行结论时刻。
		function burnTooltip(b, now, resetAtSec) {
			if (!b) return "";
			var lv = b.level;
			now = typeof now === "number" ? now : Date.now();
			var sliding = lv === "session";
			var lines = [];
			// 第一行：近期速度 · 预算速度（倍率）。
			if (typeof b.perDay === "number" && isFinite(b.perDay) && typeof b.ratio === "number") {
				lines.push("近期 " + fmtRate(b.perDay, lv) + " · 预算 " + fmtRate(b.budgetPerDay, lv)
					+ "（" + (Math.round(b.ratio * 100) / 100) + "×）");
			}
			if (sliding) {
				// 第二行：老化与净增速（或直接给「不会到顶」结论）。
				if (typeof b.netPerDay === "number" && isFinite(b.netPerDay)) {
					if (b.netPerDay > 0.05) {
						var aging = (typeof b.agingPerDay === "number" && isFinite(b.agingPerDay))
							? b.agingPerDay : b.budgetPerDay;
						lines.push("老化恢复 " + fmtRate(aging, lv) + " · 净增速 " + fmtRate(b.netPerDay, lv));
					} else {
						lines.push("净增速 ≈ 0，水位不会到顶");
					}
				}
				// 第三行：撞线恢复时刻 / 预计用完时刻。宿主已把越过重置时刻的
				// 耗尽外推置为 null（窗口一滚动旧消耗老化，重置前到不了顶）。
				if (typeof b.recoverAt === "number" && isFinite(b.recoverAt)) {
					lines.push("已到上限：停用后约 " + fmtClockMs(b.recoverAt) + " 恢复到 95%");
				} else if (typeof b.exhaustAt === "number" && isFinite(b.exhaustAt) && b.exhaustAt > now) {
					lines.push("预计 " + fmtClockMs(b.exhaustAt) + " 用完");
				} else if (typeof b.netPerDay === "number" && isFinite(b.netPerDay) && b.netPerDay > 0.05) {
					lines.push("净增速 > 0 但重置前水位到不了顶");
				}
			} else {
				// 第二行：时间/额度进度（事实陈述，不带预测，避免与速率矛盾）。
				if (typeof b.timeProgress === "number" && typeof b.quotaProgress === "number") {
					lines.push("时间 " + Math.round(b.timeProgress * 100)
						+ "% · 额度 " + Math.round(b.quotaProgress * 100) + "%");
				}
				// 第三行：预测结论。宿主按近期样本可信度给出权威口径
				//（forecastBasis=recent：已停用 → 水位维持；猛烧 → 用完时刻；
				// average：周期前期样本不足，按开周期平均节奏投影）。
				var fc = typeof b.forecast === "number" && isFinite(b.forecast) ? b.forecast : null;
				if (fc !== null && b.forecastBasis === "recent") {
					if (fc >= 100 - 0.5
						&& typeof b.exhaustAt === "number" && isFinite(b.exhaustAt) && b.exhaustAt > now) {
						var at = "按近期速度 " + fmtClockMs(b.exhaustAt) + " 用完";
						if (typeof resetAtSec === "number" && resetAtSec * 1000 - b.exhaustAt > 60 * 60 * 1000) {
							at += "（比重置早 " + fmtSpan(resetAtSec * 1000 - b.exhaustAt) + "）";
						}
						lines.push(at);
					} else if (fc - b.quotaProgress * 100 < 2) {
						lines.push("近期已基本停用，水位将维持在 " + Math.round(b.quotaProgress * 100) + "%");
					} else {
						lines.push("按近期速度重置时约用到 " + Math.round(fc) + "%");
					}
				} else if (typeof b.projectedAtReset === "number" && isFinite(b.projectedAtReset)) {
					lines.push(b.projectedAtReset >= 100
						? "按周期内平均节奏，重置前会用完"
						: "按平均节奏重置时约用到 " + Math.round(b.projectedAtReset) + "%");
				}
			}
			return lines.join("\n");
		}

		// 百分比格式化：99.9% 绝不能四舍五入成 100%——额度没满就是没满，
		// 显示 100% 会让用户以为已经撞线。<99.5 取整；99.5 以上保留一位小数
		// （封顶 99.9）；真正 100 才显示 100。
		function fmtPct(p) {
			var n = clampPct(p);
			if (n >= 100) return "100";
			if (n >= 99.5) return String(Math.min(99.9, Math.floor(n * 10) / 10));
			return String(Math.round(n));
		}

		function QuotaRow(_a) {
			var item = _a.item, now = _a.now, burn = _a.burn;
			var usedPct = clampPct(item.percentUsed);
			var tone = toneOf(usedPct);
			var label = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, item.level) ? LEVEL_LABELS[item.level] : item.level;
			var reset = fmtResetShort(item.resetAt, now);
			// 整行一个 tooltip：悬浮任意位置都给同一套明细（已用/剩余百分比、
			// 绝对计数、精确重置时刻）。
			var tip = rowTooltip(item, now);
			// 行内速率胶囊：三档都显示（单位按窗口匹配，%/时 或 %/天）；
			// 安全档用弱化色，危险档用语义色，避免安全行也花花绿绿。
			var showRate = burn && typeof burn.perDay === "number" && isFinite(burn.perDay);
			var rateColor = burn && (burn.status === "warn" || burn.status === "over")
				? burnColor(burn.status) : "var(--dsw-alias-label-tertiary)";
			// ── 预测段：填充末端 → 预测位置的浅色段 ──────────────────
			// 固定周期档：段终点取「近期速度到重置时用到的位置」与「平均节奏
			// 投影」较远者（段覆盖两个口径，不再单画竖线刻度）；滑窗档：
			// 段终点 = 近期速度下的稳态水位（流入与老化持平的收敛点）。
			var fcEnd = null;
			var fcTitle = "";
			if (burn) {
				if (item.level === "session") {
					// 滑窗预测段：按净增速（近期流入 − 老化流出）外推到重置
					// 时刻，而不是画「流入持续整个窗口的理论稳态」——稳态要
					// 5 小时才到得了，距重置只剩几十分钟时毫无意义，且净增速
					// 为负（近期速度不高于老化）时水位根本不涨，不画。
					var horizonMs = item.resetAt ? item.resetAt * 1000 - now : 0;
					if (horizonMs > 0
						&& typeof burn.netPerDay === "number" && isFinite(burn.netPerDay)
						&& burn.netPerDay > 0.05) {
						fcEnd = usedPct + burn.netPerDay * horizonMs / 86400000;
						fcTitle = "按近期净增速，重置前水位约升至 "
							+ Math.round(Math.min(100, fcEnd)) + "%";
					}
				} else if (typeof burn.forecast === "number" && isFinite(burn.forecast)) {
					// 预测段终点直接用宿主权威口径：近期样本可信时按近期势头
					// 外推（已停用就不会再涨），否则按周期内平均节奏投影。
					fcEnd = burn.forecast;
					fcTitle = burn.forecastBasis === "recent"
						? "按近期速度，重置时将用到约 " + Math.round(Math.min(100, fcEnd)) + "%"
						: "按周期内平均节奏，重置时预计用到 " + Math.round(fcEnd) + "%";
				}
			}
			var fcTone = (burn && (burn.status === "over" || burn.status === "warn" || burn.status === "ok"))
				? burn.status : tone;
			var showFc = fcEnd !== null && fcEnd > usedPct + 0.5;
			return jsxs("div", {
				title: tip,
				style: { display: "flex", flexDirection: "column", gap: "3px", minWidth: 0, cursor: "default" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "baseline", gap: "6px", minWidth: 0 },
						children: [
							jsx("span", {
								style: { flex: "none", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)", whiteSpace: "nowrap" },
								children: label
							}),
							showRate ? jsx("span", {
								title: burnTooltip(burn, now, item.resetAt),
								style: {
									flex: "none", fontSize: "10px", lineHeight: "16px",
									fontVariantNumeric: "tabular-nums", color: rateColor,
									whiteSpace: "nowrap"
								},
								children: fmtRate(burn.perDay, item.level)
							}) : null,
							jsx("span", { style: { flex: "1 1 auto", minWidth: 0 } }),
							jsx("span", {
								style: { flex: "none", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
								children: fmtPct(usedPct) + "%"
							}),
							reset ? jsx("span", {
								style: { flex: "none", fontSize: "10px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-tertiary)" },
								children: reset
							}) : null
						]
					}),
					// 进度条：填充 = 已用；浅色段 = 预测还要烧到的位置
					//（段终点取近期速度与平均节奏投影较远者）。
					jsxs("div", {
						role: "progressbar",
						"aria-valuenow": Math.round(usedPct),
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-label": label + "已用 " + fmtPct(usedPct) + "%",
						className: "arkq-track",
						style: { position: "relative", width: "100%", minWidth: 0, height: "6px", borderRadius: "3px", overflow: "hidden" },
						children: [
							jsx("div", {
								// 常规填充：宽度 = 已用百分比，颜色按语义档切换（绿/橙/红）。
								className: "arkq-fill-" + tone,
								style: { height: "100%", width: usedPct + "%", borderRadius: "3px", transition: "width .3s, background .3s" }
							}),
							// 预测段：只在投影确实高于当前水位时画，否则与填充末端重合没有信息量。
							showFc ? jsx("div", {
								title: fcTitle,
								className: "arkq-fc-" + fcTone,
								style: {
									position: "absolute", top: 0, bottom: 0,
									left: usedPct + "%",
									width: Math.max(0, Math.min(100, fcEnd) - usedPct) + "%",
									borderRadius: "0 3px 3px 0"
								}
							}) : null
						]
					})
				]
			});
		}

		function PlanBadge(_a) {
			var plan = _a.plan;
			var label = Object.prototype.hasOwnProperty.call(PLAN_LABELS, plan) ? PLAN_LABELS[plan] : plan;
			return jsx("span", {
				title: "当前套餐：" + label,
				style: {
					flex: "none", padding: "0 5px", fontSize: "10px", lineHeight: "14px",
					borderRadius: "3px", color: "var(--dsw-alias-label-secondary)",
					background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.18))",
					fontVariantNumeric: "tabular-nums"
				},
				children: label
			});
		}

		function RefreshButton(_a) {
			var onClick = _a.onClick, title = _a.title, spinning = _a.spinning, disabled = _a.disabled;
			// 旋转动画走注入的 .arkq-spin class（prefers-reduced-motion 下自动关停）。
			ensureStyles();
			var iconStyle = {
				display: "inline-block",
				lineHeight: "1",
				transform: "translateY(-1px)"
			};
			var btnStyle = {
				flex: "none", width: "18px", height: "18px", display: "inline-flex",
				alignItems: "center", justifyContent: "center", padding: "0",
				border: "none", borderRadius: "4px",
				cursor: disabled ? "not-allowed" : "pointer",
				background: "transparent",
				color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
				fontSize: "12px", lineHeight: "1",
				opacity: disabled ? 0.6 : 1,
				transition: "opacity .2s"
			};
			return jsx("button", {
				type: "button",
				title: title,
				disabled: disabled,
				onClick: onClick,
				style: btnStyle,
				"aria-busy": spinning ? "true" : "false",
				children: jsx("span", { className: spinning ? "arkq-spin" : undefined, style: iconStyle, children: "⟳" })
			});
		}

		// Human-readable cadence label (e.g. "每 1 分钟自动刷新" / "每 30 分钟自动刷新").
		// 只在刷新按钮的 title 里使用，不占卡片版面。
		function refreshCadence(refreshMs) {
			var ms = (typeof refreshMs === "number" && refreshMs > 0) ? refreshMs : DEFAULT_POLL_MS;
			if (ms < 60000) return "每 " + Math.round(ms / 1000) + " 秒自动刷新";
			var mins = Math.round(ms / 60000);
			if (mins >= 60 && mins % 60 === 0) return "每 " + (mins / 60) + " 小时自动刷新";
			return "每 " + mins + " 分钟自动刷新";
		}

		// 账号切换器：头部右侧的紧凑小下拉，和刷新按钮待在同一个角落。
		//
		// 自绘胶囊 + 透明原生 select：账号名自己画，胶囊宽度随名字自适应
		// （短名字胶囊就短，不再固定撑宽）；一个 opacity:0 的原生
		// select 盖在最上层接收点击，展开的仍是系统原生下拉（无障碍、长名字
		// 在选项里完整显示）。单账号时不渲染。
		// 自动跟随项的固定 option 值：与路由 id 命名空间隔离（路由 id 可能含
		// 连字符，但不会出现双下划线前后缀）。
		var AUTO_OPTION = "__auto__";
		// 侧栏切换器：以 llm 提供方路由为选项。routes = 宿主 routes 视图（已绑定
		// 凭据的路由）；currentRoute = 当前展示的路由 id；autoMode = 是否跟随。
		// 只有 0~1 个已绑定路由时不渲染（单路由无需切换）。
		function AccountSwitcher(_a) {
			var routes = _a.routes, currentRoute = _a.currentRoute, onSelect = _a.onSelect, autoMode = _a.autoMode;
			if (!Array.isArray(routes) || routes.length < 2) return null;
			// 受控 select 的值必须命中某个 option，否则浏览器把它置于「无选中项」
			// 状态、点击选项无反应。固定的路由若不在清单里（旧配置残留等）就回退
			// 到自动项，保证下拉始终可选。
			var inList = currentRoute && routes.some(function (r) { return r.route === currentRoute; });
			var selectValue = (!autoMode && inList) ? currentRoute : AUTO_OPTION;
			var shown = routes.find(function (r) { return r.route === (inList ? currentRoute : null); })
				|| routes.find(function (r) { return r.route === currentRoute; })
				|| routes[0];
			var currentLabel = shown ? (shown.name || shown.route) : "自动";
			return jsxs("span", {
				title: selectValue === AUTO_OPTION
					? "自动：跟随当前会话的模型提供方（现在显示：" + currentLabel + "）。点击可固定查看某个提供方。"
					: "已固定查看提供方：" + currentLabel + "。选「自动」可恢复随模型切换。",
				style: {
					position: "relative", display: "inline-flex", flex: "none",
					alignItems: "center", height: "20px", maxWidth: "180px",
					borderRadius: "5px", cursor: "pointer",
					background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.14))"
				},
				children: [
					// 路由名：宽度随文字走，过长在胶囊内截断。
					jsx("span", {
						style: {
							padding: "0 10px", fontSize: "11px", lineHeight: "20px",
							color: "var(--dsw-alias-label-secondary)",
							whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
						},
						children: selectValue === AUTO_OPTION && autoMode ? currentLabel : currentLabel
					}),
					// 透明原生 select 盖满整个胶囊：只负责接收点击和弹出系统下拉。
					jsx("select", {
						value: selectValue,
						"aria-label": "切换模型提供方",
						onChange: function (e) { onSelect(e.target.value === AUTO_OPTION ? null : e.target.value); },
						style: {
							position: "absolute", inset: "0", width: "100%", height: "100%",
							margin: "0", padding: "0 14px 0 8px", border: "none", cursor: "pointer", opacity: "0",
							appearance: "none", WebkitAppearance: "none", MozAppearance: "none", fontSize: "11px"
						},
						children: [
							jsx("option", {
								value: AUTO_OPTION,
								style: { paddingLeft: "8px", paddingRight: "12px" },
								children: "自动"
							}, AUTO_OPTION)
						].concat(routes.map(function (r) {
							var label = r.name || r.route;
							return jsx("option", {
								value: r.route,
								style: { paddingLeft: "8px", paddingRight: "12px" },
								children: r.configured === false ? label + "（未配密钥）" : label
							}, r.route);
						}))
					})
				]
			});
		}

		function Card(_a) {
			var state = _a.state, onRefresh = _a.onRefresh, loading = _a.loading;
			var routes = _a.routes, currentRoute = _a.currentRoute, onSelectRoute = _a.onSelectRoute;
			var autoMode = _a.autoMode === true;
			ensureStyles();
			var now = useNow();
			var data = state.data;
			// 重置时刻已过但还显示旧填充：上游额度其实已重置，本地是上次轮询的
			// 缓存（最长一个刷新周期）。检测到任一档 resetAt 已过就强制刷新一次；
			// 用 ref 按 resetAt 去重，刷新后新数据带未来的 resetAt，直到下次重置。
			var pastResetRef = React.useRef(null);
			React.useEffect(function () {
				if (!data || loading || !Array.isArray(data.quota)) return;
				var past = null;
				for (var i = 0; i < data.quota.length; i++) {
					var ra = data.quota[i].resetAt;
					if (ra && ra * 1000 <= Date.now()) { past = ra; break; }
				}
				if (past && pastResetRef.current !== past) {
					pastResetRef.current = past;
					onRefresh();
				}
			});
			var cardOuter = {
				boxSizing: "border-box", width: "100%", minWidth: 0,
				padding: "10px 12px", display: "flex", flexDirection: "column", gap: "8px",
				borderRadius: "10px", overflow: "hidden",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
				background: "var(--dsw-alias-bg-base, transparent)",
				// Subpixel antialiasing for crisp text on Windows.
				WebkitFontSmoothing: "antialiased",
				MozOsxFontSmoothing: "grayscale"
			};
			if (state.error) {
				return jsxs("div", {
					style: Object.assign({}, cardOuter, { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-state-error-primary, #e5484d)" }),
					children: [
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "6px" },
							children: [
								jsx(ArkLogo, { size: 14 }),
								jsx("span", { style: { flex: "1", fontWeight: "500" }, children: "方舟额度" }),
								jsx(AccountSwitcher, { routes: routes, currentRoute: currentRoute, onSelect: onSelectRoute, autoMode: autoMode }),
								jsx(RefreshButton, { onClick: onRefresh, title: "立即重试" })
							]
						}),
						jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all", minWidth: 0 }, children: state.error }),
						jsx("button", {
							type: "button",
							onClick: openArkSettings,
							title: "打开 设置 → 方舟额度",
							style: {
								alignSelf: "flex-start", padding: "0", border: "none", background: "transparent",
								cursor: "pointer", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))",
								fontSize: "11px", lineHeight: "16px", textDecoration: "underline"
							},
							children: "请在 设置 → 方舟额度 中检查访问密钥 AK/SK（点击直达）"
						})
					]
				});
			}
			var quota = data ? data.quota : [];
			var rows = LEVEL_ORDER
				.map(function (level) { return quota.find(function (q) { return q.level === level; }); })
				.filter(Boolean);
			var burn = (data && data.burn) || {};
			var fetched = fetchedAtMs(data);
			// 告急换路由建议：短期档（5 小时/周）over 且 1 小时内会用完（或已
			// 撞线）时，找一个月度余量最足的已配置路由（<80%），头部给一键
			// 切换。建议切换走路由维度（与切换器一致）。
			var switchHint = null;
			(function () {
				if (!data || !Array.isArray(routes)) return;
				var urgentLevel = null;
				rows.some(function (item) {
					if (item.level === "monthly") return false;
					var b = Object.prototype.hasOwnProperty.call(burn, item.level) ? burn[item.level] : null;
					if (!b || b.status !== "over") return false;
					var hit = (typeof b.exhaustAt === "number" && b.exhaustAt - now <= 60 * 60 * 1000)
						|| item.percentUsed >= 99.5;
					if (hit) { urgentLevel = item.level; return true; }
					return false;
				});
				if (!urgentLevel) return;
				var best = null;
				for (var i = 0; i < routes.length; i++) {
					var r = routes[i];
					if (r.route === currentRoute || r.configured === false) continue;
					if (typeof r.monthlyPct !== "number" || !Number.isFinite(r.monthlyPct) || r.monthlyPct >= 80) continue;
					if (best === null || r.monthlyPct < best.monthlyPct) best = r;
				}
				if (best) {
					switchHint = { route: best.route, label: best.name || best.route, monthlyPct: best.monthlyPct, level: urgentLevel };
				}
			})();
			// 首屏加载（无数据也无错误）时给骨架条，避免卡片高度跳动。
			var showSkeleton = loading && !data;
			// 卡片自上而下两段，每段职责单一、都铺满整宽：
			//   1 头部    标题 + 套餐徽章 …… 账号下拉（多账号时）+ 刷新
			//   2 额度    每档一行（分类 + 消耗速度 …… 百分比 + 重置），底部时间
			return jsxs("div", {
				style: cardOuter,
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0 },
						children: [
							jsx(ArkLogo, { size: 15 }),
							jsx("span", {
								style: { flex: "none", fontSize: "12px", fontWeight: "500", lineHeight: "18px", color: "var(--dsw-alias-label-primary)" },
								children: "方舟额度"
							}),
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							// 头部右侧 = 操作区：告急换号 + 账号下拉（多账号时）+ 刷新。
							switchHint ? jsx("button", {
								type: "button",
								title: (Object.prototype.hasOwnProperty.call(LEVEL_LABELS, switchHint.level)
									? LEVEL_LABELS[switchHint.level] : switchHint.level)
									+ "额度即将用完，切换到余量更足的提供方「" + switchHint.label
									+ "」（近1月已用 " + fmtPct(clampPct(switchHint.monthlyPct)) + "%）",
								onClick: function () { onSelectRoute(switchHint.route); },
								style: {
									flex: "none", padding: "0 2px", border: "none", background: "transparent",
									cursor: "pointer", fontSize: "11px", lineHeight: "18px",
									color: stateVar("over"), textDecoration: "underline", whiteSpace: "nowrap"
								},
								children: "切到「" + switchHint.label + "」"
							}) : null,
							jsx(AccountSwitcher, { routes: routes, currentRoute: currentRoute, onSelect: onSelectRoute, autoMode: autoMode }),
							jsx(RefreshButton, {
								onClick: onRefresh,
								spinning: loading,
								disabled: loading,
								title: loading
									? "刷新中…"
									: (data ? "立即刷新 · " + refreshCadence(data.refreshMs) : "立即刷新")
							})
						]
					}),
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 },
						children: showSkeleton ? jsx("div", {
							style: { display: "flex", flexDirection: "column", gap: "10px", padding: "2px 0" },
							children: [0, 1, 2].map(function (i) {
								return jsxs("div", {
									style: { display: "flex", flexDirection: "column", gap: "5px" },
									children: [
										jsx("div", {
											className: "arkq-skeleton",
											style: {
												height: "11px", width: i === 1 ? "78%" : "56%", borderRadius: "4px",
												background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.18))"
											}
										}),
										jsx("div", {
											className: "arkq-skeleton",
											style: {
												height: "6px", width: "100%", borderRadius: "3px",
												background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.18))"
											}
										})
									]
								}, "sk" + i);
							})
						}) : rows.length > 0 ? rows.map(function (item) {
							return jsx(QuotaRow, {
								item: item,
								now: now,
								burn: Object.prototype.hasOwnProperty.call(burn, item.level) ? burn[item.level] : null
							}, item.level);
						}) : jsxs("div", {
							style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
							children: [
								data && data.noPlan
									? "未检测到方舟套餐订阅：Coding Plan 与 Agent Plan 接口都没有返回额度。请确认该账号已开通套餐，或这组 AK/SK 属于正确的火山账号。"
									: "暂无额度数据（上游未返回可用数据，可点右上角 ⟳ 重试）。",
								" ",
								jsx("button", {
									type: "button",
									onClick: openArkSettings,
									style: {
										padding: "0", border: "none", background: "transparent", cursor: "pointer",
										color: "var(--dsw-alias-label-secondary)", fontSize: "11px", textDecoration: "underline"
									},
									children: "检查账号设置"
								})
							]
						})
					}),
					data && fetched ? jsxs("div", {
						// 底部 = 信息区：套餐徽章、奖励徽章靠左（静态信息），更新时间靠右。
						// 套餐类型放这里而不是头部：右上角只留「账号下拉 + 刷新」两个操作，不挤。
						style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" },
						children: [
							// 套餐徽章（Coding Plan / Agent Plan）
							data.plan ? jsx(PlanBadge, { plan: data.plan }) : null,
							// 奖励徽章
							data.hasReward ? jsxs("span", {
								title: "该套餐含额外奖励额度",
								style: { flex: "none", display: "inline-flex", alignItems: "center", gap: "4px", color: "var(--dsw-alias-state-info-primary, #0ea5e9)" },
								children: [
									jsx("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#0ea5e9", display: "inline-block" } }),
									"含奖励额度"
								]
							}) : null,
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							jsx("span", {
								title: "上次更新：" + fmtClockMs(fetched),
								style: { flex: "none", fontVariantNumeric: "tabular-nums" },
								children: fmtRelativeMs(fetched, now)
							})
						]
					}) : null
				]
			});
		}

		function RailPill(_a) {
			var state = _a.state;
			ensureStyles();
			var quota = (state.data && Array.isArray(state.data.quota)) ? state.data.quota : [];
			// 颜色与数字都跟最严重的一档走：5 小时档 98% 红了，收起侧栏后
			// 药丸绝不能还是月度档的绿色——否则最紧急的信号在 rail 态消失。
			var worst = worstQuota(quota);
			var pct = worst ? clampPct(worst.q.percentUsed) : null;
			// 胶囊不再是死按钮：出错（!）时点击直接打开 设置 → 方舟额度 修密钥；
			// 正常时点击展开侧边栏，宽版卡片就在 rail 展开后的底部。
			var hasError = !!state.error;
			// tooltip 给全三档明细；数字本身只显示最紧急那一档。
			var detail = LEVEL_ORDER.map(function (lv) {
				var q = quota.find(function (x) { return x.level === lv; });
				if (!q || typeof q.percentUsed !== "number") return null;
				var lb = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, lv) ? LEVEL_LABELS[lv] : lv;
				return lb + " " + fmtPct(clampPct(q.percentUsed)) + "%";
			}).filter(Boolean).join(" · ");
			var worstLabel = worst
				? (Object.prototype.hasOwnProperty.call(LEVEL_LABELS, worst.q.level) ? LEVEL_LABELS[worst.q.level] : worst.q.level)
				: "";
			var title = "方舟额度" + (detail ? " · " + detail : "（无数据）")
				+ (worst ? "（最紧急：" + worstLabel + "）" : "")
				+ (hasError ? " · " + state.error : "")
				+ (hasError ? " · 点击打开设置" : " · 点击展开侧边栏");
			return jsx("button", {
				type: "button",
				title: title,
				"aria-label": hasError
					? "方舟额度出错，点击打开设置"
					: "方舟额度，" + (worst ? worstLabel + "已用 " + fmtPct(pct) + "%，" : "") + "点击展开侧边栏",
				onClick: function () {
					if (hasError) openArkSettings();
					else expandSidebar();
				},
				className: !hasError && worst ? "arkq-pill-" + worst.tone : undefined,
				style: {
					flex: "none", minWidth: "30px", height: "22px", padding: "0 7px",
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "999px", cursor: "pointer",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: hasError || worst ? undefined : "var(--dsw-alias-bg-base, transparent)",
					color: hasError ? "var(--dsw-alias-state-error-primary, #e5484d)" : undefined,
					fontSize: "11px", fontVariantNumeric: "tabular-nums"
				},
				children: pct === null ? (hasError ? "!" : "—") : fmtPct(pct) + "%"
			});
		}

		function ArkQuotaWidget(_a) {
			var wide = _a.wide;
			// 查看模式（路由维度）：pickedRoute = null 表示自动模式（跟随当前
			// 会话模型所用的提供方路由，无关联时回落宿主默认）；非 null 表示
			// 手动固定查看某个提供方路由。手动固定写回宿主（pinnedRoute，下次
			// 打开还是上次看的那个）；自动跟随不写宿主——多窗口/多会话各自
			// 跟随，互不干扰。
			var pickedSel = React.useState(undefined);
			// undefined = 尚未从宿主响应恢复；null = 自动；字符串 = 固定路由。
			var pickedRoute = pickedSel[0], setPickedRoute = pickedSel[1];
			// 当前会话使用的模型提供方路由 id（宿主服务缺失时恒为 null）。
			var follow = useFollowProvider();
			// 自动模式下解析出的路由 id。渲染期收敛（依赖响应里的 routes 视图，
			// 首帧 null 取默认，到达后立即重渲染；useQuota effect 只在收敛帧跑）。
			var autoSel = React.useState(null);
			var autoRoute = autoSel[0], setAutoRoute = autoSel[1];
			// 取数路由：固定 > 自动跟随 > 空（宿主按默认账号）。
			var queryRoute = pickedRoute === undefined || pickedRoute === null
				? autoRoute
				: pickedRoute;
			var q = useQuota(null, queryRoute);
			var reload = q.load;
			React.useEffect(function () {
				// Re-read immediately after a credentials/settings save (see refreshSignal).
				return refreshSignal.subscribe(function () { reload(true); });
			}, [reload]);

			// 路由视图与账号清单都来自 /ark-quota 的响应（成功或失败都会带）。
			var payload = q.data || q.payload || null;
			var routes = (payload && Array.isArray(payload.routes)) ? payload.routes : [];
			var accounts = (payload && Array.isArray(payload.accounts)) ? payload.accounts : [];
			// 首次从宿主响应恢复固定状态：pinnedRoute 是持久化的手动固定。
			React.useEffect(function () {
				if (pickedRoute !== undefined) return;
				if (payload && typeof payload.pinnedRoute === "string" && payload.pinnedRoute.length > 0) {
					setPickedRoute(payload.pinnedRoute);
				} else {
					setPickedRoute(null);
				}
				// 只在首次拿到 payload 时恢复一次。
			}, [payload, pickedRoute]);
			// 自动模式：跟随当前会话 provider（它必须在已绑定路由清单里）。
			var followEntry = routeEntry(routes, follow.provider);
			var followRoute = followEntry ? followEntry.route : null;
			var wantedAuto = (pickedRoute === undefined || pickedRoute === null) ? followRoute : autoRoute;
			if (wantedAuto !== autoRoute) setAutoRoute(wantedAuto);

			// 当前展示的路由：固定优先，其次自动跟随，再退回响应里的账号归属。
			var displayRoute = (pickedRoute && pickedRoute.length > 0 ? pickedRoute : null)
				|| autoRoute
				|| (function () {
					// 无路由视图（旧宿主/无绑定）时退回账号 id 反查：把响应的
					// accountId 映射回它的第一个路由，保证切换器有选中项。
					if (!payload) return null;
					var acc = accounts.find(function (x) { return x.id === (payload.accountId || payload.activeAccountId); });
					return acc && Array.isArray(acc.providers) && acc.providers.length > 0 ? acc.providers[0] : null;
				})();
			var onSelectRoute = React.useCallback(function (route) {
				if (route === null) {
					// 选回「自动跟随」：清本地固定 + 通知宿主解除 pin。
					setPickedRoute(null);
					fetch("/ark-quota/routes", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "pin", route: "" })
					}).catch(function () {});
					return;
				}
				setPickedRoute(route);
				// 写回宿主固定到该路由；失败也不影响本次查看（本地态已切）。
				fetch("/ark-quota/routes", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "pin", route: route })
				}).catch(function () {});
			}, []);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error } });
			return jsx(Card, {
				state: { data: q.data, error: q.error },
				loading: q.loading,
				routes: routes,
				currentRoute: displayRoute,
				autoMode: !(pickedRoute && pickedRoute.length > 0),
				onSelectRoute: onSelectRoute,
				onRefresh: function () { reload(true); }
			});
		}

		// Fixed refresh cadence choices the host's /ark-quota/settings route accepts.
		var REFRESH_CHOICES = [
			{ ms: 60000, label: "每 1 分钟" },
			{ ms: 300000, label: "每 5 分钟（默认）" },
			{ ms: 600000, label: "每 10 分钟" },
			{ ms: 1800000, label: "每 30 分钟" },
			{ ms: 3600000, label: "每 1 小时" }
		];

		function SelectField(_a) {
			var label = _a.label, value = _a.value, onChange = _a.onChange, options = _a.options, hint = _a.hint, disabled = _a.disabled;
			var selectStyle = {
				boxSizing: "border-box", padding: "4px 8px", fontSize: "12px", lineHeight: "16px",
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
				borderRadius: "6px", cursor: disabled ? "wait" : "pointer", opacity: disabled ? 0.6 : 1
			};
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
				children: [
					jsx("span", { style: { flex: "none", minWidth: "64px" }, children: label }),
					jsxs("select", { value: value, onChange: onChange, style: selectStyle, disabled: disabled, children:
						options.map(function (o) { return jsx("option", { value: String(o.value), children: o.label }, String(o.value)); })
					}),
					hint ? jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: hint }) : null
				]
			});
		}

		// 旧的多账号复选选择器已下线（路由中心化后归属由「选路由 → 填密钥」
		// 直接建立）。保留一个不渲染任何东西的占位，避免历史引用漏改时报错。
		function ProviderPicker(_a) { return null; }

		function ArkQuotaSettingsCard() {
			var d = React.useState({ ak: "", sk: "" });
			var draft = d[0], setDraft = d[1];
			var s = React.useState({
				loading: true, configured: false, saving: false, msg: null, msgError: false,
				refreshMs: DEFAULT_POLL_MS, savingRefresh: false,
				// 路由维度：routes = 已绑定凭据的路由视图（status 带出）；
				// providers = llm 清单里可配置的方舟路由（/providers 带出）。
				routes: [], accounts: [], activeAccountId: "", pinnedRoute: "",
				providers: [], claimed: {}, foreignClaimed: [], busy: false,
				// 默认只列火山方舟的路由；showAllProviders 打开后列全部。
				providersFiltered: 0, showAllProviders: false,
				// 当前选中编辑的模型提供方路由 id；"" = 尚未选择。
				editingRoute: ""
			});
			var state = s[0], setState = s[1];

			// 路由是否已配置凭据（routes 视图里有且 configured）。claimed 仅用于
			// 路由清单里的「· 已配置」标记，不作为是否可清除的判据。
			var routeView = function (routeId) {
				if (!routeId) return null;
				for (var i = 0; i < state.routes.length; i++) {
					if (state.routes[i].route === routeId) return state.routes[i];
				}
				return null;
			};
			var editingRoute = state.editingRoute;
			var currentRoute = editingRoute ? routeView(editingRoute) : null;
			// 「清除配置」仅当该路由所属凭据组已填密钥时才出现。
			var currentConfigured = currentRoute ? currentRoute.configured === true : false;

			var applyStatus = function (json, extra) {
				setState(function (prev) {
					var routes = (json && Array.isArray(json.routes)) ? json.routes : prev.routes;
					return {
						...prev,
						loading: false,
						configured: !!(json && json.ok === true && json.configured),
						refreshMs: (json && typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : prev.refreshMs,
						routes: routes,
						accounts: (json && Array.isArray(json.accounts)) ? json.accounts : prev.accounts,
						activeAccountId: (json && typeof json.activeAccountId === "string") ? json.activeAccountId : prev.activeAccountId,
						pinnedRoute: (json && typeof json.pinnedRoute === "string") ? json.pinnedRoute : prev.pinnedRoute,
						msgError: false,
						...(extra || {})
					};
				});
			};
			// 取 provider 清单。all=true 时连非火山方舟的路由一起列出来。
			var loadProviders = React.useCallback(function (all) {
				fetch("/ark-quota/providers" + (all ? "?all=1" : ""), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setState(function (prev) {
								return {
									...prev,
									providers: Array.isArray(json.providers) ? json.providers : [],
									claimed: json.claimed || {},
									foreignClaimed: Array.isArray(json.foreignClaimed) ? json.foreignClaimed : [],
									providersFiltered: Number(json.filtered) || 0,
									showAllProviders: !!all
								};
							});
						}
					})
					.catch(function () {});
			}, []);
			var loadStatus = React.useCallback(function () {
				fetch("/ark-quota/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						applyStatus(json);
						// 首次加载：自动选中第一个方舟路由（已绑定且已配置的优先，
						// 其次已绑定，再次取路由视图第一个），用户进来即可直接填密钥。
						var preselect = "";
						var listed = (json && Array.isArray(json.routes)) ? json.routes : [];
						for (var i = 0; i < listed.length; i++) {
							if (listed[i].configured) { preselect = listed[i].route; break; }
						}
						if (!preselect && listed.length > 0) preselect = listed[0].route;
						setState(function (prev) {
							return prev.editingRoute ? prev : { ...prev, editingRoute: preselect };
						});
					})
					.catch(function () {
						setState(function (prev) { return { ...prev, loading: false }; });
					});
				loadProviders(false);
			}, [loadProviders]);
			React.useEffect(function () { loadStatus(); }, [loadStatus]);

			var onRefreshChange = function (e) {
				var ms = Number(e.target.value);
				if (!(ms > 0)) return;
				setState(function (prev) { return { ...prev, savingRefresh: true }; });
				fetch("/ark-quota/settings", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ refreshMs: ms })
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							applyStatus(json, { savingRefresh: false, refreshMs: ms });
							refreshSignal.notify(); // cards re-read immediately and re-arm their poll timer
						} else {
							setState(function (prev) { return { ...prev, savingRefresh: false, msgError: true, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (err) {
						setState(function (prev) { return { ...prev, savingRefresh: false, msgError: true, msg: "保存失败：" + String((err && err.message) || err) }; });
					});
			};
			var onSave = function () {
				if (!editingRoute) {
					setState(function (prev) { return { ...prev, msgError: true, msg: "请先在上方选择一个模型提供方" }; });
					return;
				}
				if (!draft.ak && !draft.sk) {
					setState(function (prev) { return { ...prev, msgError: true, msg: "未填写任何值" }; });
					return;
				}
				setState(function (prev) { return { ...prev, saving: true, msg: null }; });
				fetch("/ark-quota/credentials", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						// 密钥按路由保存：宿主首次绑定时自动建凭据组，同 AK/SK
						// 自动并入同一组（同一火山账号不重复）。
						route: editingRoute,
						accessKeyId: draft.ak || undefined,
						secretAccessKey: draft.sk || undefined
					})
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setDraft({ ak: "", sk: "" });
							applyStatus(json, { saving: false, savingRefresh: false, msg: "已保存并热生效（无需重启）" });
							// 归属可能变化，刷新 provider 清单。
							loadProviders(state.showAllProviders);
							refreshSignal.notify();
							return json;
						} else {
							setState(function (prev) { return { ...prev, saving: false, msgError: true, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (e) {
						setState(function (prev) { return { ...prev, saving: false, msgError: true, msg: "保存失败：" + String((e && e.message) || e) }; });
					});
			};
			// 清除配置：删掉该路由所属凭据组（AK/SK 与该火山账号绑定的所有
			// 路由一起移除），额度跟随与查询随之失效。
			var onClearRoute = function () {
				if (!editingRoute || !currentConfigured) return;
				var ok = typeof window === "undefined" || typeof window.confirm !== "function"
					|| window.confirm("清除提供方「" + editingRoute + "」的方舟额度配置？\n这会删除已保存的 AK/SK；该火山账号绑定的其它路由也会一并停止查询额度。");
				if (!ok) return;
				setState(function (prev) { return { ...prev, busy: true, msg: null }; });
				fetch("/ark-quota/routes", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "clear", route: editingRoute })
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							applyStatus(json, { busy: false, msg: "已清除 " + editingRoute + " 的配置" });
							loadProviders(state.showAllProviders);
							refreshSignal.notify();
						} else {
							setState(function (prev) { return { ...prev, busy: false, msgError: true, msg: (json && json.message) || "清除失败" }; });
						}
					})
					.catch(function (e) {
						setState(function (prev) { return { ...prev, busy: false, msgError: true, msg: "清除失败：" + String((e && e.message) || e) }; });
					});
			};
			var inputStyle = {
				boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: "12px", lineHeight: "16px",
				color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))", borderRadius: "6px"
			};
			var btnStyle = {
				padding: "4px 10px", fontSize: "11px", lineHeight: "16px", borderRadius: "6px", cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
				background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))",
				color: "var(--dsw-alias-label-primary)"
			};
			// 设置页可配置的路由清单：llm 方舟路由（/providers）为主，已配置但
			// 未出现在清单里的（适配器未加载等）也补进来，保证清除有入口。
			var optionRoutes = state.providers.slice();
			(function () {
				for (var i = 0; i < state.routes.length; i++) {
					var r = state.routes[i];
					if (!optionRoutes.some(function (p) { return p.id === r.route; })) {
						optionRoutes.push({ id: r.route, name: r.name || r.route });
					}
				}
			})();
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "520px" },
				children: [
					// 防浏览器/密码管理器自动填充：两个移出屏幕的诱饵框吸收 autofill。
					jsx("input", { type: "text", name: "ark-decoy-username", autoComplete: "username", tabIndex: -1, "aria-hidden": true, readOnly: true, value: "", style: { position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" } }, "decoy-u"),
					jsx("input", { type: "password", name: "ark-decoy-password", autoComplete: "current-password", tabIndex: -1, "aria-hidden": true, readOnly: true, value: "", style: { position: "absolute", left: "-9999px", top: "auto", width: "1px", height: "1px", opacity: 0, pointerEvents: "none" } }, "decoy-p"),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px" },
						children: [
							jsx(ArkLogo, { size: 16 }),
							jsx("span", { style: { fontWeight: "500", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: "方舟额度" }),
							editingRoute
								? jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: currentConfigured ? "var(--dsw-alias-state-success-primary, #46a758)" : (currentBound ? "var(--dsw-alias-state-warning-primary, #f5a524)" : "var(--dsw-alias-label-tertiary)") }, children: currentConfigured ? "已配置" : (currentBound ? "未配密钥" : "未配置") })
								: null
						]
					}),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: "选择模型提供方并填写火山引擎 AK/SK；会话切到该提供方时，侧栏额度卡片自动跟随。同一组 AK/SK 填给多个提供方会自动识别为同一个火山账号。密钥仅存本地，保存即生效。"
					}),
					jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "2px 0" }
					}),
					// 模型提供方选择
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { style: { flex: "none", minWidth: "64px" }, children: "模型提供方" }),
							optionRoutes.length > 0 ? jsxs("select", {
								value: editingRoute,
								onChange: function (e) {
									var rid = e.target.value;
									setState(function (prev) {
										return { ...prev, editingRoute: rid, msg: null };
									});
									setDraft({ ak: "", sk: "" });
								},
								disabled: state.busy,
								style: {
									boxSizing: "border-box", padding: "4px 8px", fontSize: "12px", lineHeight: "16px",
									color: "var(--dsw-alias-label-primary)",
									background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
									border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))",
									borderRadius: "6px", cursor: state.busy ? "wait" : "pointer",
									maxWidth: "320px"
								},
								children: [
									jsx("option", { value: "", children: "请选择提供方…" }, "__none__")
								].concat(optionRoutes.map(function (p) {
									return jsx("option", {
										value: p.id,
										children: p.name && p.name !== p.id ? p.name + " (" + p.id + ")" : p.id
									}, p.id);
								}))
							}) : jsx("span", { style: { color: "var(--dsh-alias-label-tertiary)" }, children: "未发现方舟提供方，请先在 DSH 模型设置中配置" })
						]
					}),
					// 刷新频率是全局非密钥偏好，无论选没选路由都展示。
					jsx(SelectField, {
						label: "刷新频率",
						value: String(state.refreshMs),
						onChange: onRefreshChange,
						disabled: state.savingRefresh,
						hint: state.savingRefresh ? "保存中…" : "保存后所有已打开卡片立即生效",
						options: REFRESH_CHOICES.map(function (c) { return { value: c.ms, label: c.label }; })
					}),
					// 未选择路由时不显示密钥表单。
					editingRoute ? jsxs(react_jsx_runtime.Fragment, { children: [
						jsx("div", {
							style: { fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)" },
							children: currentConfigured
								? "该提供方已配置火山账号凭据，填入新值可覆盖 AK/SK；点「清除配置」可删除已保存的凭据。"
								: "填写该提供方的 AK/SK 并保存即可（首次保存自动建立配置）。"
						}),
						jsx("label", {
							style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
							children: [
								jsx("span", { children: "AccessKey ID" }, "ak-label"),
								jsx("input", {
									type: "text", name: "ark-access-key-id", autoComplete: "off", spellCheck: false,
									placeholder: currentConfigured ? "（已配置，留空不变）" : "输入 AccessKey ID",
									value: draft.ak,
									onChange: function (e) { setDraft({ ak: e.target.value, sk: draft.sk }); },
									style: inputStyle
								}, "ak-input")
							]
						}),
						jsx("label", {
							style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
							children: [
								jsx("span", { children: "Secret Access Key" }, "sk-label"),
								jsx("input", {
									type: "password", name: "ark-secret-access-key", autoComplete: "new-password", spellCheck: false,
									placeholder: currentConfigured ? "（已配置，留空不变）" : "输入 Secret Access Key",
									value: draft.sk,
									onChange: function (e) { setDraft({ ak: draft.ak, sk: e.target.value }); },
									style: inputStyle
								}, "sk-input")
							]
						}),
						jsxs("div", {
							style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "2px" },
							children: [
								jsx("button", {
									type: "button",
									onClick: onSave,
									disabled: state.saving,
									style: {
										padding: "5px 12px", fontSize: "12px", lineHeight: "16px", borderRadius: "6px", cursor: "pointer",
										border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.3))",
										background: "var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base))",
										color: "var(--dsw-alias-label-primary)"
									},
									children: state.saving ? "保存中…" : "保存"
								}),
								// 清除配置紧挨保存按钮：仅该路由已填密钥时出现。
								editingRoute && currentConfigured
									? jsx("button", {
										type: "button",
										onClick: onClearRoute,
										disabled: state.busy || state.saving,
										title: "删除该提供方已保存的 AK/SK（同火山账号绑定的其它路由一并停止查询额度）",
										style: {
											padding: "5px 12px", fontSize: "12px", lineHeight: "16px", borderRadius: "6px", cursor: "pointer",
											border: "1px solid var(--dsw-alias-state-error-primary, #e5484d)",
											background: "transparent",
											color: "var(--dsw-alias-state-error-primary, #e5484d)"
										},
										children: "清除配置"
									})
									: null,
								state.msg ? jsx("span", {
									style: {
										fontSize: "11px", lineHeight: "16px",
										color: state.msgError
											? "var(--dsw-alias-state-error-primary, #e5484d)"
											: "var(--dsw-alias-label-tertiary)"
									},
									children: state.msg
								}) : null
							]
						})
					]}) : null
				]
			});
		}
		//#endregion
		//#region plugin entry
		var NS = "arkQuota";
		var inject = ["slots"];
		function apply(ctx) {
			// ── 模型跟随：会话切换模型提供方时，面板自动切到关联账号 ──────
			// 只通过 cordis 服务协作（不 require 任何跨插件包，符合 bundle
			// 纯度约束）。依赖在旧版宿主上缺失时 inject 回调不执行，跟随
			// 静默关闭，不影响下面的 slots 注册与额度查询主路径。
			if (typeof ctx.inject === "function") {
				ctx.inject(["sessions", "modelDirectories"], function (scope) {
					var sessions = scope.sessions;
					var models = scope.modelDirectories;
					if (!sessions || !models || typeof models.directoryFor !== "function"
						|| !sessions.list || typeof sessions.list.subscribe !== "function") return;
					var unsubList = null;
					var unsubDir = null;
					var watched = null;
					var watchSession = function (sessionId) {
						if (watched === sessionId) return;
						watched = sessionId;
						if (unsubDir) { try { unsubDir(); } catch (_e) {} unsubDir = null; }
						if (!sessionId) {
							followSignal.set({ sessionId: null, provider: null });
							return;
						}
						var directory;
						try {
							// directoryFor 会懒建该会话的模型目录（与模型菜单同一
							// 路径）；子代理会话 / 会话已销毁时可能抛错，静默降级。
							directory = models.directoryFor(sessionId);
						} catch (_e) {
							followSignal.set({ sessionId: sessionId, provider: null });
							return;
						}
						if (!directory || !directory.store) {
							followSignal.set({ sessionId: sessionId, provider: null });
							return;
						}
						var sync = function () {
							var snap = null;
							try { snap = directory.store.getSnapshot(); } catch (_e) {}
							var provider = snap && snap.current && typeof snap.current.provider === "string"
								? snap.current.provider : null;
							followSignal.set({ sessionId: sessionId, provider: provider });
						};
						sync();
						try { unsubDir = directory.store.subscribe(sync); } catch (_e) { unsubDir = null; }
					};
					var teardown = function () {
						if (unsubList) { try { unsubList(); } catch (_e) {} unsubList = null; }
						if (unsubDir) { try { unsubDir(); } catch (_e) {} unsubDir = null; }
					};
					try {
						unsubList = sessions.list.subscribe(function () {
							var snap = null;
							try { snap = sessions.list.getSnapshot(); } catch (_e) {}
							watchSession(snap && snap.current ? snap.current : null);
						});
						var initial = null;
						try { initial = sessions.list.getSnapshot(); } catch (_e) {}
						watchSession(initial && initial.current ? initial.current : null);
					} catch (_e) {
						teardown();
						return;
					}
					// 随 fiber 卸载退订（宿主支持 scope.effect 时）。
					if (typeof scope.effect === "function") {
						try { scope.effect(function () { return teardown; }, "ark-quota: model-provider follow"); } catch (_e) {}
					}
				});
			}
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "ark-quota",
					order: 100,
					label: "方舟额度"
				}, ArkQuotaWidget);
			});
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "ark-quota",
					order: 200,
					label: "方舟额度"
				}, function (props) { return jsx(ArkQuotaSettingsCard, {}); });
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.NS = NS;
		return module.exports;
	}
});
