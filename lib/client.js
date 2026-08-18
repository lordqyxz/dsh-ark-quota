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
		var Fragment = react_jsx_runtime.Fragment;
		//#region widget
		var DEFAULT_POLL_MS = 5 * 60 * 1000;
		// "session" is actually a 5-hour sliding window (AFPFiveHour / coding session),
		// "weekly"/"monthly" are rolling 7/30-day windows — use precise near-window labels.
		var LEVEL_LABELS = { session: "5小时", weekly: "近1周", monthly: "近1月" };
		var LEVEL_ORDER = ["session", "weekly", "monthly"];

		// UI preference: which percentage the big number shows.
		// "remaining" (default) shows budget left; "used" shows consumption.
		// The progress bar always fills by used % regardless of this choice.
		var DISPLAY_KEY = "dsh-ark-quota:displayMode";
		var displayMode = "remaining";
		try {
			var dms = typeof window !== "undefined" && window.localStorage
				? window.localStorage.getItem(DISPLAY_KEY)
				: null;
			if (dms === "remaining" || dms === "used") displayMode = dms;
		} catch (_e) { /* localStorage may be unavailable; keep default */ }

		function setDisplayMode(next) {
			displayMode = next;
			try { window.localStorage.setItem(DISPLAY_KEY, next); } catch (_e) { /* ignore */ }
			try { window.dispatchEvent(new StorageEvent("storage", { key: DISPLAY_KEY, newValue: next })); } catch (_e) { /* old browser */ }
		}

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

		function colorOf(percent) {
			if (percent >= 90) return "#e5484d";
			if (percent >= 70) return "#f5a524";
			return "#46a758";
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

		function fmtClock(ts) {
			if (!ts) return "";
			var d = new Date(ts * 1000);
			return pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
		}

		// "x 分钟前更新" / "刚刚更新". Driven by useNow so it ticks every minute
		// without a network refetch.
		function fmtRelative(ts, now) {
			if (!ts) return "";
			var diff = Math.max(0, now - ts * 1000);
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
			var cachedAt = (typeof json.cachedAt === "number" && json.cachedAt > 0) ? json.cachedAt : Date.now();
			var nextAt = cachedAt + refreshMs + POLL_BUFFER_MS;
			var delay = Math.max(500, nextAt - Date.now());
			timerRef.current = window.setTimeout(function () { load(false); }, delay);
		}

		function useQuota() {
			var state = React.useState({ loading: true, data: null, error: null });
			var data = state[0], setState = state[1];
			var timerRef = React.useRef(null);
			var load = React.useCallback(function (force) {
				setState(function (prev) { return { loading: true, data: prev.data, error: null }; });
				fetch("/ark-quota" + (force ? "?force=1" : ""), { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setState({ loading: false, data: json, error: null });
							scheduleNext(timerRef, json, load);
						} else {
							setState({ loading: false, data: null, error: (json && json.message) || "查询失败" });
							// On a non-auth error (e.g. transient 502), retry after the
							// default cadence rather than hammering the endpoint.
							if (timerRef.current) window.clearTimeout(timerRef.current);
							timerRef.current = window.setTimeout(function () { load(false); }, DEFAULT_POLL_MS);
						}
					})
					.catch(function (e) {
						setState({ loading: false, data: null, error: String((e && e.message) || e) });
						if (timerRef.current) window.clearTimeout(timerRef.current);
						timerRef.current = window.setTimeout(function () { load(false); }, DEFAULT_POLL_MS);
					});
			}, []);
			React.useEffect(function () {
				load(false);
				return function () { if (timerRef.current) window.clearTimeout(timerRef.current); };
			}, [load]);
			return { data: data.data, loading: data.loading, error: data.error, load: load };
		}

		function rowTooltip(item, now) {
			var parts = ["已用 " + item.percentUsed.toFixed(1) + "% · 剩余 " + item.percentRemaining.toFixed(1) + "%"];
			if (typeof item.used === "number" && typeof item.total === "number" && item.total > 0) {
				parts.push(fmtCount(item.used) + " / " + fmtCount(item.total));
			}
			if (item.resetAt) {
				// Card shows the precise countdown; tooltip adds the absolute
				// wall-clock time so the user can see exactly when it resets.
				parts.push(fmtResetAt(item.resetAt, now));
			}
			return parts.join("\n");
		}

		function QuotaRow(_a) {
			var item = _a.item, now = _a.now, displayMode = _a.displayMode;
			var usedPct = item.percentUsed;
			var remPct = item.percentRemaining;
			var showPct = displayMode === "used" ? usedPct : remPct;
			var label = Object.prototype.hasOwnProperty.call(LEVEL_LABELS, item.level) ? LEVEL_LABELS[item.level] : item.level;
			var reset = fmtReset(item.resetAt, now);
			// Single tooltip on the whole row: hovering the label, bar, percentage,
			// or reset sub-line all shows the same detail (used/remaining %,
			// absolute counts if available, exact wall-clock reset time).
			var tip = rowTooltip(item, now);
			return jsxs("div", {
				title: tip,
				style: { display: "flex", flexDirection: "column", gap: "2px", minWidth: 0, cursor: "default" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "4px", minWidth: 0 },
						children: [
							jsx("span", {
								style: { flex: "none", width: "34px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
								children: label
							}),
							jsx("div", {
								style: { flex: "1 1 0", minWidth: "24px", height: "6px", borderRadius: "3px", background: "var(--dsw-alias-track-bg, rgba(128,128,128,0.25))", overflow: "hidden" },
								children: jsx("div", {
									style: { height: "100%", width: usedPct + "%", borderRadius: "3px", background: colorOf(usedPct), transition: "width .3s" }
								})
							}),
							jsx("span", {
								style: { flex: "none", minWidth: "28px", textAlign: "right", fontSize: "11px", lineHeight: "16px", fontVariantNumeric: "tabular-nums", color: "var(--dsw-alias-label-primary)" },
								children: Math.round(showPct) + "%"
							})
						]
					}),
					reset ? jsx("div", {
						style: { paddingLeft: "40px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums" },
						children: reset
					}) : null
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
			var onClick = _a.onClick, title = _a.title;
			return jsx("button", {
				type: "button",
				title: title,
				onClick: onClick,
				style: {
					flex: "none", width: "18px", height: "18px", display: "inline-flex",
					alignItems: "center", justifyContent: "center", padding: "0",
					border: "none", borderRadius: "4px", cursor: "pointer",
					background: "transparent", color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "1"
				},
				children: "⟳"
			});
		}

		// Human-readable cadence label (e.g. "每 1 分钟自动刷新" / "每 30 分钟自动刷新").
		function refreshCadence(refreshMs) {
			var ms = (typeof refreshMs === "number" && refreshMs > 0) ? refreshMs : DEFAULT_POLL_MS;
			if (ms < 60000) return "每 " + Math.round(ms / 1000) + " 秒自动刷新";
			var mins = Math.round(ms / 60000);
			if (mins >= 60 && mins % 60 === 0) return "每 " + (mins / 60) + " 小时自动刷新";
			return "每 " + mins + " 分钟自动刷新";
		}

		function Card(_a) {
			var state = _a.state, onRefresh = _a.onRefresh, loading = _a.loading;
			var now = useNow();
			var data = state.data;
			// Read the module-scope display preference and re-render when the
			// settings card flips it (storage event) — keeps the card header clean.
			var dmState = React.useState(displayMode);
			var dm = dmState[0], setDm = dmState[1];
			React.useEffect(function () {
				var onStorage = function (e) {
					if (e && e.key === DISPLAY_KEY) {
						var v = e.newValue === "used" ? "used" : "remaining";
						displayMode = v;
						setDm(v);
					}
				};
				window.addEventListener("storage", onStorage);
				return function () { window.removeEventListener("storage", onStorage); };
			}, [setDm]);
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
								jsx(RefreshButton, { onClick: onRefresh, title: "立即重试" })
							]
						}),
						jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", wordBreak: "break-all", minWidth: 0 }, children: state.error }),
						jsx("div", { style: { color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))" }, children: "请在 设置 → 方舟额度 中检查访问密钥 AK/SK" })
					]
				});
			}
			var quota = data ? data.quota : [];
			var rows = LEVEL_ORDER
				.map(function (level) { return quota.find(function (q) { return q.level === level; }); })
				.filter(Boolean);
			return jsxs("div", {
				style: cardOuter,
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", minWidth: 0, marginBottom: "2px" },
						children: [
							jsx(ArkLogo, { size: 15 }),
							jsx("span", {
								style: { flex: "none", fontSize: "12px", fontWeight: "500", lineHeight: "18px", color: "var(--dsw-alias-label-primary)" },
								children: "方舟额度"
							}),
							data && data.plan ? jsx(PlanBadge, { plan: data.plan }) : null,
							jsx("span", { style: { flex: "1", minWidth: 0 } }),
							loading ? jsx("span", {
								style: { flex: "none", fontSize: "10px", color: "var(--dsw-alias-label-tertiary)" },
								children: "刷新中…"
							}) : null,
							jsx(RefreshButton, { onClick: onRefresh, title: "立即刷新" })
						]
					}),
					jsx("div", {
						style: { display: "flex", flexDirection: "column", gap: "5px", minWidth: 0 },
						children: rows.length > 0 ? rows.map(function (item) {
							return jsx(QuotaRow, { item: item, now: now, displayMode: dm }, item.level);
						}) : jsx("div", {
							style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary)" },
							children: "暂无额度数据"
						})
					}),
					data && data.updatedAt ? jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "10px", lineHeight: "14px", color: "var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))", marginTop: "2px" },
						children: [
							jsxs("span", { title: "上次更新：" + fmtClock(data.updatedAt), children: [
								fmtRelative(data.updatedAt, now),
								" · ",
								refreshCadence(data.refreshMs)
							] }),
							data.hasReward ? jsxs("span", {
								title: "该套餐含额外奖励额度",
								style: { display: "inline-flex", alignItems: "center", gap: "3px", color: "var(--dsw-alias-state-info-primary, #0ea5e9)" },
								children: [
									jsx("span", { style: { width: "6px", height: "6px", borderRadius: "50%", background: "#0ea5e9" } }),
									"含奖励额度"
								]
							}) : null
						]
					}) : null
				]
			});
		}

		function RailPill(_a) {
			var state = _a.state, dm = _a.displayMode;
			var quota = state.data ? state.data.quota : [];
			var monthly = quota.find(function (q) { return q.level === "monthly"; });
			var showUsed = dm === "used";
			var pct = monthly ? (showUsed ? monthly.percentUsed : monthly.percentRemaining) : null;
			var label = showUsed ? "近1月已用 " : "近1月剩余 ";
			return jsx("button", {
				type: "button",
				title: pct === null ? "方舟额度（无数据）" : "方舟额度 · " + label + Math.round(pct) + "%" + (state.error ? " · " + state.error : ""),
				onClick: function () {},
				style: {
					flex: "none", minWidth: "30px", height: "22px", padding: "0 7px",
					display: "inline-flex", alignItems: "center", justifyContent: "center",
					borderRadius: "999px", cursor: "default",
					border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
					background: monthly ? colorOf(monthly.percentUsed) + "1a" : "var(--dsw-alias-bg-base, transparent)",
					color: "var(--dsw-alias-label-primary)", fontSize: "11px", fontVariantNumeric: "tabular-nums"
				},
				children: pct === null ? (state.error ? "!" : "—") : Math.round(pct) + "%"
			});
		}

		function ArkQuotaWidget(_a) {
			var wide = _a.wide;
			var q = useQuota();
			var dmState = React.useState(displayMode);
			var dm = dmState[0], setDm = dmState[1];
			React.useEffect(function () {
				var onStorage = function (e) {
					if (e && e.key === DISPLAY_KEY) {
						var v = e.newValue === "used" ? "used" : "remaining";
						displayMode = v;
						setDm(v);
					}
				};
				window.addEventListener("storage", onStorage);
				return function () { window.removeEventListener("storage", onStorage); };
			}, [setDm]);
			React.useEffect(function () {
				// Re-read immediately after a credentials/settings save (see refreshSignal).
				return refreshSignal.subscribe(function () { q.load(true); });
			}, [q]);
			if (!wide) return jsx(RailPill, { state: { data: q.data, error: q.error }, displayMode: dm });
			return jsx(Card, { state: { data: q.data, error: q.error }, loading: q.loading, onRefresh: function () { q.load(true); } });
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

		function ArkQuotaSettingsCard() {
			var d = React.useState({ ak: "", sk: "" });
			var draft = d[0], setDraft = d[1];
			var s = React.useState({ loading: true, configured: false, saving: false, msg: null, refreshMs: DEFAULT_POLL_MS, savingRefresh: false });
			var state = s[0], setState = s[1];
			// Display mode is a client-side preference (localStorage), not a host setting.
			var dmState = React.useState(displayMode);
			var dm = dmState[0], setDm = dmState[1];
			var loadStatus = React.useCallback(function () {
				fetch("/ark-quota/status", { cache: "no-store" })
					.then(function (r) { return r.json(); })
					.then(function (json) {
						setState(function (prev) {
							return {
								...prev, loading: false,
								configured: !!(json && json.ok === true && json.configured),
								refreshMs: (json && typeof json.refreshMs === "number" && json.refreshMs > 0) ? json.refreshMs : DEFAULT_POLL_MS
							};
						});
					})
					.catch(function () {
						setState(function (prev) { return { ...prev, loading: false }; });
					});
			}, []);
			React.useEffect(function () { loadStatus(); }, [loadStatus]);
			React.useEffect(function () {
				var onStorage = function (e) {
					if (e && e.key === DISPLAY_KEY) setDm(e.newValue === "used" ? "used" : "remaining");
				};
				window.addEventListener("storage", onStorage);
				return function () { window.removeEventListener("storage", onStorage); };
			}, []);
			var onDisplayChange = function (e) {
				var v = e.target.value === "used" ? "used" : "remaining";
				setDisplayMode(v);
				setDm(v);
			};
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
							setState(function (prev) { return { ...prev, savingRefresh: false, refreshMs: ms, configured: !!json.configured }; });
							refreshSignal.notify(); // cards re-read immediately and re-arm their poll timer
						} else {
							setState(function (prev) { return { ...prev, savingRefresh: false, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (err) {
						setState(function (prev) { return { ...prev, savingRefresh: false, msg: "保存失败：" + String((err && err.message) || err) }; });
					});
			};
			var onSave = function () {
				if (!draft.ak && !draft.sk) {
					setState(function (prev) { return { ...prev, msg: "未填写任何值" }; });
					return;
				}
				setState(function (prev) { return { ...prev, saving: true, msg: null }; });
				fetch("/ark-quota/credentials", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						accessKeyId: draft.ak || undefined,
						secretAccessKey: draft.sk || undefined
					})
				})
					.then(function (r) { return r.json(); })
					.then(function (json) {
						if (json && json.ok === true) {
							setDraft({ ak: "", sk: "" });
							setState({ loading: false, saving: false, configured: !!json.configured, msg: "已保存并热生效（无需重启）" });
							refreshSignal.notify();
						} else {
							setState(function (prev) { return { ...prev, saving: false, msg: (json && json.message) || "保存失败" }; });
						}
					})
					.catch(function (e) {
						setState(function (prev) { return { ...prev, saving: false, msg: "保存失败：" + String((e && e.message) || e) }; });
					});
			};
			var inputStyle = {
				boxSizing: "border-box", width: "100%", padding: "6px 8px", fontSize: "12px", lineHeight: "16px",
				color: "var(--dsw-alias-label-primary)", background: "var(--dsw-alias-bg-input, var(--dsw-alias-bg-base))",
				border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.25))", borderRadius: "6px"
			};
			var configured = state.configured;
			return jsxs("div", {
				style: { display: "flex", flexDirection: "column", gap: "8px", maxWidth: "520px" },
				children: [
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: "8px" },
						children: [
							jsx(ArkLogo, { size: 16 }),
							jsx("span", { style: { fontWeight: "500", fontSize: "13px", lineHeight: "20px", color: "var(--dsw-alias-label-primary)" }, children: "方舟额度 · 访问密钥" }),
							jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: configured ? "var(--dsw-alias-state-success-primary, #46a758)" : "var(--dsw-alias-label-tertiary)" }, children: configured ? "已配置" : "未配置" })
						]
					}),
					jsx("div", {
						style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" },
						children: "在火山控制台 → 访问控制 → API 访问密钥 创建。密钥仅存于本地 settings.yaml，保存后立即生效（无需重启 DSH）。留空则不修改对应项。"
					}),
					jsx("div", {
						style: { height: "1px", background: "var(--dsw-alias-border-l2, rgba(128,128,128,0.15))", margin: "2px 0" }
					}),
					jsx(SelectField, {
						label: "显示方式",
						value: dm,
						onChange: onDisplayChange,
						hint: "进度条始终按已用比例填充",
						options: [
							{ value: "remaining", label: "剩余百分比（如 45%）" },
							{ value: "used", label: "已用百分比（如 55%）" }
						]
					}),
					jsx(SelectField, {
						label: "刷新频率",
						value: String(state.refreshMs),
						onChange: onRefreshChange,
						disabled: state.savingRefresh,
						hint: state.savingRefresh ? "保存中…" : "保存后所有已打开卡片立即生效",
						options: REFRESH_CHOICES.map(function (c) { return { value: c.ms, label: c.label }; })
					}),
					jsx("label", {
						style: { display: "flex", flexDirection: "column", gap: "4px", fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-secondary)" },
						children: [
							jsx("span", { children: "AccessKey ID" }, "ak-label"),
							jsx("input", {
								type: "text", autoComplete: "off", spellCheck: false,
								placeholder: configured ? "（已配置，留空不变）" : "输入 AccessKey ID",
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
								type: "password", autoComplete: "off", spellCheck: false,
								placeholder: configured ? "（已配置，留空不变）" : "输入 Secret Access Key",
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
								children: state.saving ? "保存中…" : "保存访问密钥"
							}),
							state.msg ? jsx("span", { style: { fontSize: "11px", lineHeight: "16px", color: "var(--dsw-alias-label-tertiary)" }, children: state.msg }) : null
						]
					})
				]
			});
		}
		//#endregion
		//#region plugin entry
		var NS = "arkQuota";
		var inject = ["slots"];
		function apply(ctx) {
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
