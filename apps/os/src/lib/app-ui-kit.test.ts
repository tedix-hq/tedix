import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import kitSource from "../../../../plugins/tedix/skills/tedix-build-app/assets/ui-kit.js?raw";
import starterSource from "../../../../plugins/tedix/skills/tedix-build-app/assets/sheet-review/client.js?raw";

// The kit is pasted into each app's client.js, so it is a plain script, not a module.
function loadKit() {
	return new Function(`${kitSource}\nreturn ui;`)() as {
		el: (tag: string, props?: object, ...children: unknown[]) => HTMLElement;
		button: (
			label: string,
			onClick: () => void,
			options?: object,
		) => HTMLButtonElement;
		status: (text: string) => HTMLElement;
		alert: (text: string) => HTMLElement;
		tabs: (options: object) => HTMLElement;
		confirm: (options: object) => HTMLElement;
		select: (options: object) => HTMLElement;
		table: (options: object) => HTMLElement;
		chips: (options: object) => HTMLElement;
		tag: (text: string, tone?: string) => HTMLElement;
		card: (options?: object, ...children: unknown[]) => HTMLElement;
		tile: (options: object) => HTMLElement;
		bars: (options: object) => HTMLElement;
	};
}

afterEach(() => {
	document.head.replaceChildren();
	document.body.replaceChildren();
});

