import type { PresentationContent } from "@/lib/output-models";
import { readFileSync } from "node:fs";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import {
	PRESENTATION_ELEMENT_TYPES,
	SlidesEditor,
} from "./output-editor-slides";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const content = (
	slides: PresentationContent["slides"] = [],
): PresentationContent => ({ kind: "presentation", slides });
const twoSlides = () =>
	content([
		{ title: "Q3", bullets: ["Revenue", "Costs"], notes: "Pause" },
		{ title: "Q4", bullets: [] },
	]);

function mountEditor(initial = twoSlides(), disabled = false) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const emitted: PresentationContent[] = [];
	function Harness() {
		const [value, setValue] = useState(initial);
		return (
			<SlidesEditor
				value={value}
				disabled={disabled}
				onChange={(next) => {
					emitted.push(next);
					setValue(next);
				}}
			/>
		);
	}
	act(() => root.render(<Harness />));
	return {
		container,
		emitted,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

async function chooseSelectOption(
	container: HTMLElement,
	label: string,
	optionLabel: string,
) {
	const trigger = container.querySelector<HTMLButtonElement>(
		`[aria-label="${label}"]`,
	);
	await act(async () => {
		trigger?.click();
		await Promise.resolve();
	});
	const option = Array.from(document.querySelectorAll('[role="option"]')).find(
		(candidate) => candidate.textContent === optionLabel,
	) as HTMLElement | undefined;
	await act(async () => {
		option?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
		option?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
		option?.click();
		await Promise.resolve();
	});
}

async function insertFromLibrary(container: HTMLElement, type: string) {
	await act(async () => {
		container
			.querySelector<HTMLButtonElement>('[aria-label="Insert slide element"]')
			?.click();
		await Promise.resolve();
	});
	await act(async () => {
		document
			.querySelector<HTMLButtonElement>(`[data-slide-component="${type}"]`)
			?.click();
		await Promise.resolve();
	});
}

/** The one fixed-light scope both slide sidebars opt into. */
function chromeRule() {
	const css = readFileSync("src/styles.css", "utf8");
	const rule = css.match(/^\.slides-editor-chrome \{[^}]*\}/m)?.[0];
	expect(rule).toBeDefined();
	return rule as string;
}

