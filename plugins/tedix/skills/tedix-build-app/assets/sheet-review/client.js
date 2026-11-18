// Tedix UI kit: paste this block unchanged at the top of an app's client.js.
// Plain DOM, no imports. It styles only with the host's --tedix-* variables,
// so apps match Tedix OS in light and dark mode. Every visible word comes from
// the caller; the kit adds none. Text is set with textContent, never HTML.
const ui = (() => {
	const style = document.createElement("style");
	style.id = "tedix-ui";
	style.textContent = `
:root{--tx-bg:var(--tedix-bg,Canvas);--tx-surface:var(--tedix-surface,Canvas);--tx-fg:var(--tedix-fg,CanvasText);--tx-muted:var(--tedix-muted-fg,GrayText);--tx-quiet:var(--tedix-muted,transparent);--tx-line:var(--tedix-border,GrayText);--tx-accent:var(--tedix-primary,AccentColor);--tx-on-accent:var(--tedix-on-primary,AccentColorText);--tx-danger:var(--tedix-danger,CanvasText);--tx-warning:var(--tedix-warning,CanvasText);--tx-success:var(--tedix-success,CanvasText);--tx-radius:var(--tedix-radius,12px);background:var(--tx-bg);color:var(--tx-fg);font:16px/1.5 var(--tedix-font,system-ui,sans-serif)}
body{background:var(--tx-bg);color:var(--tx-fg)}
.tx-button{min-height:44px;min-width:44px;padding:10px 16px;border:1px solid var(--tx-line);border-radius:var(--tx-radius);background:var(--tx-surface);color:var(--tx-fg);font:inherit;cursor:pointer;white-space:normal}
.tx-button.tx-primary,.tx-tabs [aria-selected=true]{background:var(--tx-accent);color:var(--tx-on-accent);border-color:var(--tx-accent)}
.tx-button.tx-quiet{background:transparent;border-color:transparent}
.tx-button:disabled{opacity:.6;cursor:default}
:is(.tx-button,.tx-select select):focus-visible{outline:3px solid var(--tx-accent);outline-offset:3px}
.tx-tabs,.tx-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tx-muted{color:var(--tx-muted)}
.tx-alert{color:var(--tx-danger);border:1px solid var(--tx-danger);border-radius:var(--tx-radius);padding:10px 14px}
.tx-confirm{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px;border:1px solid var(--tx-line);border-radius:var(--tx-radius);background:var(--tx-quiet)}
.tx-confirm p{margin:0;flex-basis:100%}
.tx-select{display:inline-flex;flex-direction:column;gap:4px;font-size:.9rem;color:var(--tx-muted)}
.tx-select select{min-height:44px;padding:8px 10px;border:1px solid var(--tx-line);border-radius:var(--tx-radius);background:var(--tx-surface);color:var(--tx-fg);font:inherit}
.tx-table{overflow-x:auto;border:1px solid var(--tx-line);border-radius:var(--tx-radius)}
.tx-table table{border-collapse:collapse;width:100%}
.tx-table caption{text-align:start;padding:10px 12px;font-weight:600}
.tx-table :is(th,td){padding:10px 12px;border-top:1px solid var(--tx-line);text-align:start;vertical-align:top;overflow-wrap:anywhere}
.tx-table th{background:var(--tx-quiet);font-weight:600}
.tx-table .tx-end{text-align:end}
.tx-pager{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;color:var(--tx-muted)}
.tx-button[aria-pressed=true]{background:var(--tx-accent);color:var(--tx-on-accent);border-color:var(--tx-accent)}
.tx-chips .tx-button{border-radius:999px;padding:6px 14px}
.tx-tag{display:inline-block;font-size:.8rem;line-height:1.4;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--tx-fg) 8%,var(--tx-surface));color:var(--tx-fg);overflow-wrap:anywhere}
.tx-tag.tx-success{background:color-mix(in srgb,var(--tx-success) 22%,var(--tx-surface))}
.tx-tag.tx-warning{background:color-mix(in srgb,var(--tx-warning) 22%,var(--tx-surface))}
.tx-tag.tx-danger{background:color-mix(in srgb,var(--tx-danger) 16%,var(--tx-surface));color:var(--tx-danger)}
.tx-tag.tx-accent{background:color-mix(in srgb,var(--tx-accent) 16%,var(--tx-surface))}
.tx-tag.tx-strong{background:var(--tx-accent);color:var(--tx-on-accent)}
.tx-card,.tx-tile{background:var(--tx-surface);border:1px solid var(--tx-line);border-radius:calc(var(--tx-radius) * 1.2);padding:16px;color:var(--tx-fg)}
.tx-card>h2{font-size:1.1rem;margin:0 0 8px}
.tx-tile{display:block;width:100%;min-height:44px;text-align:start;font:inherit}
button.tx-tile{cursor:pointer}
.tx-value{display:block;font-size:1.9rem;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums}
.tx-bars{display:grid;gap:4px}
.tx-bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr 4ch;gap:8px;align-items:center;font-size:.9rem;min-height:32px;width:100%;padding:0;border:0;background:none;color:inherit;font-family:inherit;text-align:start}
button.tx-bar{min-height:44px;cursor:pointer}
.tx-track{background:color-mix(in srgb,var(--tx-fg) 8%,var(--tx-surface));border-radius:4px;height:12px}
.tx-track,.tx-fill{display:block}
.tx-fill{background:var(--tx-accent);height:12px;border-radius:4px;min-width:3px}
.tx-n{text-align:end;font-variant-numeric:tabular-nums}
:is(button.tx-tile,button.tx-bar):focus-visible{outline:3px solid var(--tx-accent);outline-offset:3px}
`;
	document.head.append(style);

	/** el("p", {class, text, attrs, on}, ...children): a node; text never becomes HTML. */
	function el(tag, props = {}, ...children) {
		const node = document.createElement(tag);
		if (props.class) node.className = props.class;
		if (props.text != null) node.textContent = String(props.text);
		for (const [name, value] of Object.entries(props.attrs ?? {}))
			if (value != null && value !== false)
				node.setAttribute(name, value === true ? "" : String(value));
		for (const [event, handler] of Object.entries(props.on ?? {}))
			node.addEventListener(event, handler);
		for (const child of children.flat())
			if (child != null && child !== false)
				node.append(child instanceof Node ? child : String(child));
		return node;
	}

	/** A 44px button; variant "primary" or "quiet"; class adds the app's own classes. */
	function button(
		label,
		onClick,
		{ variant = "", disabled = false, attrs = {}, class: extra = "" } = {},
	) {
		return el("button", {
			class: ["tx-button", variant && `tx-${variant}`, extra]
				.filter(Boolean)
				.join(" "),
			text: label,
			attrs: { type: "button", disabled, ...attrs },
			on: { click: onClick },
		});
	}

	/** Live text for progress; screen readers announce it politely. */
	const status = (text) =>
		el("p", { class: "tx-muted", text, attrs: { role: "status" } });
	/** An error the person must notice. */
	const alert = (text) =>
		el("p", { class: "tx-alert", text, attrs: { role: "alert" } });

	/**
	 * Tabs with arrow, Home and End keys. items: [[value, label], ...].
	 * onChange(value) must re-render; focus follows the chosen tab.
	 * Give the panel the id `${id}-panel` and aria-labelledby `${id}-${value}`.
	 */
	function tabs({ id, label, items, value, onChange, disabled = false }) {
		const list = el("div", {
			class: "tx-tabs",
			attrs: { role: "tablist", "aria-label": label },
		});
		const values = items.map(([v]) => v);
		const choose = (next) => {
			onChange(next);
			queueMicrotask(() => document.getElementById(`${id}-${next}`)?.focus());
		};
		for (const [v, text] of items) {
			const tab = button(text, () => choose(v), {
				disabled,
				attrs: {
					id: `${id}-${v}`,
					role: "tab",
					"aria-selected": String(v === value),
					"aria-controls": `${id}-panel`,
					tabindex: v === value ? "0" : "-1",
				},
			});
			tab.addEventListener("keydown", (event) => {
				const at = values.indexOf(value);
				const next = {
					ArrowRight: values[(at + 1) % values.length],
					ArrowLeft: values[(at - 1 + values.length) % values.length],
					Home: values[0],
					End: values[values.length - 1],
				}[event.key];
				if (next === undefined || disabled) return;
				event.preventDefault();
				choose(next);
			});
			list.append(tab);
		}
		return list;
	}

	/** An in-app confirmation; native confirm() is blocked in the sandbox. */
	function confirm({
		label,
		question,
		confirmLabel,
		cancelLabel,
		onConfirm,
		onCancel,
		disabled = false,
	}) {
		return el(
			"section",
			{ class: "tx-confirm", attrs: { "aria-label": label } },
			el("p", { text: question }),
			button(cancelLabel, onCancel, { disabled }),
			button(confirmLabel, onConfirm, { variant: "primary", disabled }),
		);
	}

	/** A labelled select. options: [[value, label], ...]. */
	function select({ label, options, value, onChange, disabled = false }) {
		const control = el("select", {
			attrs: { disabled },
			on: { change: () => onChange(control.value) },
		});
		for (const [v, text] of options)
			control.append(el("option", { text, attrs: { value: v } }));
		control.value = value ?? "";
		return el(
			"label",
			{ class: "tx-select" },
			el("span", { text: label }),
			control,
		);
	}

	/**
	 * A table with an optional pager. columns: [{key, label, end?, render?(row)}];
	 * render may return text or a node. labels: {previous, next, range} where range
	 * may use {from}, {to} and {total}. Omit pageSize to show every row.
	 */
	function table({
		caption,
		columns,
		rows,
		empty,
		pageSize,
		page = 0,
		onPage,
		labels = {},
	}) {
		const wrap = el("div");
		if (!rows.length) {
			wrap.append(el("p", { class: "tx-muted", text: empty }));
			return wrap;
		}
		const pages = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
		const current = Math.min(Math.max(page, 0), pages - 1);
		const shown = pageSize
			? rows.slice(current * pageSize, (current + 1) * pageSize)
			: rows;
		const head = el(
			"tr",
			{},
			columns.map((c) =>
				el("th", {
					class: c.end ? "tx-end" : "",
					text: c.label,
					attrs: { scope: "col" },
				}),
			),
		);
		const body = shown.map((row) =>
			el(
				"tr",
				{},
				columns.map((c) => {
					const value = c.render ? c.render(row) : row[c.key];
					return el(
						"td",
						{ class: c.end ? "tx-end" : "" },
						value instanceof Node ? value : String(value ?? ""),
					);
				}),
			),
		);
		wrap.append(
			el(
				"div",
				{
					class: "tx-table",
					attrs: { tabindex: "0", role: "region", "aria-label": caption },
				},
				el(
					"table",
					{},
					caption ? el("caption", { text: caption }) : null,
					el("thead", {}, head),
					el("tbody", {}, body),
				),
			),
		);
		if (pages > 1) {
			const from = current * pageSize + 1;
			const range = (labels.range ?? "{from}–{to} / {total}")
				.replace("{from}", from)
				.replace("{to}", from + shown.length - 1)
				.replace("{total}", rows.length);
			wrap.append(
				el(
					"nav",
					{ class: "tx-pager", attrs: { "aria-label": caption } },
					button(labels.previous ?? "‹", () => onPage(current - 1), {
						disabled: current === 0,
					}),
					el("span", { text: range, attrs: { "aria-live": "polite" } }),
					button(labels.next ?? "›", () => onPage(current + 1), {
						disabled: current >= pages - 1,
					}),
				),
			);
		}
		return wrap;
	}

	/** On/off filter chips; one is pressed. items: [[value, label], ...]. */
	function chips({ label, items, value, onChange, disabled = false }) {
		return el(
			"div",
			{
				class: "tx-row tx-chips",
				attrs: { role: "group", "aria-label": label },
			},
			items.map(([v, text]) =>
				button(text, () => onChange(v), {
					disabled,
					attrs: { "aria-pressed": String(v === value) },
				}),
			),
		);
	}

	/** A small label; tone is success, warning, danger, accent or strong. */
	const tag = (text, tone = "") =>
		el("span", { class: `tx-tag${tone ? ` tx-${tone}` : ""}`, text });

	/** A bordered panel with an optional heading. */
	const card = ({ title, class: extra = "" } = {}, ...children) =>
		el(
			"section",
			{ class: `tx-card ${extra}`.trim() },
			title ? el("h2", { text: title }) : null,
			...children,
		);

	/** A key figure; with onClick the whole tile is one button. */
	function tile({ value, label, onClick }) {
		const parts = [
			el("span", { class: "tx-value", text: value }),
			el("span", { class: "tx-muted", text: label }),
		];
		return onClick
			? el(
					"button",
					{
						class: "tx-tile",
						attrs: { type: "button", "aria-label": `${label}: ${value}` },
						on: { click: onClick },
					},
					parts,
				)
			: el("div", { class: "tx-tile" }, parts);
	}

	/** Horizontal bars. entries: [[name, count], ...]; onPick(name) makes rows buttons. */
	function bars({ label, entries, onPick }) {
		const max = Math.max(1, ...entries.map(([, n]) => n));
		return el(
			"div",
			{ class: "tx-bars", attrs: { role: "group", "aria-label": label } },
			entries.map(([name, n]) => {
				const fill = el("span", { class: "tx-fill" });
				fill.style.width = `${(n / max) * 100}%`;
				return el(
					onPick ? "button" : "div",
					{
						class: "tx-bar",
						attrs: {
							type: onPick ? "button" : null,
							"aria-label": `${name}: ${n}`,
						},
						on: onPick ? { click: () => onPick(name) } : {},
					},
					el("span", { text: name }),
					el(
						"span",
						{ class: "tx-track", attrs: { "aria-hidden": "true" } },
						fill,
					),
					el("span", {
						class: "tx-n",
						text: n,
						attrs: { "aria-hidden": "true" },
					}),
				);
			}),
		);
	}

	return {
		el,
		button,
		status,
		alert,
		tabs,
		confirm,
		select,
		table,
		chips,
		tag,
		card,
		tile,
		bars,
	};
})();

