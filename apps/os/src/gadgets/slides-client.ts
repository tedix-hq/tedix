import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	slideBackgroundMarkup,
	slideElementMarkup,
	slideElementStyle,
	slideThemeFontFamily,
	type PresentationAppearance,
} from "@tedix/api-contract/utils/presentation-style";
import {
	applySlideElementAction,
	slideElementShortcut,
	type SlideElementAction,
} from "../lib/slide-element-actions";
import { computeSnapTargets, applySnap } from "../lib/slide-snap";
import { ensureSlideFontLoaded } from "../lib/slide-fonts";
import {
	fileToSlideImageSource,
	slideImageFile,
} from "../lib/slide-image-upload";
import {
	svgMarkupFromSource,
	svgSourceFromMarkup,
} from "../lib/slide-svg-markup";
import {
	duplicateCanvasSlide,
	newCanvasSlide,
	newSlideElement,
	normalizePresentationContent,
	projectDeck,
	reorderSlide,
	updateElementGeometry,
	type PresentationContent,
} from "./slides-engine";
import { SLIDES_CSS } from "./slides-style";
import { EDITOR_ICON_CSS, editorIcon, iconButton } from "./editor-icons";
import {
	mergeOutputContent,
	type OutputMergePreference,
} from "@tedix/api-contract/utils/output-merge";
import { showMergeChoice } from "./merge-choice";

export interface SlidesClientBridge {
	call<T = unknown>(method: string, args?: unknown): Promise<T>;
}
type Saved = {
	output: { id: string; title: string; workspaceId: string };
	revision: { revision: number; content: PresentationContent };
};
type RetainedDraft = { revision: number; content: PresentationContent };
type Context = {
	workspaceId: string;
	role: string;
	settings: { slot: string };
	grants: { slot: string; operations: string[] }[];
	appearance?: PresentationAppearance;
};

