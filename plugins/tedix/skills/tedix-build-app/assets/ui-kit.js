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

	/** A 44px button; variant "primary" or "quiet". */
	function button(
		label,
		onClick,
		{ variant = "", disabled = false, attrs = {} } = {},
	) {
		return el("button", {
			class: `tx-button${variant ? ` tx-${variant}` : ""}`,
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

	return { el, button, status, alert, tabs, confirm, select, table };
})();