// ---- The review app ----
const appStyle = document.createElement("style");
appStyle.textContent = `
body{padding:16px;margin:0}main{max-width:640px;margin:auto}h1{font-size:1.6rem;margin:0}
p{white-space:pre-wrap;overflow-wrap:anywhere}header{margin:16px 0}
article{padding:20px;border:1px solid var(--tx-line);border-radius:calc(var(--tx-radius) * 1.5);background:var(--tx-surface)}
h2{font-size:1.25rem;margin:8px 0}section+section,.tx-tabs,.tx-row{margin:16px 0}
`;
document.head.append(appStyle);
const root = document.getElementById("app");
let cards = [];
let tab = "open";
let busy = false;
// Every visible word comes from config.settings.copy, so each organization sets
// its own language and wording without changing code.
let copy = { errors: {} };
let message = "…";
let failure = "";
let confirmingReset = false;

async function call(method, args = []) {
	return tedix.call("app.call", { method, args });
}
async function run(action) {
	if (busy) return;
	busy = true;
	failure = "";
	render();
	try {
		await action();
	} catch (error) {
		failure =
			copy.errors[error.code ?? error.message] ??
			copy.errors.failed ??
			String(error.code ?? error.message);
	} finally {
		busy = false;
		render();
	}
}
async function load() {
	const context = await tedix.call("context");
	copy = {
		...context.settings.copy,
		errors: context.settings.copy?.errors ?? {},
	};
	document.documentElement.lang = context.settings.locale ?? "en";
	if (!context.settings.slot) throw new Error("slot_unbound");
	message = copy.loading;
	cards = await call("cards");
	message = copy.loaded;
}
function render() {
	const visible = cards.filter((card) =>
		tab === "open" ? !card.verdict : card.verdict,
	);
	const card = visible[0];
	const panel = ui.el(
		"section",
		{
			attrs: {
				id: "cards-panel",
				role: "tabpanel",
				"aria-labelledby": `cards-${tab}`,
			},
		},
		ui.el("p", {
			class: "tx-muted",
			text: String(copy.count).replace("{n}", visible.length),
		}),
	);
	if (card) {
		const rate = (verdict) => () =>
			run(async () => {
				await call("rate", [card.id, verdict]);
				await load();
			});
		panel.append(
			ui.el(
				"article",
				{},
				ui.el("p", { class: "tx-muted", text: card.category }),
				ui.el("h2", { text: card.title }),
				ui.el("p", { text: card.body }),
				card.verdict &&
					ui.el("p", {
						text: card.verdict === "useful" ? copy.useful : copy.notUseful,
					}),
				ui.el(
					"div",
					{ class: "tx-row" },
					ui.button(copy.useful, rate("useful"), {
						variant: "primary",
						disabled: busy,
					}),
					ui.button(copy.notUseful, rate("not_useful"), { disabled: busy }),
					ui.button(
						copy.next,
						() => {
							cards = [...cards.filter((item) => item.id !== card.id), card];
							render();
						},
						{ disabled: busy },
					),
				),
			),
		);
	} else if (!busy && !failure)
		panel.append(
			ui.el("p", { text: tab === "open" ? copy.allDone : copy.noneReviewed }),
		);
	const main = ui.el(
		"main",
		{},
		ui.el(
			"header",
			{ class: "tx-row" },
			ui.el("h1", { text: copy.title }),
			ui.button(copy.reload, () => run(load), { disabled: busy }),
		),
		ui.status(message),
		ui.tabs({
			id: "cards",
			label: copy.tabs,
			items: [
				["open", copy.open],
				["reviewed", copy.reviewed],
			],
			value: tab,
			disabled: busy,
			onChange: (value) => {
				tab = value;
				render();
			},
		}),
		panel,
		ui.button(
			copy.reset,
			() => {
				confirmingReset = true;
				render();
			},
			{ disabled: busy },
		),
		confirmingReset &&
			ui.confirm({
				label: copy.resetLabel,
				question: copy.resetQuestion,
				cancelLabel: copy.cancel,
				confirmLabel: copy.confirmReset,
				disabled: busy,
				onCancel: () => {
					confirmingReset = false;
					render();
				},
				onConfirm: () =>
					run(async () => {
						await call("reset");
						confirmingReset = false;
						tab = "open";
						await load();
					}),
			}),
		failure && ui.alert(failure),
	);
	root.replaceChildren(main);
}
await run(load);