describe("SlidesEditor", () => {
	it("keeps presentation chrome on Kumo adapters and semantic focus tokens", async () => {
		const mounted = mountEditor();
		const group = mounted.container.querySelector<HTMLElement>(
			'[role="group"][data-element]',
		)!;
		await act(async () => group.click());
		// Every native control comes from a Kumo adapter, except the slide's own
		// text input: it is slide content, and a Kumo type role would force UI
		// type onto it (see output-slide-element.test.tsx).
		for (const control of mounted.container.querySelectorAll(
			"button, input, select, textarea",
		)) {
			if (control.id.endsWith("-hidden-input")) continue;
			// A Kumo Switch's form input, hidden from the page and the tab order.
			if (control.matches('input[aria-hidden="true"][tabindex="-1"]')) continue;
			if (control.classList.contains("slide-element-input")) continue;
			expect(
				control.hasAttribute("data-slot") ||
					control.hasAttribute("data-kumo-component") ||
					control.hasAttribute("data-toolbar-control"),
				control.outerHTML.slice(0, 120),
			).toBe(true);
		}
		// Selection uses the semantic focus ring.
		expect(group.className).toContain("ring-kumo-focus");
		// Elements size their type against the canvas, never an ancestor.
		const canvas = mounted.container.querySelector<HTMLElement>(
			".slides-editor-canvas",
		)!;
		expect(canvas.style.containerType).toBe("inline-size");
		// Inline text editing is a borderless, transparent field on the slide:
		// `.slide-element-input` unsets every control style.
		const field = group.querySelector("textarea");
		expect(field?.className).toBe("slide-element-input");
		const css = readFileSync("src/styles.css", "utf8");
		expect(css).toMatch(/\.slide-element-input \{\n\tall: unset;/);
		const stage = mounted.container.querySelector(".slides-editor-stage");
		expect(stage).not.toBeNull();
		expect(stage!.classList.contains("rounded-lg")).toBe(false);
		expect(stage!.classList.contains("bg-kumo-tint")).toBe(false);
		// No raw palette colours; everything resolves through Kumo roles.
		for (const element of mounted.container.querySelectorAll("[class]")) {
			expect(element.getAttribute("class")).not.toMatch(
				/(?:ring|border|bg)-blue-|(?:bg|text)-(?:black|white)\b/,
			);
		}
		mounted.cleanup();
	});

	// The fit rule: the slide box is bounded by BOTH axes of its stage. Its width
	// is min(stage width, the width a 16:9 box may have at the stage's height),
	// so whichever axis binds first letterboxes the other. The slide therefore
	// stays exactly 16:9, is centred, and can never overflow or be clipped by the
	// stage — unlike the previous width-driven `aspect-video w-full`, which fixed
	// the width and let the derived height run past the bottom of the stage.
	// jsdom does not lay out CSS, so this pins the class/style contract instead.
	it("fits the slide to the stage on height as well as width", () => {
		const styles = readFileSync("src/styles.css", "utf8");
		const canvasRule = styles
			.split(".slides-editor-canvas {")[1]
			?.split("}")[0];
		expect(canvasRule).toBeDefined();
		// Height-bound: the cqh term is what stops the width-driven overflow.
		expect(canvasRule).toContain("100cqh");
		// Width-bound, and exactly 16:9 either way.
		expect(canvasRule).toContain("100cqw");
		expect(canvasRule).toContain("aspect-ratio: 16 / 9");
		expect(canvasRule).toContain("max-width: 100%");
		// cqh only resolves against an ancestor with size containment, so both
		// stages must declare one, and the stage centres the letterboxed slide.
		expect(styles).toMatch(
			/\.slides-editor-stage \{[^}]*container-type: size;/,
		);
		expect(styles).toMatch(
			/\.slides-present-stage \{[^}]*container-type: size;/,
		);
		const mounted = mountEditor();
		expect(
			mounted.container.querySelector(".slides-editor-stage")?.className,
		).toContain("place-content-center");
		const canvas = mounted.container.querySelector(".slides-editor-canvas");
		expect(canvas).not.toBeNull();
		// No width-driven sizing left on the element itself.
		expect(canvas?.className).not.toContain("w-full");
		expect(canvas?.className).not.toContain("aspect-video");
		mounted.cleanup();
	});

	// cqh is 0 unless every ancestor down to the stage has a definite height. In
	// the workspace canvas the shell grew with the rail instead, so the slide was
	// centred in a 1378px stage inside a 763px pane, mostly below the fold.
	it("bounds the editor to its host pane in the workspace canvas", () => {
		const styles = readFileSync("src/styles.css", "utf8");
		expect(styles).toMatch(
			/\.canvas-document-shell:has\(> \.slides-editor\) \{[^}]*display: flex;[^}]*height: 100%;[^}]*flex-direction: column;/,
		);
		// The editor absorbs the remaining height wherever banners put it.
		expect(styles).toMatch(
			/\.canvas-document-shell > \.slides-editor \{[^}]*min-height: 0;[^}]*flex: 1 1 0;/,
		);
		const mounted = mountEditor();
		expect(
			mounted.container.querySelector(".slides-editor-layout")?.className,
		).not.toMatch(/min-h-\[/);
		mounted.cleanup();
	});

	it("opens with the slide rail visible and keeps it an explicit toggle", () => {
		const mounted = mountEditor();
		// First render, no user interaction: the rail is on screen.
		const rail = mounted.container.querySelector<HTMLElement>(
			".slides-editor-thumbnails",
		);
		expect(rail).not.toBeNull();
		expect(rail?.hidden).toBe(false);
		expect(
			mounted.container
				.querySelector(".slides-editor-layout")
				?.getAttribute("data-show-thumbnails"),
		).toBe("true");
		// The rail toggle is an icon target now, so it is found by its accessible
		// name rather than its old visible text. What is pinned is unchanged: the
		// rail is on by default and the toggle reports itself pressed.
		const toggle = mounted.container.querySelector<HTMLButtonElement>(
			'[aria-label="Slide rail"]',
		);
		expect(toggle?.getAttribute("aria-pressed")).toBe("true");
		// The inspector keeps its closed default.
		expect(
			mounted.container.querySelector<HTMLElement>(".slides-editor-inspector")
				?.hidden,
		).toBe(true);
		// Still an explicit toggle the user can close.
		act(() => toggle?.click());
		expect(
			mounted.container.querySelector<HTMLElement>(".slides-editor-thumbnails")
				?.hidden,
		).toBe(true);
		mounted.cleanup();
	});

	it("offers visual templates, the complete component palette, thumbnails, notes, and presentation mode", async () => {
		const mounted = mountEditor();
		expect(
			mounted.container.querySelector('[data-editor="presentation-canvas"]'),
		).not.toBeNull();
		expect(
			mounted.container.querySelector('[aria-label="New slide template"]'),
		).not.toBeNull();
		const toolbar = mounted.container.querySelector(
			'[data-kumo-component="Toolbar"]',
		);
		expect(toolbar?.className).toContain("text-xs");
		expect(toolbar?.parentElement?.className).toContain("border-y");
		expect(
			mounted.container.querySelector('[aria-label="Undo"]')?.className,
		).toContain("items-center justify-center p-0");
		expect(
			toolbar?.closest('[data-editor="presentation-canvas"]')?.className,
		).toContain("gap-0");
		expect(mounted.container.querySelector("select")).toBeNull();
		expect(
			mounted.container.querySelector('[aria-label="Insert slide element"]'),
		).not.toBeNull();
		expect(PRESENTATION_ELEMENT_TYPES).toEqual([
			"title",
			"subtitle",
			"text",
			"bullet",
			"label",
			"card",
			"box",
			"image",
			"svg",
			"divider",
			"shape",
			"arrow",
			"logo",
		]);
		await insertFromLibrary(mounted.container, "text");
		for (const panel of ["Slides", "Inspector"]) {
			const toggle = Array.from(
				mounted.container.querySelectorAll("button"),
			).find((button) => button.textContent?.trim() === panel);
			act(() => toggle?.click());
		}
		expect(
			mounted.container.querySelector('[aria-label="Search slides"]'),
		).not.toBeNull();
		expect(
			mounted.container.querySelector('[aria-label="Speaker notes"]'),
		).not.toBeNull();
		expect(
			Array.from(mounted.container.querySelectorAll("button")).some((button) =>
				button.textContent?.includes("Present"),
			),
		).toBe(true);
		mounted.cleanup();
	});

	it("adds a selected text element and keeps the legacy slide projection", async () => {
		const mounted = mountEditor(content([{ title: "Launch", bullets: [] }]));
		await insertFromLibrary(mounted.container, "text");
		const next = mounted.emitted.at(-1);
		expect(
			next?.deck?.slides[0]?.elements.some(
				(element) => element.type === "text",
			),
		).toBe(true);
		expect(next?.slides[0]?.title).toBe("Launch");
		// Position and size sit behind the Advanced disclosure.
		expect(
			mounted.container.querySelector('[aria-label="Element x"]'),
		).toBeNull();
		const advanced = Array.from(
			mounted.container.querySelectorAll("button"),
		).find((button) => button.textContent?.trim() === "Advanced");
		await act(async () => {
			advanced?.click();
			await Promise.resolve();
		});
		expect(
			mounted.container.querySelector('[aria-label="Element x"]'),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("adds the standard content slide in one click", () => {
		const mounted = mountEditor(content([{ title: "Launch", bullets: [] }]));
		const add = Array.from(mounted.container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === "Add slide",
		);
		act(() => add?.click());
		const next = mounted.emitted.at(-1);
		expect(next?.deck?.slides).toHaveLength(2);
		expect(next?.deck?.slides[1]?.layout).toBe("title-content");
		mounted.cleanup();
	});

	it("adds a slide from a chosen visual template", async () => {
		const mounted = mountEditor(content([{ title: "Launch", bullets: [] }]));
		const select = mounted.container.querySelector<HTMLButtonElement>(
			'[aria-label="New slide template"]',
		);
		await act(async () => {
			select?.click();
			await Promise.resolve();
		});
		const option = Array.from(
			document.querySelectorAll('[role="menuitem"]'),
		).find((candidate) => candidate.textContent === "Four card") as
			| HTMLElement
			| undefined;
		expect(option).toBeDefined();
		await act(async () => {
			option?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
			option?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
			option?.click();
			await Promise.resolve();
		});
		const next = mounted.emitted.at(-1);
		expect(next?.deck?.slides).toHaveLength(2);
		expect(next?.deck?.slides[1]?.layout).toBe("four-card");
		expect(next?.deck?.slides[1]?.elements).toHaveLength(7);
		expect(
			next?.deck?.slides[1]?.elements
				.filter((element) => element.type === "card")
				.every(
					(element) =>
						element.props?.title === "Card heading" &&
						element.props?.body === "One clear idea per card.",
				),
		).toBe(true);
		mounted.cleanup();
	});

	it("disables all authoring controls in read-only mode", () => {
		const mounted = mountEditor(twoSlides(), true);
		for (const panel of ["Slides", "Inspector"]) {
			const toggle = Array.from(
				mounted.container.querySelectorAll("button"),
			).find((button) => button.textContent?.trim() === panel);
			act(() => toggle?.click());
		}
		// The toolbar keeps disabled controls focusable, so the menu trigger
		// reports aria-disabled rather than the native attribute.
		expect(
			mounted.container
				.querySelector('[aria-label="New slide template"]')
				?.getAttribute("aria-disabled"),
		).toBe("true");
		expect(
			Array.from(mounted.container.querySelectorAll("button"))
				.find((button) => button.textContent?.trim() === "Add slide")
				?.getAttribute("aria-disabled"),
		).toBe("true");
		expect(
			mounted.container.querySelector<HTMLTextAreaElement>(
				'[aria-label="Speaker notes"]',
			)?.disabled,
		).toBe(true);
		expect(
			mounted.container.querySelector<HTMLButtonElement>(
				'[aria-label="Delete slide"]',
			)?.disabled,
		).toBe(true);
		mounted.cleanup();
	});

	it("rounds the slide canvas while its stage stays square", () => {
		// The canvas has rounded corners; its surrounding stage stays square.
		const mounted = mountEditor();
		const canvas = mounted.container.querySelector(".slides-editor-canvas");
		const stage = mounted.container.querySelector(".slides-editor-stage");
		expect(stage?.className).not.toContain("rounded-lg");
		expect(stage?.className).not.toContain("rounded-md");
		const css = readFileSync("src/styles.css", "utf8");
		const canvasRule =
			css.match(/^\.slides-editor-canvas \{[^}]*\}/m)?.[0] ?? "";
		expect(canvasRule).toMatch(/border-radius: 6px;/);
		// Anchored: an unanchored match finds the workshop override selector that
		// merely ENDS in `.slides-editor-stage`.
		const stageRule = css.match(/^\.slides-editor-stage \{[^}]*\}/m)?.[0] ?? "";
		expect(stageRule).toContain("border-radius: 0");
		expect(canvas).not.toBeNull();
		mounted.cleanup();
	});

	it("keeps the rail and the inspector light neutral chrome, not raised cards", () => {
		// Sidebars use the fixed-light chrome scope, not shell-themed Surface
		// cards or floating-card utilities.
		const mounted = mountEditor();
		for (const selector of [
			".slides-editor-thumbnails",
			".slides-editor-inspector",
		]) {
			const pane = mounted.container.querySelector<HTMLElement>(selector);
			expect(pane).not.toBeNull();
			expect(pane?.getAttribute("data-slot")).not.toBe("surface");
			expect(pane?.classList.contains("slides-editor-chrome")).toBe(true);
			expect(pane?.className).not.toMatch(
				/\b(?:rounded|shadow)-|\b(?:bg|border)-kumo-/,
			);
		}
		mounted.cleanup();

		const chrome = chromeRule();
		expect(chrome).toContain("color-scheme: light");
		expect(chrome).toContain("border-radius: 0");
		expect(chrome).toContain("box-shadow: none");
		expect(chrome).not.toContain("var(--tedix-desk)");
	});

	// This is the test that would have caught the first attempt at the rule.
	//
	// That version restated only `--foreground` / `--background` / `--border` on
	// the sidebars, on the theory that the kumo leaves derive from them. Custom
	// properties do not work that way: `--text-color-kumo-default: var(--fore-
	// ground)` is substituted where it is DECLARED, at `:root`, and inherits as
	// an already-computed colour. Measured in a real dark shell, the surface
	// flipped light and every control stayed dark -- the search field painted
	// rgb(23, 23, 23) and the inactive slide chips painted rgb(245, 245, 245)
	// text on a near-white ground.
	//
	// So this pins the only thing that actually re-themes a control: the LEAF
	// the control's utility resolves, restated directly on the scope. Half is a
	// fixed list traced out of the shipped Kumo package; half is derived from
	// this file's own markup, so a kumo utility added to the sidebars later
	// fails here until its leaf is covered.
	it("restates every kumo leaf the sidebar controls resolve, not their inputs", () => {
		const chrome = chromeRule();
		const declared = new Set(
			[...chrome.matchAll(/--((?:text-)?color-kumo-[a-z-]+):/g)].map(
				(match) => match[1] as string,
			),
		);

		// Traced from @cloudflare/kumo/dist/chunks/{button,input}*.js:
		//   secondary   bg-kumo-base + text-kumo-default + hover:bg-kumo-tint
		//               + ring-kumo-line        -> the ACTIVE slide chip
		//   outline     text-kumo-default + ring-kumo-line
		//               + hover:text-kumo-strong -> the INACTIVE slide chips
		//   ghost       text-kumo-default + hover:bg-kumo-tint
		//                                      -> reorder/duplicate/delete
		//   destructive text-kumo-danger + ring-kumo-danger
		//   input/textarea bg-kumo-control + text-kumo-default + ring-kumo-line
		//               + focus:ring-kumo-focus + placeholder
		//               + [scrollbar-color: var(--color-kumo-line)]
		for (const leaf of [
			"color-kumo-base",
			"color-kumo-control",
			"color-kumo-tint",
			"color-kumo-line",
			"color-kumo-focus",
			"color-kumo-danger",
			"text-color-kumo-default",
			"text-color-kumo-strong",
			"text-color-kumo-subtle",
			"text-color-kumo-placeholder",
			"text-color-kumo-inactive",
			"text-color-kumo-danger",
		]) {
			expect(declared.has(leaf), `${leaf} must be restated on the scope`).toBe(
				true,
			);
		}

		// Every kumo colour utility this component writes must have its leaf
		// covered too. `bg-kumo-x` reads `--color-kumo-x`; `text-kumo-x` reads
		// `--text-color-kumo-x`.
		const source = readFileSync(
			"src/components/output-editor-slides.tsx",
			"utf8",
		);
		for (const [, prefix, role] of source.matchAll(
			/\b(text|bg|ring|border)-kumo-([a-z-]+?)(?:\/\d+)?\b/g,
		)) {
			const leaf =
				prefix === "text" ? `text-color-kumo-${role}` : `color-kumo-${role}`;
			expect(declared.has(leaf), `${prefix}-kumo-${role} needs ${leaf}`).toBe(
				true,
			);
		}

		// The load-bearing half: a leaf whose value points back at a shell token
		// is the original bug wearing the fix's clothes -- it would resolve
		// against this element, but only because the shell palette happens to be
		// restated here too, and it would silently follow the dark shell the
		// moment that stopped being true. Fixed light values only.
		for (const [, name, value] of chrome.matchAll(
			/--((?:text-)?color-kumo-[a-z-]+):\s*([^;]+);/g,
		)) {
			expect(value, `${name} must be a fixed light value`).not.toMatch(
				/var\(--(?!color-kumo|text-color-kumo)/,
			);
			expect(value, `${name} must not follow the shell`).not.toContain(
				"light-dark(",
			);
		}
	});

	it("keeps the selected slide legible without turning it into a dark chip", () => {
		// Requirement from the live read: an inactive chip must not be near-white
		// text on near-white ground, and the active one must not become a black
		// chip. Selection is carried by the focus hue on the ring plus a white
		// fill against the 0.94 rail -- no fill dark enough to invert the text.
		const css = readFileSync("src/styles.css", "utf8");
		const current =
			css.match(
				/^\.slides-editor-thumbnails \[aria-current\] \{[^}]*\}/m,
			)?.[0] ?? "";
		expect(current).toContain("--color-kumo-line: #7c3aed");
		expect(current).toContain("background: #ffffff");

		// The rail itself must stay light enough that the shared
		// `--text-color-kumo-default` ink reads on it.
		const chrome = chromeRule();
		expect(chrome).toContain("--text-color-kumo-default: #171717");
		expect(chrome).toMatch(/\n\tbackground: oklch\(0\.94 /);

		const mounted = mountEditor();
		const chips = mounted.container.querySelectorAll(
			".slides-editor-thumbnails ol button",
		);
		expect(chips.length).toBeGreaterThan(1);
		expect(
			[...chips].filter((chip) => chip.hasAttribute("aria-current")),
		).toHaveLength(1);
		mounted.cleanup();
	});

	it("separates the slide with its radius, not a shadow or a drawn edge", () => {
		// Rounded corners separate the canvas from its stage without a shadow,
		// border, or outline.
		const mounted = mountEditor();
		const canvas = mounted.container.querySelector<HTMLElement>(
			".slides-editor-canvas",
		);
		expect(canvas).not.toBeNull();
		expect(canvas?.className).not.toMatch(/\bshadow-/);
		expect(canvas?.className).not.toMatch(/\bborder(?:-|\b)/);
		mounted.cleanup();

		const css = readFileSync("src/styles.css", "utf8");
		const canvasRule =
			css.match(/^\.slides-editor-canvas \{[^}]*\}/m)?.[0] ?? "";
		expect(canvasRule).not.toContain("box-shadow");
		expect(canvasRule).not.toContain("outline:");
		expect(canvasRule).not.toContain("border:");
		expect(canvasRule).toMatch(/border-radius: 6px;/);
	});

	it("keeps the deck stage light while documents and sheets sit on the dark desk", () => {
		// The presentation stage stays light instead of using --tedix-desk.
		const css = readFileSync("src/styles.css", "utf8");
		// Anchored: an unanchored match finds the workshop override selector that
		// merely ENDS in `.slides-editor-stage`, not the base rule.
		const stage = css.match(/^\.slides-editor-stage \{[^}]*\}/m)?.[0] ?? "";
		expect(stage).toContain("color-scheme: light");
		expect(stage).not.toContain("var(--tedix-desk)");
		// Documents and sheets do share one desk, and keep doing so.
		expect(css).toMatch(/\.document-editor-desk \{[^}]*var\(--tedix-desk\)/);
		expect(css).toMatch(/\.sheet-editor-desk \{[^}]*var\(--tedix-desk\)/);
	});

	it("composes the shared editor toolbar instead of its own row", () => {
		const mounted = mountEditor();
		const toolbar = mounted.container.querySelector(
			'[data-kumo-component="Toolbar"]',
		);
		// Slides used to hand-roll this row: text-labelled pane toggles at three
		// different widths beside square history buttons, and no group hairlines.
		// The square controls must now come from the shared module, so the 26px
		// sizing rule in styles.css applies to them exactly as it does in
		// Document and Sheet.
		for (const name of ["Undo", "Redo", "Slide rail", "Inspector"]) {
			expect(
				mounted.container
					.querySelector(`[aria-label="${name}"]`)
					?.getAttribute("data-toolbar-control"),
				name,
			).toBe("icon");
		}
		// The two labelled Selects must NOT be crushed by that rule.
		for (const trigger of mounted.container.querySelectorAll(
			'[data-kumo-component="Select"]',
		)) {
			expect(trigger.getAttribute("data-toolbar-control")).toBeNull();
		}
		expect(
			toolbar?.parentElement?.className.includes("output-editor-toolbar"),
		).toBe(true);
		// Groups are separated the same way as the other two editors.
		expect(
			mounted.container.querySelectorAll(
				".output-editor-toolbar span[aria-hidden]",
			).length,
		).toBeGreaterThanOrEqual(2);
		// No capability lost: both dropdowns and Present survive the port.
		for (const name of ["New slide template", "Insert slide element"]) {
			expect(
				mounted.container.querySelector(`[aria-label="${name}"]`),
			).not.toBeNull();
		}
		expect(
			[...mounted.container.querySelectorAll("button")].some((button) =>
				button.textContent?.includes("Present"),
			),
		).toBe(true);
		mounted.cleanup();
	});

	it("browses slides without editing the document", () => {
		// Writing `activeSlideId` on every click made browsing an edit, so a
		// newer saved version could no longer load over an untouched draft.
		const mounted = mountEditor();
		act(() =>
			mounted.container
				.querySelector<HTMLButtonElement>('[aria-label="Slide 2: Q4"]')!
				.click(),
		);
		expect(mounted.emitted).toEqual([]);
		expect(
			mounted.container.querySelector(".slides-editor-stage")?.textContent,
		).toContain("Q4");
		mounted.cleanup();
	});

	it("lets the element textarea take Enter, space and Escape", () => {
		// The element wrapper selected on Enter/Space and prevented the default,
		// and those keys bubble from the textarea: no line break or space typed.
		const mounted = mountEditor();
		const textarea = mounted.container.querySelector<HTMLTextAreaElement>(
			".slides-editor-stage textarea",
		)!;
		for (const key of ["Enter", " "]) {
			const event = new KeyboardEvent("keydown", {
				key,
				bubbles: true,
				cancelable: true,
			});
			act(() => {
				textarea.dispatchEvent(event);
			});
			expect(event.defaultPrevented).toBe(false);
		}
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setValue.call(textarea, `${textarea.value}\nnext line`);
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(textarea.value).toContain("\nnext line");
		act(() => {
			textarea.focus();
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});
		expect(document.activeElement).toBe(textarea.parentElement);
		mounted.cleanup();
	});

	it("drags an element by its text, snaps it, and edits on a second click", () => {
		// The textarea filled the element and stopped every press, so no text
		// element could be dragged.
		const mounted = mountEditor();
		const stage = mounted.container.querySelector(".slides-editor-stage")!;
		const title = stage.querySelector<HTMLElement>('[data-element="title"]')!;
		const textarea = title.querySelector("textarea")!;
		const pointer = (
			type: string,
			clientX: number,
			clientY: number,
			init: PointerEventInit = {},
		) => {
			const event = new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				button: 0,
				pointerId: 1,
				clientX,
				clientY,
				...init,
			});
			act(() => {
				textarea.dispatchEvent(event);
			});
			return event;
		};
		const committedTitle = () =>
			mounted.emitted.at(-1)?.deck?.slides[0]?.elements[0];

		// A click selects without editing the document or focusing the text.
		pointer("pointerdown", 10, 10);
		pointer("pointerup", 10, 10);
		expect(title.dataset.selected).toBe("true");
		expect(document.activeElement).not.toBe(textarea);
		expect(mounted.emitted).toEqual([]);

		// Movement within the drag threshold is still a click: it edits the text.
		const press = pointer("pointerdown", 10, 10);
		expect(press.defaultPrevented).toBe(true);
		pointer("pointermove", 12, 12);
		pointer("pointerup", 12, 12);
		expect(mounted.emitted).toEqual([]);
		expect(document.activeElement).toBe(textarea);
		// While editing, presses and spaces reach the textarea untouched.
		expect(pointer("pointerdown", 10, 10).defaultPrevented).toBe(false);
		pointer("pointerup", 10, 10);
		const space = new KeyboardEvent("keydown", {
			key: " ",
			bubbles: true,
			cancelable: true,
		});
		act(() => {
			textarea.dispatchEvent(space);
		});
		expect(space.defaultPrevented).toBe(false);
		act(() => {
			textarea.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
		});

		// A drag moves the title (72, 64) by the pointer delta.
		pointer("pointerdown", 0, 0);
		pointer("pointermove", 40, 37);
		pointer("pointerup", 40, 37);
		expect(committedTitle()).toMatchObject({ x: 112, y: 101 });

		// Near the bullets' left edge (96) it snaps and draws a guide; Alt frees it.
		pointer("pointerdown", 0, 0);
		pointer("pointermove", -12, 0);
		expect(
			stage.querySelector<HTMLElement>('[data-snap-guide="vertical"]')?.style
				.left,
		).toBe(`${(96 / 1200) * 100}%`);
		pointer("pointerup", -12, 0);
		expect(committedTitle()).toMatchObject({ x: 96, y: 101 });
		expect(stage.querySelector("[data-snap-guide]")).toBeNull();
		pointer("pointerdown", 0, 0);
		pointer("pointermove", 4, 0, { altKey: true });
		pointer("pointerup", 4, 0, { altKey: true });
		expect(committedTitle()).toMatchObject({ x: 100 });
		mounted.cleanup();
	});

	it("keeps element shortcuts off menus and wires undo to the keyboard", () => {
		const mounted = mountEditor();
		const stage = mounted.container.querySelector(".slides-editor-stage")!;
		const element = stage.querySelector<HTMLElement>("[data-slide-element]")!;
		const press = (target: Element, init: KeyboardEventInit) => {
			const event = new KeyboardEvent("keydown", {
				bubbles: true,
				cancelable: true,
				...init,
			});
			act(() => {
				target.dispatchEvent(event);
			});
			return event;
		};
		press(element, { key: "Enter" });
		const count = () => stage.querySelectorAll("[data-slide-element]").length;
		const before = count();
		// Backspace on a toolbar control must not delete the selected element.
		const undo = mounted.container.querySelector('[aria-label="Undo"]')!;
		press(undo, { key: "Backspace" });
		expect(count()).toBe(before);
		press(element, { key: "Delete" });
		expect(count()).toBe(before - 1);
		press(mounted.container.querySelector(".slides-editor")!, {
			key: "z",
			ctrlKey: true,
		});
		expect(count()).toBe(before);
		mounted.cleanup();
	});

	it("keeps the slide rail open while an element is inspected", () => {
		const mounted = mountEditor();
		const element = mounted.container.querySelector<HTMLElement>(
			".slides-editor-stage [data-slide-element]",
		)!;
		act(() => element.click());
		const layout = mounted.container.querySelector(".slides-editor-layout")!;
		expect(layout.hasAttribute("data-show-inspector")).toBe(false);
		act(() =>
			mounted.container
				.querySelector<HTMLButtonElement>('[aria-label="Inspector"]')!
				.click(),
		);
		expect(layout.hasAttribute("data-show-thumbnails")).toBe(true);
		expect(layout.hasAttribute("data-show-inspector")).toBe(true);
		expect(
			mounted.container.querySelector<HTMLElement>(".slides-editor-thumbnails")
				?.hidden,
		).toBe(false);
		// Both panes at once have their own three-column track.
		const css = readFileSync("src/styles.css", "utf8");
		expect(css).toMatch(
			/\.slides-editor-layout\[data-show-thumbnails\]\[data-show-inspector\] \{\n\t\tgrid-template-columns: 11rem minmax\(0, 1fr\) 15rem;/,
		);
		// The inspector scrolls inside its panel; the action row stays outside it.
		expect(
			mounted.container
				.querySelector(".slide-inspector-scroll")
				?.className.includes("overflow-y-auto"),
		).toBe(true);
		expect(
			mounted.container.querySelector(
				".slide-inspector-scroll [aria-label='Delete element']",
			),
		).toBeNull();
		expect(
			mounted.container.querySelector(
				".slide-inspector-actions [aria-label='Delete element']",
			),
		).not.toBeNull();
		mounted.cleanup();
	});

	it("changes slides with the keyboard only while nothing is selected", () => {
		const mounted = mountEditor();
		const root =
			mounted.container.querySelector<HTMLElement>(".slides-editor")!;
		const stageText = () =>
			mounted.container.querySelector(".slides-editor-stage")?.textContent;
		const press = (target: Element, key: string) =>
			act(() => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", {
						key,
						bubbles: true,
						cancelable: true,
					}),
				);
			});
		press(root, "ArrowRight");
		expect(stageText()).toContain("Q4");
		press(root, "Home");
		expect(stageText()).toContain("Q3");
		press(root, "End");
		expect(stageText()).toContain("Q4");
		press(root, "PageUp");
		expect(stageText()).toContain("Q3");
		// With an element selected the arrows nudge it instead.
		const element = mounted.container.querySelector<HTMLElement>(
			".slides-editor-stage [data-slide-element]",
		)!;
		press(element, "Enter");
		press(element, "ArrowRight");
		expect(stageText()).toContain("Q3");
		// Browsing never edited the document; the one edit is the nudge.
		expect(mounted.emitted).toHaveLength(1);
		expect(mounted.emitted[0]?.deck?.slides[0]?.elements[0]?.x).toBe(73);
		// A click on the stage margin, outside the slide, clears the selection
		// and hands the keys back to slide navigation.
		const stage = mounted.container.querySelector<HTMLElement>(
			".slides-editor-stage",
		)!;
		act(() => {
			stage.dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
			);
			stage.click();
		});
		expect(element.dataset.selected).toBeUndefined();
		expect(document.activeElement).toBe(root);
		press(root, "ArrowRight");
		expect(stageText()).toContain("Q4");
		mounted.cleanup();
	});

	it("presents with F, jumps to a slide, shows notes, and unwinds Escape in order", () => {
		const mounted = mountEditor();
		const root =
			mounted.container.querySelector<HTMLElement>(".slides-editor")!;
		const key = (target: Element, value: string) =>
			act(() => {
				target.dispatchEvent(
					new KeyboardEvent("keydown", {
						key: value,
						bubbles: true,
						cancelable: true,
					}),
				);
			});
		// Select an element first, so Escape has a selection to clear.
		const element = mounted.container.querySelector<HTMLElement>(
			".slides-editor-stage [data-slide-element]",
		)!;
		act(() => element.click());
		key(root, "f");
		const dialog = () =>
			document.querySelector<HTMLElement>('[aria-label="Presentation mode"]');
		expect(dialog()).not.toBeNull();
		// Notes toggle shows the current slide's notes.
		const notes = Array.from(dialog()!.querySelectorAll("button")).find(
			(button) => button.textContent?.includes("Notes"),
		)!;
		act(() => notes.click());
		expect(
			dialog()!.querySelector('[aria-label="Speaker notes"]')?.textContent,
		).toBe("Pause");
		// The jump menu goes straight to a slide.
		act(() =>
			dialog()!
				.querySelector<HTMLButtonElement>('[aria-label="Jump to slide"]')!
				.click(),
		);
		act(() =>
			dialog()!
				.querySelector<HTMLButtonElement>('[aria-label="Slide 2: Q4"]')!
				.click(),
		);
		expect(dialog()!.textContent).toContain("2 / 2");
		// Escape: menu, then selection, then exit.
		act(() =>
			dialog()!
				.querySelector<HTMLButtonElement>('[aria-label="Jump to slide"]')!
				.click(),
		);
		key(dialog()!, "Escape");
		expect(dialog()!.querySelector('nav[aria-label="Slides"]')).toBeNull();
		expect(element.dataset.selected).toBe("true");
		key(dialog()!, "Escape");
		expect(dialog()).not.toBeNull();
		expect(
			mounted.container.querySelector("[data-slide-element][data-selected]"),
		).toBeNull();
		key(dialog()!, "Escape");
		expect(dialog()).toBeNull();
		// F toggles it back off as well.
		key(root, "f");
		expect(dialog()).not.toBeNull();
		key(dialog()!, "F");
		expect(dialog()).toBeNull();
		mounted.cleanup();
	});

	it("renders rail thumbnails through the one shared slide renderer", () => {
		// There used to be two renderers for one artifact: the read view used
		// `ReadOnlyElement` while this rail carried an inline `text-[4px]` span
		// that knew only background and colour -- no weight, alignment, opacity,
		// rotation or borders, and images did not render at all.
		const mounted = mountEditor();
		// The rail renders through the shared element renderer: slide text is
		// there, and no element is squeezed into a fixed 4px font.
		const thumbs = mounted.container.querySelectorAll(".slide-thumb-canvas");
		expect(thumbs[0]?.textContent).toContain("Q3");
		expect(
			mounted.container.querySelector(".slide-thumb-canvas .text-\\[4px\\]"),
		).toBeNull();
		const thumb = mounted.container.querySelector(".slide-thumb-canvas");
		expect(thumb).not.toBeNull();
		// The shared renderer sizes type in cqw, so each thumbnail must be its own
		// inline-size container or the type resolves against an ancestor.
		const css = readFileSync("src/styles.css", "utf8");
		const rule =
			css.match(
				/^\.slide-thumb-canvas,\n\.deck-read-thumb-canvas \{[^}]*\}/m,
			)?.[0] ?? "";
		expect(rule).toContain("container-type: inline-size");
		expect(rule).toContain("aspect-ratio: 16 / 9");
		mounted.cleanup();
	});
});