describe("app UI kit", () => {
	it("is pasted unchanged at the top of the review starter", () => {
		expect(starterSource.startsWith(kitSource)).toBe(true);
	});

	it("styles only with Tedix theme variables and system colours", () => {
		loadKit();
		const css = document.getElementById("tedix-ui")?.textContent ?? "";
		expect(css).toContain("var(--tedix-primary,AccentColor)");
		expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|color-scheme/i);
	});

	it("never turns text into HTML", () => {
		const ui = loadKit();
		const node = ui.el("p", { text: "<b>x</b>" });
		expect(node.textContent).toBe("<b>x</b>");
		expect(node.querySelector("b")).toBeNull();
	});

	it("makes typed buttons with variants and a disabled state", () => {
		const ui = loadKit();
		const click = vi.fn();
		const node = ui.button("Go", click, { variant: "primary", disabled: true });
		expect(node.type).toBe("button");
		expect(node.className).toBe("tx-button tx-primary");
		expect(node.disabled).toBe(true);
		ui.button("Go", click).click();
		expect(click).toHaveBeenCalledTimes(1);
	});

	it("moves between tabs with arrow, Home and End keys", () => {
		const ui = loadKit();
		const onChange = vi.fn();
		const list = ui.tabs({
			id: "t",
			label: "Views",
			items: [
				["a", "A"],
				["b", "B"],
				["c", "C"],
			],
			value: "a",
			onChange,
		});
		const tabs = [...list.querySelectorAll('[role="tab"]')] as HTMLElement[];
		expect(list.getAttribute("role")).toBe("tablist");
		expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
			"true",
			"false",
			"false",
		]);
		expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
		expect(tabs[1]?.getAttribute("aria-controls")).toBe("t-panel");
		for (const key of ["ArrowRight", "ArrowLeft", "End", "Home"])
			tabs[0]?.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true }),
			);
		expect(onChange.mock.calls.map(([value]) => value)).toEqual([
			"b",
			"c",
			"c",
			"a",
		]);
	});

	it("confirms in place with labelled cancel and confirm buttons", () => {
		const ui = loadKit();
		const onConfirm = vi.fn();
		const section = ui.confirm({
			label: "Reset",
			question: "Reset all?",
			cancelLabel: "Keep",
			confirmLabel: "Reset",
			onCancel: vi.fn(),
			onConfirm,
		});
		expect(section.getAttribute("aria-label")).toBe("Reset");
		const [cancel, confirm] = [...section.querySelectorAll("button")];
		expect([cancel?.textContent, confirm?.textContent]).toEqual([
			"Keep",
			"Reset",
		]);
		confirm?.click();
		expect(onConfirm).toHaveBeenCalled();
	});

	it("reports the chosen option of a labelled select", () => {
		const ui = loadKit();
		const onChange = vi.fn();
		const label = ui.select({
			label: "Week",
			options: [
				["", "All"],
				["w46", "Week 46"],
			],
			value: "w46",
			onChange,
		});
		const control = label.querySelector("select") as HTMLSelectElement;
		expect(label.textContent).toContain("Week");
		expect(control.value).toBe("w46");
		control.value = "";
		control.dispatchEvent(new Event("change"));
		expect(onChange).toHaveBeenCalledWith("");
	});

	it("pages a table and shows its range", () => {
		const ui = loadKit();
		const onPage = vi.fn();
		const rows = Array.from({ length: 7 }, (_, i) => ({ n: i + 1 }));
		const options = {
			caption: "Cards",
			columns: [{ key: "n", label: "N", end: true }],
			rows,
			pageSize: 3,
			onPage,
			labels: {
				previous: "Back",
				next: "More",
				range: "{from}–{to} of {total}",
			},
		};
		const first = ui.table({ ...options, page: 0 });
		expect(
			[...first.querySelectorAll("tbody td")].map((td) => td.textContent),
		).toEqual(["1", "2", "3"]);
		expect(first.querySelector("nav")?.textContent).toContain("1–3 of 7");
		const [back, more] = [
			...first.querySelectorAll("nav button"),
		] as HTMLButtonElement[];
		expect(back?.disabled).toBe(true);
		more?.click();
		expect(onPage).toHaveBeenCalledWith(1);
		const last = ui.table({ ...options, page: 9 });
		expect(
			[...last.querySelectorAll("tbody td")].map((td) => td.textContent),
		).toEqual(["7"]);
		expect(last.querySelector("nav")?.textContent).toContain("7–7 of 7");
		expect(
			ui.table({ ...options, rows: [], empty: "Nothing yet" }).textContent,
		).toBe("Nothing yet");
		expect(
			ui.table({ ...options, pageSize: undefined }).querySelector("nav"),
		).toBeNull();
	});

	it("adds the app's own classes to a button", () => {
		const ui = loadKit();
		expect(
			ui.button("Go", vi.fn(), { variant: "quiet", class: "chip big" })
				.className,
		).toBe("tx-button tx-quiet chip big");
	});

	it("presses exactly one filter chip and reports the choice", () => {
		const ui = loadKit();
		const onChange = vi.fn();
		const group = ui.chips({
			label: "Filter",
			items: [
				["all", "All"],
				["open", "Open"],
			],
			value: "open",
			onChange,
		});
		const chips = [...group.querySelectorAll("button")];
		expect(group.getAttribute("role")).toBe("group");
		expect(group.getAttribute("aria-label")).toBe("Filter");
		expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual([
			"false",
			"true",
		]);
		chips[0]?.click();
		expect(onChange).toHaveBeenCalledWith("all");
	});

	it("tones tags and builds cards with an optional heading", () => {
		const ui = loadKit();
		expect(ui.tag("Done", "success").className).toBe("tx-tag tx-success");
		expect(ui.tag("Note").className).toBe("tx-tag");
		const card = ui.card({ title: "Work" }, ui.el("p", { text: "x" }));
		expect(card.querySelector("h2")?.textContent).toBe("Work");
		expect(card.className).toBe("tx-card");
		expect(ui.card({}, "y").querySelector("h2")).toBeNull();
	});

	it("makes a whole tile one labelled button only when it acts", () => {
		const ui = loadKit();
		const onClick = vi.fn();
		const tile = ui.tile({ value: 6, label: "Open work", onClick });
		expect(tile.tagName).toBe("BUTTON");
		expect(tile.getAttribute("aria-label")).toBe("Open work: 6");
		tile.click();
		expect(onClick).toHaveBeenCalled();
		expect(ui.tile({ value: 3, label: "People" }).tagName).toBe("DIV");
	});

	it("scales bars to the largest count and makes rows pickable", () => {
		const ui = loadKit();
		const onPick = vi.fn();
		const box = ui.bars({
			label: "By status",
			entries: [
				["Open", 4],
				["Done", 2],
			],
			onPick,
		});
		const rows = [...box.querySelectorAll(".tx-bar")] as HTMLElement[];
		expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual([
			"Open: 4",
			"Done: 2",
		]);
		expect(
			rows.map((r) => (r.querySelector(".tx-fill") as HTMLElement).style.width),
		).toEqual(["100%", "50%"]);
		rows[1]?.click();
		expect(onPick).toHaveBeenCalledWith("Done");
		// The fill sits inside the track, so it must be a block or its width is ignored.
		expect(document.getElementById("tedix-ui")?.textContent).toContain(
			".tx-track,.tx-fill{display:block}",
		);
		const still = ui.bars({ label: "Plain", entries: [["A", 0]] });
		expect(still.querySelector(".tx-bar")?.tagName).toBe("DIV");
	});

	it("announces status and errors", () => {
		const ui = loadKit();
		expect(ui.status("Loading").getAttribute("role")).toBe("status");
		expect(ui.alert("Failed").getAttribute("role")).toBe("alert");
	});
});