export async function mountSlidesClient(
	root: HTMLElement,
	bridge: SlidesClientBridge,
) {
	const style = document.createElement("style");
	style.textContent = SLIDES_CSS + EDITOR_ICON_CSS;
	document.head.append(style);
	root.innerHTML = `<main class="slides-app" aria-label="Slides gadget">
<header><div class="slides-heading"><h1>Slides</h1><div class="slides-meta" hidden></div></div><div class="slides-status" role="status" aria-live="polite"></div><button id="reload">Reload saved presentation</button><select id="export-format" aria-label="Export format" title="Export format"><option value="pptx">PowerPoint</option><option value="pdf">PDF</option><option value="outline">Outline</option></select>${iconButton('id="export"', "Export", "download")}<button id="present">${editorIcon("play")} Present</button><button id="save" class="primary">Save</button></header><div class="slides-updates" role="status" aria-live="polite"></div>
<div class="slides-toolbar" role="toolbar" aria-label="Canvas tools">${iconButton('id="undo"', "Undo", "undo")}${iconButton('id="redo"', "Redo", "redo")}<span class="bar-divider" aria-hidden="true"></span><label title="What to add"><select id="element-type" aria-label="Element type"><option value="text">Text</option><option value="title">Title</option><option value="subtitle">Subtitle</option><option value="bullet">Bullets</option><option value="shape">Shape</option><option value="card">Card</option><option value="box">Box</option><option value="arrow">Arrow</option><option value="label">Label</option><option value="divider">Divider</option><option value="image">Image</option><option value="svg">SVG</option><option value="logo">Logo</option></select></label>${iconButton('id="insert"', "Add to slide", "plus")}${iconButton('id="upload"', "Upload image", "image")}<span class="bar-divider" aria-hidden="true"></span>${iconButton('id="duplicate-element"', "Duplicate element", "copy")}${iconButton('id="delete-element"', "Delete element", "trash")}${iconButton('id="backward"', "Send backward", "back")}${iconButton('id="forward"', "Bring forward", "front")}</div>
<div class="slides-layout"><aside class="slides-rail"><div class="slides-rail-tools">${iconButton('id="add-slide"', "Add slide", "plus")}${iconButton('id="duplicate-slide"', "Duplicate slide", "copy")}${iconButton('id="delete-slide"', "Delete slide", "trash")}${iconButton('id="slide-up"', "Move slide up", "up")}${iconButton('id="slide-down"', "Move slide down", "down")}</div><nav aria-label="Slides"></nav></aside>
<section class="slides-workspace"><div class="slides-stage" tabindex="0" aria-label="Slide canvas"></div><div class="slides-help">Select an element to move or resize it. Double-click text to write. Arrow keys move the selected element; Shift moves by 10 pixels. Drop or paste an image onto the canvas.</div><label class="slides-notes">Speaker notes<textarea id="notes" maxlength="10000"></textarea></label></section>
<aside class="slides-inspector" aria-label="Slide and element properties"><div id="properties"></div><h2>Layers</h2><div id="layers"></div></aside></div>
<input type="file" id="image-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
<section id="presenter" hidden aria-label="Presentation"><div class="slides-present-status"></div><div class="slides-present-stage"></div><div class="slides-present-controls"><button id="previous">Previous slide</button><span id="position"></span><button id="next">Next slide</button><button id="exit">Exit presentation</button></div></section></main>`;
	const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const button = (id: string) => find<HTMLButtonElement>(`#${id}`);
	const stage = find(".slides-stage"),
		nav = find("nav"),
		properties = find("#properties"),
		layers = find("#layers"),
		presenter = find("#presenter"),
		notes = find<HTMLTextAreaElement>("#notes"),
		status = find(".slides-status"),
		updates = find(".slides-updates");
	const context = await bridge.call<Context>("context");
	const slot = context.settings?.slot;
	if (!slot || !context.workspaceId)
		throw new Error("Presentation slot is not configured");
	const editable =
		(context.role === "owner" || context.role === "build") &&
		context.grants?.some(
			(grant) =>
				grant.slot === slot && grant.operations.includes("outputs.write"),
		);
	let loaded: Saved | undefined,
		deck: OsPresentationDeck | undefined,
		basis = 0,
		viewedId: string | undefined,
		selectedId: string | null = null;
	let dirty = false,
		busy = false,
		available = false,
		destroyed = false,
		discardPending = false,
		pendingRevision = 0,
		// A newer saved revision that overlaps the draft, waiting for a choice.
		choice = 0;
	let draftWrites: Promise<void> = Promise.resolve();
	let history: OsPresentationDeck[] = [],
		future: OsPresentationDeck[] = [];
	let pointer:
		| {
				id: number;
				x: number;
				y: number;
				original: OsPresentationElement;
				resize: boolean;
				changed: boolean;
		  }
		| undefined;
	let editing: HTMLTextAreaElement | undefined;
	const call = <T>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const read = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call<Saved>("readPresentation"));
	const message = (text: string, error = false) => {
		status.textContent = text;
		status.dataset.error = String(error);
	};
	const active = () =>
		deck?.slides.find((slide) => slide.id === viewedId) ??
		deck?.slides.find((slide) => slide.id === deck?.activeSlideId) ??
		deck?.slides[0];
	const selected = () =>
		active()?.elements.find((element) => element.id === selectedId);
	const draftArgs = () => ({ slot, outputId: loaded!.output.id });
	function parse(value: Saved) {
		if (
			value?.output?.workspaceId !== context.workspaceId ||
			value.revision?.content?.kind !== "presentation" ||
			!Number.isInteger(value.revision.revision) ||
			value.revision.revision < 1
		)
			throw new Error("Presentation response does not match this workspace");
		return value;
	}
	function controls() {
		const write = editable && available && !busy;
		for (const id of ["insert", "upload", "add-slide"])
			button(id).disabled = !write;
		button("save").disabled = !write || !dirty;
		button("reload").disabled = busy;
		button("undo").disabled = !write || !history.length;
		button("redo").disabled = !write || !future.length;
		button("present").disabled = !available || !active();
		button("export").disabled = busy || !available;
		for (const id of [
			"duplicate-element",
			"delete-element",
			"backward",
			"forward",
		])
			button(id).disabled = !write || !selected();
		for (const id of [
			"duplicate-slide",
			"delete-slide",
			"slide-up",
			"slide-down",
		])
			button(id).disabled = !write || !active();
		button("add-slide").disabled = !write || (deck?.slides.length ?? 0) >= 200;
		button("insert").disabled =
			!write || !active() || (active()?.elements.length ?? 0) >= 300;
		notes.disabled = !write || !active();
		properties
			.querySelectorAll<
				HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
			>("input,select,textarea")
			.forEach((input) => (input.disabled = !write));
	}
	function retainDraft() {
		if (!dirty || !deck || !loaded || !editable || destroyed)
			return Promise.resolve();
		// Post immediately: an iframe can disappear before a debounce or cleanup runs.
		const write = bridge
			.call("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: structuredClone(projectDeck(deck)),
			})
			.then(
				() => undefined,
				(error) => {
					if (!destroyed)
						message(
							`Unsaved changes remain in this tab. Draft recovery failed: ${error instanceof Error ? error.message : String(error)}`,
							true,
						);
				},
			);
		// The host applies messages synchronously in order; clear waits for every receipt.
		draftWrites = Promise.all([draftWrites, write]).then(() => undefined);
		return write;
	}
	async function clearDraft() {
		await draftWrites;
		await bridge.call("app.draft.clear", draftArgs());
	}

	function changed() {
		dirty = true;
		discardPending = false;
		button("reload").textContent = "Reload saved presentation";
		message("Unsaved changes");
		void retainDraft();
		controls();
	}
	function remember() {
		if (deck) {
			history.push(structuredClone(deck));
			if (history.length > 30) history.shift();
			future = [];
		}
	}
	function updateSlide(next: OsPresentationCanvasSlide) {
		deck = {
			...deck!,
			slides: deck!.slides.map((slide) =>
				slide.id === next.id ? next : slide,
			),
		};
	}
	function mutate(action: () => void) {
		if (!editable || !available || busy || !deck) return;
		remember();
		action();
		changed();
		render();
	}
	function updateElement(next: OsPresentationElement) {
		const slide = active();
		if (slide)
			updateSlide({
				...slide,
				elements: slide.elements.map((element) =>
					element.id === next.id ? next : element,
				),
			});
	}
	function elementAction(action: SlideElementAction) {
		const slide = active();
		if (!slide || !editable || busy || !available) return;
		const result = applySlideElementAction(action, slide, selectedId);
		if (!result) return;
		if (result.slide)
			mutate(() => {
				updateSlide(result.slide!);
				selectedId = result.selectedId;
			});
	}
	function cssBox(node: HTMLElement, element: OsPresentationElement) {
		Object.assign(
			node.style,
			slideElementStyle(element, "canvas", context.appearance, deck?.theme),
		);
		ensureSlideFontLoaded(slideThemeFontFamily(element, deck?.theme));
	}
	function paintCanvas(
		container: HTMLElement,
		slide: OsPresentationCanvasSlide | undefined,
		interactive = false,
	) {
		container.replaceChildren();
		container.style.background = slide?.background ?? "#ffffff";
		if (!slide) {
			const blank = document.createElement("div");
			blank.className = "slides-empty";
			blank.textContent = "Add a slide to begin your presentation.";
			container.append(blank);
			return;
		}
		const background = document.createElement("div");
		background.className = "slides-background";
		background.innerHTML = slideBackgroundMarkup(
			slide,
			"canvas",
			context.appearance,
		);
		container.append(background);
		for (const element of slide.elements) {
			const node = document.createElement("div");
			node.className = "slides-element";
			node.dataset.elementId = element.id;
			cssBox(node, element);
			node.innerHTML = slideElementMarkup(
				element,
				"canvas",
				context.appearance,
			);
			if (interactive) {
				node.tabIndex = 0;
				node.setAttribute("role", "button");
				node.setAttribute(
					"aria-label",
					`${element.type}: ${(element.text || element.props?.title || "Visual").slice(0, 80)}`,
				);
				node.setAttribute("aria-pressed", String(selectedId === element.id));
				node.onpointerdown = (event) => beginPointer(event, element, false);
				node.ondblclick = () => beginText(element);
				node.onkeydown = (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						selectedId = element.id;
						beginText(element);
					}
				};
				if (selectedId === element.id) {
					node.classList.add("selected");
					const handle = document.createElement("button");
					handle.className = "slides-resize";
					handle.setAttribute("aria-label", "Resize element");
					handle.onpointerdown = (event) => beginPointer(event, element, true);
					handle.disabled = !editable || busy;
					node.append(handle);
				}
			}
			container.append(node);
		}
	}
	function renderSlides() {
		nav.replaceChildren();
		deck?.slides.forEach((slide, index) => {
			const item = document.createElement("button");
			item.className = "slides-thumbnail";
			item.draggable = editable;
			item.setAttribute("aria-pressed", String(active()?.id === slide.id));
			item.setAttribute("aria-label", `Slide ${index + 1}: ${slide.name}`);
			const canvas = document.createElement("div");
			canvas.className = "slides-thumb-canvas";
			paintCanvas(canvas, slide);
			const label = document.createElement("span");
			label.textContent = `${index + 1}. ${slide.name}`;
			item.append(canvas, label);
			item.onclick = () => {
				commitText();
				viewedId = slide.id;
				selectedId = null;
				render();
			};
			item.ondragstart = (event) =>
				event.dataTransfer?.setData("application/x-tedix-slide", slide.id);
			item.ondragover = (event) => event.preventDefault();
			item.ondrop = (event) => {
				const id = event.dataTransfer?.getData("application/x-tedix-slide");
				if (!id) return;
				event.preventDefault();
				mutate(() => {
					deck = reorderSlide(
						deck!,
						deck!.slides.findIndex((row) => row.id === id),
						index,
					);
				});
			};
			nav.append(item);
		});
	}
	function field(
		label: string,
		value: string | number,
		change: (value: string) => void,
		options?: {
			type?: string;
			min?: number;
			max?: number;
			step?: string;
			choices?: string[];
			multiline?: boolean;
		},
	) {
		const wrapper = document.createElement("label");
		wrapper.textContent = label;
		const input = options?.choices
			? document.createElement("select")
			: options?.multiline
				? document.createElement("textarea")
				: document.createElement("input");
		input.setAttribute("aria-label", label);
		if (input instanceof HTMLSelectElement)
			for (const option of options!.choices!) {
				const node = document.createElement("option");
				node.value = option;
				node.textContent = option;
				input.append(node);
			}
		if (input instanceof HTMLInputElement) {
			input.type = options?.type ?? "text";
			if (options?.min !== undefined) input.min = String(options.min);
			if (options?.max !== undefined) input.max = String(options.max);
			if (options?.step) input.step = options.step;
		}
		input.value = String(value);
		input.onchange = () => {
			if (input instanceof HTMLInputElement && !input.checkValidity()) {
				message(`${label} is outside the allowed range.`, true);
				return;
			}
			change(input.value);
		};
		wrapper.append(input);
		properties.append(wrapper);
		return input;
	}
	function renderProperties() {
		properties.replaceChildren();
		const slide = active(),
			element = selected();
		if (!slide) return;
		const heading = document.createElement("h2");
		heading.textContent = element
			? `${element.type} properties`
			: "Slide properties";
		properties.append(heading);
		if (element) {
			const change = (key: keyof OsPresentationElement, value: unknown) =>
				mutate(() => updateElement({ ...element, [key]: value }));
			field("Text", element.text ?? "", (value) => change("text", value), {
				multiline: true,
			});
			for (const key of ["x", "y", "width", "height"] as const)
				field(
					key.toUpperCase(),
					element[key],
					(value) =>
						mutate(() =>
							updateElement(
								updateElementGeometry(element, { [key]: Number(value) }),
							),
						),
					{
						type: "number",
						min: key === "width" || key === "height" ? 1 : 0,
						max: key === "x" || key === "width" ? 1200 : 675,
					},
				);
			const styleField = (
				label: string,
				key: keyof OsPresentationElement["style"],
				fallback: string | number,
				options?: Parameters<typeof field>[3],
			) =>
				field(
					label,
					element.style[key] ?? fallback,
					(value) =>
						mutate(() =>
							updateElement({
								...element,
								style: {
									...element.style,
									[key]: options?.type === "number" ? Number(value) : value,
								},
							}),
						),
					options,
				);
			styleField("Font family", "fontFamily", "Arial, sans-serif");
			styleField("Font size", "fontSize", 24, {
				type: "number",
				min: 8,
				max: 180,
			});
			styleField("Font weight", "fontWeight", "normal", {
				choices: ["light", "normal", "medium", "semibold", "bold"],
			});
			styleField("Text alignment", "textAlign", "left", {
				choices: ["left", "center", "right"],
			});
			styleField("Vertical alignment", "verticalAlign", "top", {
				choices: ["top", "middle", "bottom"],
			});
			styleField("Text color", "color", "#111111");
			styleField("Fill", "background", "transparent");
			styleField("Border color", "borderColor", "#000000");
			styleField("Border width", "borderWidth", 0, {
				type: "number",
				min: 0,
				max: 24,
			});
			styleField("Corner radius", "borderRadius", 0, {
				type: "number",
				min: 0,
				max: 200,
			});
			styleField("Opacity", "opacity", 1, {
				type: "number",
				min: 0,
				max: 1,
				step: "0.05",
			});
			styleField("Rotation", "rotation", 0, {
				type: "number",
				min: -360,
				max: 360,
			});
			styleField("Padding", "padding", 0, { type: "number", min: 0, max: 200 });
			styleField("Line height", "lineHeight", 1.3, {
				type: "number",
				min: 0.1,
				max: 10,
				step: "0.1",
			});
			styleField("Letter spacing", "letterSpacing", 0, {
				type: "number",
				min: -50,
				max: 100,
				step: "0.5",
			});
			if (element.type === "image" || element.type === "svg") {
				field("Image source", element.src ?? "", (value) =>
					change("src", value),
				);
				styleField("Image fit", "fit", "contain", {
					choices: ["contain", "cover"],
				});
			}
			if (element.type === "svg")
				field(
					"SVG markup",
					svgMarkupFromSource(element.src),
					(value) => {
						const result = svgSourceFromMarkup(value);
						if (result.ok) change("src", result.src);
						else message(result.error, true);
					},
					{ multiline: true },
				);
			const propsField = (
				label: string,
				key: keyof NonNullable<OsPresentationElement["props"]>,
				fallback: string,
				choices?: string[],
			) =>
				field(
					label,
					String(element.props?.[key] ?? fallback),
					(value) =>
						mutate(() =>
							updateElement({
								...element,
								props: { ...element.props, [key]: value },
							}),
						),
					choices ? { choices } : undefined,
				);
			if (element.type === "shape")
				propsField("Shape", "kind", "rectangle", ["rectangle", "ellipse"]);
			if (element.type === "card" || element.type === "box") {
				for (const key of ["eyebrow", "title", "body"] as const)
					propsField(`Card ${key}`, key, "");
				propsField("Tone", "tone", "neutral", [
					"neutral",
					"accent",
					"success",
					"warning",
					"danger",
					"info",
				]);
			}
			if (element.type === "arrow") {
				propsField("Arrow label", "label", "");
				for (const point of ["from", "to"] as const)
					for (const axis of ["x", "y"] as const)
						field(
							`${point} ${axis}`,
							element.props?.[point]?.[axis] ??
								(axis === "x" ? element.x : element.y),
							(value) =>
								mutate(() => {
									const fallback = { x: element.x, y: element.y };
									updateElement({
										...element,
										props: {
											...element.props,
											[point]: {
												...(element.props?.[point] ?? fallback),
												[axis]: Number(value),
											},
										},
									});
								}),
							{ type: "number", min: 0, max: axis === "x" ? 1200 : 675 },
						);
			}
		} else {
			field("Slide name", slide.name, (value) =>
				mutate(() =>
					updateSlide({
						...slide,
						name: value.trim().slice(0, 200) || "Untitled slide",
					}),
				),
			);
			field("Background", slide.background, (value) =>
				mutate(() => updateSlide({ ...slide, background: value })),
			);
			field("Background image", slide.backgroundImage ?? "", (value) =>
				mutate(() =>
					updateSlide({ ...slide, backgroundImage: value || undefined }),
				),
			);
			field(
				"Dot grid opacity",
				slide.dotGridOpacity ?? 0,
				(value) =>
					mutate(() =>
						updateSlide({ ...slide, dotGridOpacity: Number(value) }),
					),
				{ type: "number", min: 0, max: 1, step: "0.05" },
			);
			field("Inset surface color", slide.insetSurface?.color ?? "", (value) =>
				mutate(() =>
					updateSlide({
						...slide,
						insetSurface: value
							? {
									...slide.insetSurface,
									color: value,
									inset: slide.insetSurface?.inset ?? 24,
									radius: slide.insetSurface?.radius ?? 8,
								}
							: undefined,
					}),
				),
			);
			for (const key of ["headingFont", "bodyFont"] as const)
				field(
					key === "headingFont" ? "Deck heading font" : "Deck body font",
					deck?.theme?.[key] ?? "Arial, sans-serif",
					(value) =>
						mutate(() => {
							deck = { ...deck!, theme: { ...deck!.theme, [key]: value } };
						}),
				);
		}
		layers.replaceChildren();
		[...slide.elements].reverse().forEach((element) => {
			const item = document.createElement("button");
			item.textContent = `${element.type} · ${(element.text || element.props?.title || element.id).slice(0, 36)}`;
			item.setAttribute("aria-pressed", String(element.id === selectedId));
			item.onclick = () => {
				selectedId = element.id;
				render();
			};
			layers.append(item);
		});
	}
	function renderPresentation() {
		paintCanvas(find(".slides-present-stage"), active());
		find(".slides-present-status").textContent = dirty
			? "Draft presentation · unsaved changes"
			: "Saved";
		const index = deck!.slides.indexOf(active()!);
		find("#position").textContent = `${index + 1} / ${deck!.slides.length}`;
		button("previous").disabled = index <= 0;
		button("next").disabled = index >= deck!.slides.length - 1;
	}
	function render() {
		if (destroyed) return;
		paintCanvas(stage, active(), true);
		renderSlides();
		renderProperties();
		notes.value = active()?.notes ?? "";
		if (!presenter.hidden) renderPresentation();
		controls();
	}
	function selectSlide(index: number) {
		commitText();
		const slide = deck?.slides[index];
		if (!slide) return;
		viewedId = slide.id;
		selectedId = null;
		render();
	}
	function beginPointer(
		event: PointerEvent,
		element: OsPresentationElement,
		resize: boolean,
	) {
		if (event.button !== 0 || editing) return;
		event.preventDefault();
		event.stopPropagation();
		selectedId = element.id;
		// Keep the hit target mounted so a second click can enter text editing.
		for (const node of stage.querySelectorAll<HTMLElement>(
			"[data-element-id]",
		)) {
			const selected = node.dataset.elementId === selectedId;
			node.classList.toggle("selected", selected);
			node.setAttribute("aria-pressed", String(selected));
			node.querySelector(".slides-resize")?.remove();
			if (selected) {
				const handle = document.createElement("button");
				handle.className = "slides-resize";
				handle.setAttribute("aria-label", "Resize element");
				handle.onpointerdown = (event) => beginPointer(event, element, true);
				handle.disabled = !editable || busy;
				node.append(handle);
			}
		}
		renderProperties();
		controls();
		stage.focus({ preventScroll: true });
		if (!editable || busy || !available) return;
		pointer = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			original: structuredClone(element),
			resize,
			changed: false,
		};
		if (resize) stage.setPointerCapture?.(event.pointerId);
	}
	const onPointerMove = (event: PointerEvent) => {
		if (!pointer || event.pointerId !== pointer.id) return;
		const box = stage.getBoundingClientRect();
		if (!box.width) return;
		const dx = ((event.clientX - pointer.x) * 1200) / box.width,
			dy = ((event.clientY - pointer.y) * 675) / box.height;
		if (!pointer.changed && Math.abs(dx) + Math.abs(dy) < 1) return;
		if (!pointer.changed) {
			stage.setPointerCapture?.(event.pointerId);
			remember();
			pointer.changed = true;
		}
		const original = pointer.original;
		let next = updateElementGeometry(
			original,
			pointer.resize
				? { width: original.width + dx, height: original.height + dy }
				: { x: original.x + dx, y: original.y + dy },
		);
		if (!pointer.resize && !event.altKey) {
			const targets = computeSnapTargets(
				active()!.elements.filter((element) => element.id !== original.id),
				1200,
				675,
			);
			const snapped = applySnap(next, targets);
			next = updateElementGeometry(original, { x: snapped.x, y: snapped.y });
		}
		updateElement(next);
		const node = Array.from(
			stage.querySelectorAll<HTMLElement>("[data-element-id]"),
		).find((node) => node.dataset.elementId === next.id);
		if (node) cssBox(node, next);
		changed();
	};
	const endPointer = (event: PointerEvent) => {
		if (!pointer || event.pointerId !== pointer.id) return;
		const moved = pointer.changed;
		pointer = undefined;
		if (moved) render();
	};
	stage.addEventListener("pointermove", onPointerMove);
	stage.addEventListener("pointerup", endPointer);
	stage.addEventListener("pointercancel", endPointer);
	stage.onpointerdown = (event) => {
		if (
			event.target === stage ||
			(event.target as HTMLElement).classList.contains("slides-background")
		) {
			commitText();
			selectedId = null;
			render();
		}
	};
	function beginText(element: OsPresentationElement) {
		if (
			!editable ||
			busy ||
			!available ||
			["image", "svg", "shape", "divider", "arrow", "logo"].includes(
				element.type,
			)
		)
			return;
		commitText();
		selectedId = element.id;
		render();
		const node = Array.from(
			stage.querySelectorAll<HTMLElement>("[data-element-id]"),
		).find((node) => node.dataset.elementId === element.id)!;
		const input = document.createElement("textarea");
		input.className = "slides-inline-editor";
		input.setAttribute("aria-label", "Edit canvas text");
		input.value = element.text ?? "";
		node.replaceChildren(input);
		editing = input;
		input.focus();
		input.select();
		let remembered = false;
		input.onpointerdown = (event) => event.stopPropagation();
		input.oninput = () => {
			if (!remembered) {
				remember();
				remembered = true;
			}
			updateElement({ ...selected()!, text: input.value });
			changed();
		};
		input.onblur = () => {
			if (editing === input) {
				editing = undefined;
				render();
			}
		};
		input.onkeydown = (event) => {
			event.stopPropagation();
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				void save();
				return;
			}
			if (
				event.key === "Escape" ||
				((event.metaKey || event.ctrlKey) && event.key === "Enter")
			) {
				event.preventDefault();
				input.blur();
			}
		};
	}
	function commitText() {
		if (editing) {
			const input = editing;
			editing = undefined;
			input.blur();
		}
	}
	async function load(discard = false) {
		busy = true;
		controls();
		message("Loading presentation…");
		try {
			const value = parse(await read());
			if (destroyed) return;
			loaded = value;
			choice = 0;
			let retained: RetainedDraft | null = null;
			if (editable) {
				if (discard) await clearDraft();
				else
					retained = await bridge.call<RetainedDraft | null>(
						"app.draft.read",
						draftArgs(),
					);
			}
			if (
				retained &&
				(retained.content?.kind !== "presentation" ||
					!Number.isInteger(retained.revision) ||
					retained.revision < 1)
			)
				throw new Error("Retained presentation draft is invalid");
			deck = structuredClone(
				normalizePresentationContent(
					retained?.content ?? value.revision.content,
				).deck!,
			);
			basis = retained?.revision ?? value.revision.revision;
			dirty = !!retained;
			available = true;
			history = [];
			future = [];
			discardPending = false;
			selectedId = null;
			find("h1").textContent = value.output.title;
			find(".slides-meta").textContent =
				`Presentation revision ${value.revision.revision} · Slides canvas`;
			message(
				retained
					? "Restored your unsaved changes"
					: `Saved${editable ? "" : " · Read only"}`,
			);
			render();
		} catch (error) {
			available = false;
			if (
				loaded &&
				editable &&
				/denied|forbidden|not_permitted/i.test(
					error instanceof Error ? error.message : String(error),
				)
			)
				await clearDraft().catch(() => undefined);
			stage.replaceChildren();
			nav.replaceChildren();
			properties.replaceChildren();
			layers.replaceChildren();
			notes.value = "";
			presenter.hidden = true;
			find(".slides-present-stage").replaceChildren();
			message(error instanceof Error ? error.message : String(error), true);
		} finally {
			busy = false;
			controls();
			refreshExternal();
		}
	}
	async function save() {
		commitText();
		if (!dirty) return true;
		if (!editable || !available || busy || !deck) return false;
		busy = true;
		controls();
		message("Saving presentation…");
		try {
			const result = parse(
				await bridge.call<Saved>("outputs.replace", {
					slot,
					content: projectDeck(deck),
					expectedRevision: basis,
				}),
			);
			if (destroyed) return false;
			loaded = result;
			basis = result.revision.revision;
			deck = structuredClone(
				normalizePresentationContent(result.revision.content).deck!,
			);
			dirty = false;
			await clearDraft();
			message("Saved");
			find(".slides-meta").textContent =
				`Presentation revision ${basis} · Slides canvas`;
			render();
			return true;
		} catch (error) {
			await retainDraft();
			message(
				`${error instanceof Error ? error.message : String(error)}. Your canvas draft is preserved; reload only when ready to discard it.`,
				true,
			);
			return false;
		} finally {
			busy = false;
			controls();
			refreshExternal();
		}
	}
	function refreshExternal() {
		if (!loaded || busy || destroyed) return;
		if (dirty && choice > basis)
			return showMergeChoice(
				updates,
				choice,
				(prefer) => void mergeLatest(prefer),
			);
		if (pendingRevision <= basis) {
			pendingRevision = 0;
			updates.textContent = "";
			return;
		}
		updates.textContent = `Revision ${pendingRevision} is available.${dirty ? " Your canvas draft is preserved; it merges with the saved presentation." : " Loading saved presentation…"}`;
		if (!dirty) {
			pendingRevision = 0;
			void load();
		} else if (pendingRevision > choice) void mergeLatest();
	}
	/**
	 * Bring someone else's newer save into the unsaved canvas. Only a draft
	 * started from the revision this editor loaded can merge here; an older
	 * retained draft merges on the server when it is saved.
	 */
	async function mergeLatest(prefer?: OutputMergePreference) {
		if (
			!loaded ||
			!deck ||
			!dirty ||
			busy ||
			destroyed ||
			pointer ||
			editing ||
			basis !== loaded.revision.revision
		)
			return;
		busy = true;
		controls();
		try {
			const latest = parse(await read());
			if (destroyed) return;
			// Never retry in a loop: the next change notice or save tries again.
			pendingRevision = 0;
			if (latest.revision.revision <= basis) return;
			const result = mergeOutputContent(
				normalizePresentationContent(loaded.revision.content),
				projectDeck(deck),
				normalizePresentationContent(latest.revision.content),
				{ prefer, presentationSlides: (merged) => projectDeck(merged).slides },
			);
			if (!result.ok) {
				choice = latest.revision.revision;
				return;
			}
			choice = 0;
			loaded = latest;
			basis = latest.revision.revision;
			deck = structuredClone(
				normalizePresentationContent(result.content as PresentationContent)
					.deck!,
			);
			// Undo steps were taken against the old canvas; replaying them would
			// silently revert the other person's changes.
			history = [];
			future = [];
			find(".slides-meta").textContent =
				`Presentation revision ${basis} · Slides canvas`;
			message(
				`Unsaved changes · merged with revision ${basis}${prefer ? `; kept ${prefer === "mine" ? "your" : "their"} version where you both edited` : ""}`,
			);
			render();
			void retainDraft();
		} catch (error) {
			message(
				`${error instanceof Error ? error.message : String(error)}. Your canvas draft is preserved.`,
				true,
			);
			pendingRevision = 0;
		} finally {
			busy = false;
			controls();
			refreshExternal();
		}
	}
	const onMessage = (event: MessageEvent) => {
		if (
			event.source !== window.parent ||
			event.data?.jsonrpc !== "2.0" ||
			event.data.method !== "tedix/outputs-changed" ||
			!Array.isArray(event.data.params?.outputs)
		)
			return;
		for (const row of event.data.params.outputs)
			if (
				row.slot === slot &&
				row.outputId === loaded?.output.id &&
				Number.isInteger(row.revision)
			)
				pendingRevision = Math.max(pendingRevision, row.revision);
		refreshExternal();
	};
	window.addEventListener("message", onMessage);
	button("save").onclick = () => void save();
	button("reload").onclick = () => {
		commitText();
		if (dirty && !discardPending) {
			discardPending = true;
			button("reload").textContent = "Discard draft & reload";
			message(
				"Reload discards your unsaved presentation. Click again to confirm.",
				true,
			);
			return;
		}
		void load(true);
	};
	button("undo").onclick = () => {
		if (!deck || !history.length || !editable || busy) return;
		future.push(structuredClone(deck));
		deck = history.pop()!;
		changed();
		render();
	};
	button("redo").onclick = () => {
		if (!deck || !future.length || !editable || busy) return;
		history.push(structuredClone(deck));
		deck = future.pop()!;
		changed();
		render();
	};
	button("insert").onclick = () =>
		mutate(() => {
			const slide = active()!;
			const type = find<HTMLSelectElement>("#element-type")
				.value as OsPresentationElementType;
			const element = newSlideElement(type, slide.elements.length);
			updateSlide({ ...slide, elements: [...slide.elements, element] });
			selectedId = element.id;
		});
	for (const [id, action] of [
		["duplicate-element", "duplicate"],
		["delete-element", "delete"],
		["backward", "backward"],
		["forward", "forward"],
	] as const)
		button(id).onclick = () => elementAction(action);
	button("add-slide").onclick = () =>
		mutate(() => {
			const slide = newCanvasSlide();
			deck = {
				...deck!,
				activeSlideId: slide.id,
				slides: [...deck!.slides, slide],
			};
			viewedId = slide.id;
			selectedId = null;
		});
	button("duplicate-slide").onclick = () =>
		mutate(() => {
			const slide = duplicateCanvasSlide(active()!);
			const slides = [...deck!.slides];
			slides.splice(slides.indexOf(active()!) + 1, 0, slide);
			deck = { ...deck!, activeSlideId: slide.id, slides };
			viewedId = slide.id;
			selectedId = null;
		});
	button("delete-slide").onclick = () =>
		mutate(() => {
			const current = active()!,
				index = deck!.slides.indexOf(current),
				slides = deck!.slides.filter((slide) => slide.id !== current.id);
			viewedId = slides[Math.min(index, slides.length - 1)]?.id;
			deck = { ...deck!, slides, activeSlideId: viewedId ?? "empty-deck" };
			selectedId = null;
		});
	for (const [id, direction] of [
		["slide-up", -1],
		["slide-down", 1],
	] as const)
		button(id).onclick = () =>
			mutate(() => {
				const index = deck!.slides.indexOf(active()!);
				deck = reorderSlide(deck!, index, index + direction);
			});
	notes.onchange = () =>
		mutate(() => updateSlide({ ...active()!, notes: notes.value }));
	async function insertImage(file: File) {
		if (!editable || !available || busy || !active()) return;
		try {
			const src = await fileToSlideImageSource(file);
			mutate(() => {
				const slide = active()!,
					element = newSlideElement(
						file.type === "image/svg+xml" ? "svg" : "image",
						slide.elements.length,
					);
				element.src = src;
				element.text = file.name;
				updateSlide({ ...slide, elements: [...slide.elements, element] });
				selectedId = element.id;
			});
		} catch (error) {
			message(error instanceof Error ? error.message : String(error), true);
		}
	}
	const imageInput = find<HTMLInputElement>("#image-file");
	button("upload").onclick = () => imageInput.click();
	imageInput.onchange = () => {
		const file = imageInput.files?.[0];
		if (file) void insertImage(file);
		imageInput.value = "";
	};
	stage.ondragover = (event) => {
		event.preventDefault();
	};
	stage.ondrop = (event) => {
		const file = slideImageFile(event.dataTransfer);
		if (file) {
			event.preventDefault();
			void insertImage(file);
		}
	};
	const onPaste = (event: ClipboardEvent) => {
		const target = event.target as HTMLElement;
		if (target.closest("input,textarea,[contenteditable=true]")) return;
		const file = slideImageFile(event.clipboardData);
		if (file) {
			event.preventDefault();
			void insertImage(file);
		}
	};
	root.addEventListener("paste", onPaste);
	button("present").onclick = () => {
		commitText();
		presenter.hidden = false;
		renderPresentation();
		button("exit").focus();
	};
	button("exit").onclick = () => {
		presenter.hidden = true;
		render();
		button("present").focus();
	};
	button("previous").onclick = () =>
		selectSlide(deck!.slides.indexOf(active()!) - 1);
	button("next").onclick = () =>
		selectSlide(deck!.slides.indexOf(active()!) + 1);
	button("export").onclick = async () => {
		if (busy || !available) return;
		if (dirty && !(await save())) return;
		busy = true;
		controls();
		const format = find<HTMLSelectElement>("#export-format").value;
		message(`Exporting ${format.toUpperCase()}…`);
		try {
			if (format === "outline") {
				const result = await call<{
					title: string;
					mimeType: string;
					text: string;
				}>("exportOutline");
				await bridge.call("app.download", {
					filename: `${result.title.replace(/[\\/:*?"<>|]/g, "_")}.md`,
					mimeType: result.mimeType,
					text: result.text,
				});
			} else
				await bridge.call("app.exportOutput", {
					slot,
					format,
					expectedRevision: basis,
				});
			message(`Exported saved revision ${basis} · ${format.toUpperCase()}`);
		} catch (error) {
			message(
				`Export failed: ${error instanceof Error ? error.message : String(error)}`,
				true,
			);
		} finally {
			busy = false;
			controls();
			refreshExternal();
		}
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void save();
			return;
		}
		const target = event.target as HTMLElement;
		if (target.closest("input,textarea,select,[contenteditable=true]")) return;
		if (!presenter.hidden) {
			if (event.key === "Escape") {
				event.preventDefault();
				button("exit").click();
			} else if (event.key === "ArrowRight" || event.key === "PageDown") {
				event.preventDefault();
				button("next").click();
			} else if (event.key === "ArrowLeft" || event.key === "PageUp") {
				event.preventDefault();
				button("previous").click();
			}
			return;
		}

		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
			event.preventDefault();
			button(event.shiftKey ? "redo" : "undo").click();
			return;
		}
		const action = slideElementShortcut(event);
		if (action) {
			event.preventDefault();
			elementAction(action);
			return;
		}
		if (event.key === "Escape") {
			selectedId = null;
			render();
			return;
		}
		if ((event.key === "Delete" || event.key === "Backspace") && selected()) {
			event.preventDefault();
			elementAction("delete");
			return;
		}
		const delta = event.shiftKey ? 10 : 1,
			element = selected();
		if (
			element &&
			["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
		) {
			event.preventDefault();
			mutate(() =>
				updateElement(
					updateElementGeometry(element, {
						x:
							element.x +
							(event.key === "ArrowRight"
								? delta
								: event.key === "ArrowLeft"
									? -delta
									: 0),
						y:
							element.y +
							(event.key === "ArrowDown"
								? delta
								: event.key === "ArrowUp"
									? -delta
									: 0),
					}),
				),
			);
		}
	};
	root.addEventListener("keydown", onKeyDown);
	await load();
	return {
		save,
		destroy() {
			destroyed = true;
			window.removeEventListener("message", onMessage);
			root.removeEventListener("keydown", onKeyDown);
			root.removeEventListener("paste", onPaste);
			stage.removeEventListener("pointermove", onPointerMove);
			stage.removeEventListener("pointerup", endPointer);
			stage.removeEventListener("pointercancel", endPointer);
			style.remove();
		},
	};
}