describe("slide regression sweep", () => {
	it("enters text editing on the first double-click without opening the inspector", () => {
		const mounted = mountEditor();
		const element = mounted.container.querySelector<HTMLElement>(
			'.slides-editor-stage [data-element="title"]',
		)!;
		const textarea = element.querySelector("textarea")!;
		const layout = mounted.container.querySelector(".slides-editor-layout")!;
		for (let click = 0; click < 2; click++) {
			act(() =>
				textarea.dispatchEvent(
					new PointerEvent("pointerdown", {
						bubbles: true,
						button: 0,
						clientX: 10,
						clientY: 10,
					}),
				),
			);
			act(() =>
				textarea.dispatchEvent(
					new PointerEvent("pointerup", {
						bubbles: true,
						button: 0,
						clientX: 10,
						clientY: 10,
					}),
				),
			);
			act(() => element.click());
			expect(layout.hasAttribute("data-show-inspector")).toBe(false);
		}
		act(() =>
			textarea.dispatchEvent(
				new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }),
			),
		);
		expect(document.activeElement).toBe(textarea);
		expect(mounted.emitted).toEqual([]);
		mounted.cleanup();
	});
	it("limits hover outlines to interactive editor elements", () => {
		const css = readFileSync("src/styles.css", "utf8");
		const selector = css.slice(
			css.indexOf("/* Hover marks"),
			css.indexOf("/* Press feedback"),
		);
		const mounted = mountEditor();
		const editor = mounted.container.querySelector(".slides-editor")!;
		act(() =>
			editor.dispatchEvent(
				new KeyboardEvent("keydown", { key: "f", bubbles: true }),
			),
		);
		const presented = mounted.container.querySelectorAll(
			".slides-present [data-slide-element]",
		);
		expect(presented.length).toBeGreaterThan(0);
		expect(selector).toContain('[tabindex="0"]');
		for (const element of presented)
			expect(element.hasAttribute("tabindex")).toBe(false);
		mounted.cleanup();
	});
});
