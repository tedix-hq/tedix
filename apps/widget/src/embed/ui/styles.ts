import { embeddedTediBaseStyles } from "./index";

/** Complete isolated chat, tool, approval, artifact, and responsive embed skin. */
export function embeddedTediStyles(
	accent: string,
	appearance: {
		accentDark?: string;
		position?: "bottom-left" | "bottom-right";
		horizontalOffset?: number;
		bottomOffset?: number;
		zIndex?: number;
	} = {},
): string {
	const safeAccent = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(accent)
		? accent
		: "#2557d6";
	const safeAccentDark = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(
		appearance.accentDark ?? "",
	)
		? appearance.accentDark
		: safeAccent;
	const horizontalOffset = Math.min(
		120,
		Math.max(8, appearance.horizontalOffset ?? 22),
	);
	const bottomOffset = Math.min(
		120,
		Math.max(8, appearance.bottomOffset ?? 22),
	);
	const zIndex = Math.min(
		2_147_483_647,
		Math.max(1, appearance.zIndex ?? 2_147_483_000),
	);
	const inlinePosition =
		appearance.position === "bottom-left"
			? `left: ${horizontalOffset}px; right: auto;`
			: `right: ${horizontalOffset}px; left: auto;`;
	return `
				${embeddedTediBaseStyles}
				:host { all: initial; --tedix-accent: ${safeAccent}; --tedix-accent-dark: ${safeAccentDark}; --tedix-bg: #fff; --tedix-canvas: #fafafa; --tedix-text: #18181b; --tedix-muted: #71717a; --tedix-border: rgba(24,24,27,.12); --tedix-soft: rgba(24,24,27,.055); --tedix-viewport-height: 100dvh; --tedix-viewport-top: 0px; --tedix-viewport-width: 100vw; font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; color: var(--tedix-text); color-scheme: light; }
				:host([aria-hidden="true"]), :host([inert]), :host([data-base-ui-inert]) { visibility: hidden; pointer-events: none; }
				* { box-sizing: border-box; }
				button, textarea { font: inherit; }
				button { color: inherit; }
				button:focus-visible, a:focus-visible { outline: 3px solid color-mix(in srgb, var(--tedix-accent) 28%, transparent); outline-offset: 2px; }
				svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
				.tedix-launcher { position: fixed; ${inlinePosition} bottom: ${bottomOffset}px; z-index: ${zIndex}; display: grid; place-items: center; width: 58px; height: 58px; border: 1px solid rgba(255,255,255,.22); border-radius: 50%; background: var(--tedix-accent); color: #fff; cursor: pointer; box-shadow: 0 14px 36px rgba(24,24,27,.24); transition: transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease; }
				.tedix-launcher:hover { transform: translateY(-2px); box-shadow: 0 18px 42px rgba(24,24,27,.28); }
				.tedix-launcher:focus-visible, .tedix-icon:focus-visible, .tedix-send:focus-visible { outline: 3px solid color-mix(in srgb, var(--tedix-accent) 28%, transparent); outline-offset: 2px; }
				.tedix-launcher[data-hidden] { opacity: 0; pointer-events: none; transform: scale(.88); }
				.tedix-launcher-mark { display: grid; width: 32px; height: 32px; place-items: center; border: 1px solid rgba(255,255,255,.42); border-radius: var(--tedix-radius-xl); background: rgba(255,255,255,.12); color: #fff; font-size: 18px; font-weight: 750; line-height: 1; letter-spacing: -.04em; }
				.tedix-launcher-mark:has(.tedix-brand-image) { border: 0; background: transparent; }
				.tedix-brand-image { width: 100%; height: 100%; object-fit: contain; }
				.tedix-brand-image[data-theme-dark] { display: none; }
				.tedix-panel { position: fixed; ${inlinePosition} bottom: ${bottomOffset}px; z-index: ${zIndex + 1}; display: none; flex-direction: column; width: min(480px, calc(var(--tedix-viewport-width) - 28px)); height: min(720px, calc(var(--tedix-viewport-height) - 44px)); overflow: hidden; border: 1px solid var(--tedix-border); border-radius: 26px; background: var(--tedix-bg); box-shadow: 0 28px 90px rgba(24,24,27,.25), 0 2px 8px rgba(24,24,27,.08); transform-origin: ${appearance.position === "bottom-left" ? "left" : "right"} bottom; }
				.tedix-panel[data-open] { display: flex; animation: tedix-enter 180ms ease-out; }
				.tedix-panel[data-expanded] { width: min(760px, calc(var(--tedix-viewport-width) - 44px)); height: calc(var(--tedix-viewport-height) - 44px); }
				@keyframes tedix-enter { from { opacity: 0; transform: translateY(12px) scale(.98); } }
				.tedix-header { display: flex; min-height: 66px; align-items: center; gap: 11px; padding: 10px 12px 10px 18px; border-bottom: 1px solid var(--tedix-border); background: color-mix(in srgb, var(--tedix-bg) 94%, transparent); }
				.tedix-avatar { position: relative; display: grid; flex: 0 0 auto; place-items: center; width: 36px; height: 36px; border-radius: var(--tedix-radius-xl); background: color-mix(in srgb, var(--tedix-accent) 12%, var(--tedix-bg)); color: var(--tedix-accent); font-weight: 750; letter-spacing: -.03em; }
				.tedix-presence { position: absolute; right: -2px; bottom: -2px; width: 10px; height: 10px; border: 2px solid var(--tedix-bg); border-radius: 50%; background: #22a06b; }
				.tedix-model-select,.tedix-effort-select,.tedix-tedi-select{font:inherit;color:inherit;background:var(--tedix-panel-bg,transparent);border:1px solid currentColor;border-radius:6px;max-width:100%;padding:3px 6px}.tedix-model-select,.tedix-effort-select{font-size:11px;padding:2px 4px;max-width:44%}.tedix-model-select[hidden],.tedix-effort-select[hidden],.tedix-tedi-select[hidden]{display:none}
.tedix-heading { min-width: 0; flex: 1; }
				.tedix-history-bar { display: none; min-width: 0; flex: 1; align-items: center; gap: 4px; }
				.tedix-history-bar strong { font-size: 16px; font-weight: 620; letter-spacing: -.01em; }
				.tedix-panel[data-history] .tedix-history-bar { display: flex; }
				.tedix-panel[data-history] .tedix-avatar, .tedix-panel[data-history] .tedix-heading, .tedix-panel[data-history] .tedix-actions { display: none; }
				.tedix-title { margin: 0; font-size: 15px; font-weight: 680; line-height: 1.2; letter-spacing: -.01em; }
				.tedix-subtitle { overflow: hidden; margin: 3px 0 0; color: var(--tedix-muted); font-size: 12px; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
				.tedix-actions { display: flex; gap: 2px; }
				.tedix-icon { display: grid; place-items: center; width: var(--tedix-control-md); height: var(--tedix-control-md); padding: 0; border: 0; border-radius: var(--tedix-radius-xl); background: transparent; color: var(--tedix-muted); cursor: pointer; }
				.tedix-icon:hover { background: var(--tedix-soft); color: var(--tedix-text); }
				.tedix-history[hidden], .tedix-thread[hidden], .tedix-composer-wrap[hidden] { display: none; }
				.tedix-history { min-height: 0; flex: 1; overflow-y: auto; padding: 18px 14px 22px; background: var(--tedix-bg); }
				.tedix-history-new, .tedix-history-item { width: 100%; min-height: 48px; border: 0; border-radius: 13px; background: transparent; cursor: pointer; text-align: left; }
				.tedix-history-new { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; padding: 11px 13px; color: var(--tedix-text); font-size: 14px; font-weight: 590; }
				.tedix-history-new svg { width: 17px; height: 17px; }
				.tedix-history-list { display: grid; gap: 2px; }
				.tedix-history-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 11px 13px; }
				.tedix-history-new:hover, .tedix-history-item:hover, .tedix-history-item[data-active="true"] { background: var(--tedix-soft); }
				.tedix-history-item span { overflow: hidden; font-size: 14px; font-weight: 450; text-overflow: ellipsis; white-space: nowrap; }
				.tedix-history-item time { color: var(--tedix-muted); font-size: 13px; white-space: nowrap; }
				.tedix-panel[data-history] .tedix-context, .tedix-panel[data-history] .tedix-footer { display: none; }
				.tedix-panel[data-history] .tedix-composer-wrap { padding-top: 8px; }
				.tedix-thread { position: relative; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 22px 12px; background: var(--tedix-canvas); scroll-behavior: smooth; }
				.tedix-empty { display: flex; min-height: 100%; flex-direction: column; align-items: center; justify-content: center; padding: 34px 14px 16px; text-align: center; }
				.tedix-empty-mark { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 18px; border: 1px solid var(--tedix-border); border-radius: var(--tedix-radius-2xl); background: var(--tedix-bg); color: var(--tedix-accent); box-shadow: 0 8px 24px rgba(24,24,27,.06); }
				.tedix-empty h2 { max-width: 330px; margin: 0; font-size: 18px; line-height: 1.35; letter-spacing: -.02em; }
				.tedix-empty p { max-width: 350px; margin: 9px 0 22px; color: var(--tedix-muted); font-size: 13px; line-height: 1.5; }
				.tedix-prompts { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; width: min(100%, 380px); margin: 0 0 22px; }
				.tedix-prompt { min-height: var(--tedix-control-md); padding: 7px 13px; border: 1px solid var(--tedix-border); border-radius: var(--tedix-radius-full); background: var(--tedix-bg); color: var(--tedix-text); cursor: pointer; font: inherit; font-size: 13px; line-height: 1.3; text-align: left; }
				.tedix-prompt:hover { border-color: color-mix(in srgb, var(--tedix-accent) 42%, var(--tedix-border)); background: color-mix(in srgb, var(--tedix-accent) 6%, var(--tedix-bg)); }
				.tedix-prompt:focus-visible { outline: 3px solid color-mix(in srgb, var(--tedix-accent) 28%, transparent); outline-offset: 2px; }
				.tedix-recent[hidden] { display: none; }
				.tedix-recent { width: min(100%, 380px); margin-top: auto; padding-top: 28px; text-align: left; }
				.tedix-recent h2 { max-width: none; margin: 0 12px 8px; color: var(--tedix-muted); font-size: 13px; font-weight: 520; letter-spacing: 0; }
				.tedix-recent-list { display: grid; gap: 2px; }
				.tedix-recent-item { display: grid; width: 100%; min-height: 42px; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 9px 12px; border: 0; border-radius: 12px; background: transparent; cursor: pointer; text-align: left; }
				.tedix-recent-item:hover { background: color-mix(in srgb, var(--tedix-accent) 6%, var(--tedix-bg)); }
				.tedix-recent-item span { overflow: hidden; font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
				.tedix-recent-item time { color: var(--tedix-muted); font-size: 12px; white-space: nowrap; }
				.tedix-recent-more { min-height: 38px; padding: 8px 12px; border: 0; background: transparent; color: var(--tedix-muted); cursor: pointer; font-size: 13px; text-align: left; }
				.tedix-recent-more:hover { color: var(--tedix-text); }
				.tedix-message { display: flex; width: 100%; margin: 0 0 20px; }
				.tedix-message-user { justify-content: flex-end; }
				.tedix-message-assistant { flex-direction: column; align-items: stretch; }
				.tedix-bubble { max-width: 86%; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; white-space: pre-wrap; }
				.tedix-message-user .tedix-bubble { padding: 10px 14px; border-radius: 18px 18px 5px 18px; background: var(--tedix-soft); }
				.tedix-message-assistant .tedix-bubble { max-width: 100%; padding: 1px 2px; white-space: normal; }
				.tedix-message-assistant p { margin: 0 0 12px; }
				.tedix-message-assistant ul, .tedix-message-assistant ol { margin: 0 0 12px; padding-left: 20px; }
				.tedix-message-assistant li { margin: 4px 0; }
				.tedix-message-assistant .tedix-task-item { display: flex; align-items: flex-start; gap: 8px; list-style: none; }
				.tedix-message-assistant .tedix-task-item input { width: 15px; height: 15px; margin: 3px 0 0; accent-color: var(--tedix-accent); }
				.tedix-message-assistant h1, .tedix-message-assistant h2, .tedix-message-assistant h3 { margin: 16px 0 7px; font-size: 15px; line-height: 1.35; }
				.tedix-message-assistant h1:first-child, .tedix-message-assistant h2:first-child, .tedix-message-assistant h3:first-child { margin-top: 0; }
				.tedix-message-assistant code { padding: 1px 5px; border-radius: 6px; background: var(--tedix-soft); font-size: .9em; }
				.tedix-message-assistant pre { max-width: 100%; margin: 0 0 12px; overflow-x: auto; border: 1px solid var(--tedix-border); border-radius: 12px; background: var(--tedix-bg); }
				.tedix-message-assistant pre code { display: block; min-width: max-content; padding: 12px; background: transparent; white-space: pre; }
				.tedix-md-code { max-width: 100%; margin: 0 0 12px; overflow: hidden; border: 1px solid var(--tedix-border); border-radius: 12px; background: var(--tedix-bg); }
				.tedix-md-code pre { margin: 0; border: 0; border-radius: 0; }
				.tedix-md-code-bar { display: flex; min-height: 30px; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--tedix-border); background: var(--tedix-soft); color: var(--tedix-muted); font-size: 11px; }
				.tedix-md-code-language { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: lowercase; }
				.tedix-md-copy { min-height: 24px; margin-left: auto; padding: 2px 8px; border: 1px solid var(--tedix-border); border-radius: 8px; background: var(--tedix-bg); color: var(--tedix-text); cursor: pointer; font: inherit; font-size: 11px; }
				.tedix-md-copy:hover { border-color: color-mix(in srgb, var(--tedix-accent) 42%, var(--tedix-border)); }
				.tedix-md-copy[data-copied="true"] { color: #14805e; }
				.tedix-md-link { color: var(--tedix-accent); text-decoration: underline; text-underline-offset: 2px; }
				.tedix-md-link[href^="/"] { display: inline-flex; align-items: center; min-height: 34px; margin: 5px 2px 2px 0; padding: 6px 11px; border: 1px solid var(--tedix-border); border-radius: 11px; background: var(--tedix-bg); font-weight: 620; text-decoration: none; }
				.tedix-md-link[href^="/"]:hover { border-color: color-mix(in srgb, var(--tedix-accent) 42%, var(--tedix-border)); background: color-mix(in srgb, var(--tedix-accent) 5%, var(--tedix-bg)); }
				.tedix-message-assistant em { font-style: italic; }
				.tedix-message-assistant li > ul, .tedix-message-assistant li > ol { margin: 4px 0 0; }
				.tedix-message-assistant blockquote { margin: 0 0 12px; padding-left: 12px; border-left: 3px solid var(--tedix-border); color: var(--tedix-muted); }
				.tedix-message-assistant hr { margin: 14px 0; border: 0; border-top: 1px solid var(--tedix-border); }
				.tedix-markdown-table { width: 100%; margin: 3px 0 14px; overflow-x: auto; border: 1px solid var(--tedix-border); border-radius: 12px; }
				.tedix-markdown-table:focus-visible { outline: 3px solid color-mix(in srgb, var(--tedix-accent) 28%, transparent); outline-offset: 2px; }
				.tedix-markdown-table table { width: 100%; border-collapse: collapse; font-size: 12px; white-space: nowrap; }
				.tedix-markdown-table th, .tedix-markdown-table td { padding: 8px 10px; border-bottom: 1px solid var(--tedix-border); text-align: left; }
				.tedix-markdown-table th { background: var(--tedix-soft); font-weight: 650; }
				.tedix-markdown-table tbody tr:last-child td { border-bottom: 0; }
				.tedix-route-link { display: inline-flex; align-items: center; min-height: 34px; margin: 5px 2px 2px 0; padding: 6px 11px; border: 1px solid var(--tedix-border); border-radius: 11px; background: var(--tedix-bg); color: var(--tedix-accent); font-weight: 620; text-decoration: none; }
				.tedix-route-link:hover { border-color: color-mix(in srgb, var(--tedix-accent) 42%, var(--tedix-border)); background: color-mix(in srgb, var(--tedix-accent) 5%, var(--tedix-bg)); }
				.tedix-route-link:focus-visible { outline: 3px solid color-mix(in srgb, var(--tedix-accent) 28%, transparent); outline-offset: 2px; }
				.tedix-skeleton { position: relative; overflow: hidden; border-radius: 10px; background: var(--tedix-soft); }
				.tedix-skeleton::after { position: absolute; inset: 0; background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--tedix-text) 9%, transparent) 48%, transparent 76%); background-size: 220% 100%; animation: tedix-skeleton-shimmer 1.45s linear infinite; content: ""; }
				.tedix-skeleton-line { height: 12px; margin: 6px 0; }
				.tedix-skeleton-row { height: 38px; margin: 0 0 6px; border-radius: 12px; }
				.tedix-skeleton-bubble { max-width: 78%; height: 46px; margin: 0 0 14px; border-radius: var(--tedix-radius-2xl); }
				.tedix-skeleton-bubble[data-role="user"] { margin-left: auto; width: 52%; height: 34px; }
				@keyframes tedix-skeleton-shimmer { to { background-position: -220% 0; } }
				.tedix-thinking { display: inline-flex; min-height: 24px; align-items: center; color: var(--tedix-muted); font-size: 13px; font-weight: 590; }
				.tedix-thinking-label { background: linear-gradient(100deg, var(--tedix-muted) 20%, var(--tedix-text) 48%, var(--tedix-muted) 76%); background-size: 220% 100%; color: transparent; background-clip: text; -webkit-background-clip: text; animation: tedix-thinking-shimmer 1.45s linear infinite; }
				@keyframes tedix-thinking-shimmer { to { background-position: -220% 0; } }
				.tedix-activities { display: grid; gap: 6px; margin: 0 0 12px; }
				.tedix-activities:empty { display: none; }
				.tedix-worklog { margin: 0 0 12px; }
				.tedix-worklog summary { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; list-style: none; color: var(--tedix-muted); font-size: 12px; }
				.tedix-worklog summary::-webkit-details-marker { display: none; }
				.tedix-worklog-chevron { display: inline-flex; opacity: .7; transition: transform 140ms ease; }
				.tedix-worklog-chevron svg { width: 13px; height: 13px; }
				.tedix-worklog[open] .tedix-worklog-chevron { transform: rotate(180deg); }
				.tedix-worklog-thinking { max-height: 88px; margin: 6px 0 0; padding: 0 0 0 13px; overflow: hidden; border-left: 1px solid var(--tedix-border); color: var(--tedix-muted); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; mask-image: linear-gradient(to bottom, transparent, #000 22px); -webkit-mask-image: linear-gradient(to bottom, transparent, #000 22px); }
				.tedix-worklog-steps { margin: 4px 0 0; padding: 0 0 0 13px; color: var(--tedix-muted); font-size: 12px; line-height: 1.5; list-style: none; border-left: 1px solid var(--tedix-border); }
				.tedix-worklog-step { padding: 1px 0; }
				.tedix-worklog-step[data-status="error"] { color: #dc2626; }
				/* Tool arguments are streaming. The row shimmers; the text never
				   changes, because that text is raw JSON we will not print. */
				.tedix-worklog-step[data-streaming="true"] { background: linear-gradient(100deg, var(--tedix-muted) 20%, var(--tedix-text) 48%, var(--tedix-muted) 76%); background-size: 220% 100%; color: transparent; background-clip: text; -webkit-background-clip: text; animation: tedix-thinking-shimmer 1.45s linear infinite; }
				.tedix-approval { margin: -7px 0 20px; padding: 14px; border: 1px solid color-mix(in srgb, #d97706 38%, var(--tedix-border)); border-radius: var(--tedix-radius-2xl); background: color-mix(in srgb, #f59e0b 7%, var(--tedix-bg)); }
				.tedix-approval strong { display: block; font-size: 13px; }
				.tedix-approval p { margin: 7px 0 12px; color: var(--tedix-muted); font-size: 12px; line-height: 1.45; }
				.tedix-approval div { display: flex; justify-content: flex-end; gap: 8px; }
				.tedix-approval button { min-height: 34px; padding: 6px 11px; border: 1px solid var(--tedix-border); border-radius: 10px; background: var(--tedix-bg); cursor: pointer; font-size: 12px; font-weight: 620; }
				.tedix-approval button[data-decision="approve"] { border-color: var(--tedix-accent); background: var(--tedix-accent); color: #fff; }
				.tedix-approval button:disabled { cursor: default; opacity: .55; }
				.tedix-approval > span { display: block; margin-top: 8px; color: var(--tedix-muted); font-size: 11px; text-align: right; }
				.tedix-approval[data-resolved] div { display: none; }
				.tedix-widget-frame { width: 100%; min-height: 180px; margin: -7px 0 20px; overflow: hidden; border: 1px solid var(--tedix-border); border-radius: 18px; background: var(--tedix-bg); }
				.tedix-widget-frame iframe { display: block; width: 100%; min-height: 260px; border: 0; }
				.tedix-composer-wrap { padding: 10px 12px 13px; border-top: 1px solid var(--tedix-border); background: var(--tedix-bg); }
				.tedix-context { display: flex; align-items: center; gap: 6px; min-height: 20px; padding: 0 8px 7px; color: var(--tedix-muted); font-size: 11px; }
				.tedix-context .tedix-status { margin-left: auto; }
				.tedix-context strong { min-width: 0; overflow: hidden; max-width: 220px; color: var(--tedix-text); font-weight: 590; text-overflow: ellipsis; white-space: nowrap; }
				.tedix-session-recovery { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 8px 8px; padding: 9px 10px; border: 1px solid var(--tedix-border); border-radius: 12px; background: var(--tedix-canvas); color: var(--tedix-muted); font-size: 11px; line-height: 1.35; }
				.tedix-session-recovery[hidden] { display: none; }
				.tedix-session-retry { flex: 0 0 auto; min-height: 34px; padding: 6px 10px; border: 1px solid var(--tedix-border); border-radius: 9px; background: var(--tedix-bg); color: var(--tedix-text); cursor: pointer; font-size: 11px; font-weight: 650; }
				.tedix-session-retry:disabled { cursor: wait; opacity: .6; }
				.tedix-form { display: flex; min-height: 54px; align-items: flex-end; gap: 5px; padding: 6px 7px 6px 8px; border: 1px solid var(--tedix-border); border-radius: 20px; background: var(--tedix-canvas); transition: border-color 140ms ease, box-shadow 140ms ease; }
				.tedix-form:focus-within { border-color: color-mix(in srgb, var(--tedix-accent) 48%, var(--tedix-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tedix-accent) 10%, transparent); }
				.tedix-form .tedix-icon { width: var(--tedix-control-md); height: var(--tedix-control-md); flex: 0 0 auto; }
				.tedix-input { min-width: 0; min-height: 40px; max-height: 130px; flex: 1; resize: none; overflow-y: auto; padding: 9px 4px 7px; border: 0; outline: 0; background: transparent; color: var(--tedix-text); font-size: 14px; line-height: 1.45; }
				.tedix-input::placeholder { color: var(--tedix-muted); }
				.tedix-voice, .tedix-voice-cancel { display: grid; width: var(--tedix-control-md); height: var(--tedix-control-md); flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--tedix-text); cursor: pointer; }
				.tedix-voice:hover, .tedix-voice-cancel:hover { background: var(--tedix-soft); }
				.tedix-form[data-voice-state="recording"] .tedix-voice svg { fill: currentColor; stroke: none; }
				.tedix-voice[hidden], .tedix-voice-cancel[hidden], .tedix-voice-status[hidden], .tedix-input[hidden] { display: none; }
				.tedix-voice-status { display: flex; min-width: 0; min-height: 40px; flex: 1; align-items: center; justify-content: center; color: var(--tedix-muted); }
				.tedix-voice-wave { display: flex; width: min(100%, 420px); height: 34px; align-items: center; justify-content: center; gap: 2px; }
				.tedix-voice-wave i { width: 3px; height: 4px; flex: 0 1 3px; border-radius: 999px; background: currentColor; opacity: .78; transition: height 160ms cubic-bezier(.22, 1, .36, 1), opacity 160ms ease-out; }
				.tedix-form:is([data-voice-state="connecting"], [data-voice-state="transcribing"]) .tedix-voice-wave { width: 18px; height: 18px; border: 2px solid var(--tedix-border); border-top-color: var(--tedix-text); border-radius: 50%; animation: tedix-spin 800ms linear infinite; }
				.tedix-form:is([data-voice-state="connecting"], [data-voice-state="transcribing"]) .tedix-voice-wave i { display: none; }
				.tedix-voice-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 8px 0; color: #dc2626; font-size: 11px; line-height: 1.35; }
				.tedix-voice-error[hidden] { display: none; }
				.tedix-voice-error button { flex: 0 0 auto; padding: 4px 8px; border: 1px solid var(--tedix-border); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; font: inherit; font-weight: 620; }
				@keyframes tedix-spin { to { transform: rotate(360deg); } }
				.tedix-send { display: grid; width: var(--tedix-control-md); height: var(--tedix-control-md); flex: 0 0 auto; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--tedix-text); color: var(--tedix-bg); cursor: pointer; transition: transform 120ms ease, opacity 120ms ease; }
				.tedix-send:hover { transform: scale(1.04); }
				.tedix-send:disabled { cursor: default; opacity: .28; transform: none; }
				.tedix-send[aria-label="Detener"] svg { fill: currentColor; stroke: none; }
				.tedix-footer { padding: 7px 4px 0; color: var(--tedix-muted); font-size: 10px; text-align: center; }
				@media (prefers-color-scheme: dark) { :host:not([data-theme="light"]) { --tedix-accent: var(--tedix-accent-dark); --tedix-bg: #242424; --tedix-canvas: #202020; --tedix-text: #f4f4f5; --tedix-muted: #a1a1aa; --tedix-border: rgba(255,255,255,.11); --tedix-soft: rgba(255,255,255,.075); color-scheme: dark; } :host:not([data-theme="light"]) .tedix-brand-image:not([data-theme-dark]) { display: none; } :host:not([data-theme="light"]) .tedix-brand-image[data-theme-dark] { display: block; } }
				:host([data-theme="dark"]) { --tedix-accent: var(--tedix-accent-dark); --tedix-bg: #242424; --tedix-canvas: #202020; --tedix-text: #f4f4f5; --tedix-muted: #a1a1aa; --tedix-border: rgba(255,255,255,.11); --tedix-soft: rgba(255,255,255,.075); color-scheme: dark; }
				:host([data-theme="dark"]) .tedix-brand-image:not([data-theme-dark]) { display: none; }
				:host([data-theme="dark"]) .tedix-brand-image[data-theme-dark] { display: block; }
				:host([data-theme="light"]) { --tedix-bg: #fff; --tedix-canvas: #fafafa; --tedix-text: #18181b; --tedix-muted: #71717a; --tedix-border: rgba(24,24,27,.12); --tedix-soft: rgba(24,24,27,.055); color-scheme: light; }
				@media (max-width: 600px) { .tedix-launcher { bottom: 14px; ${appearance.position === "bottom-left" ? "left: 14px; right: auto;" : "right: 14px; left: auto;"} } .tedix-panel, .tedix-panel[data-expanded] { top: var(--tedix-viewport-top); right: auto; bottom: auto; left: 0; width: var(--tedix-viewport-width); height: var(--tedix-viewport-height); border: 0; border-radius: 0; } :host([data-keyboard-open]) .tedix-composer-wrap { padding-bottom: 0; } :host([data-keyboard-open]) .tedix-footer { display: none; } .tedix-expand { display: none; } .tedix-thread { padding-inline: 16px; } .tedix-header { padding-left: 14px; } }
				@media (pointer: coarse) { .tedix-input { font-size: 16px; } }
				@media (prefers-reduced-motion: reduce) { .tedix-panel[data-open] { animation: none; } .tedix-launcher, .tedix-send, .tedix-activity-chevron { transition: none; } .tedix-thinking-label, .tedix-skeleton::after { animation: none; } .tedix-worklog-step[data-streaming="true"] { background: none; color: inherit; animation: none; } }
	`;
}
