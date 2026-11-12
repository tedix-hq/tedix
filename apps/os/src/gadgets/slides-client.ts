import type {
	OsPresentationCanvasSlide,
	OsPresentationDeck,
	OsPresentationElement,
	OsPresentationElementType,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	slideElementStyle,
	slideThemeFontFamily,
	type PresentationAppearance,
} from "@tedix/api-contract/utils/presentation-style";
import {
	applySlideElementAction,
	slideElementShortcut,
	type SlideElementAction,
} from "../lib/slide-element-actions";
import {
	computeSnapTargets,
	applySnap,
	type SnapTargets,
} from "../lib/slide-snap";
import { ensureSlideFontLoaded } from "../lib/slide-fonts";
import { createSlideLinkedImages } from "../lib/slide-linked-images";
import { isLargeEmbeddedImage } from "@tedix/api-contract/utils/os-output-assets";
import { lastingSaveFailure } from "../lib/save-failure";
import { createOutputSync } from "../lib/output-sync";
import {
	OS_DECK_MAX_SLIDES,
	OS_EDITOR_UNDO_STEPS,
	OS_SLIDE_MAX_ELEMENTS,
	OS_SLIDE_MAX_TEXT_CHARS,
} from "@tedix/api-contract/utils/os-output-limits";
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
import { EDITOR_ICON_CSS, editorIcon, type EditorIcon } from "./editor-icons";
import {
	mergeOutputContent,
	type OutputMergePreference,
} from "@tedix/api-contract/utils/output-merge";

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
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
type FieldOptions = {
	type?: string;
	min?: number;
	max?: number;
	step?: string;
	choices?: string[];
	multiline?: boolean;
	wide?: boolean;
};

/** Save this long after the last change, and never later than the maximum. */
/** Thumbnails drawn at once when a deck opens; the rest wait until seen. */
const EAGER_THUMBNAILS = 40;
/**
 * A save sends only what changed, so it follows a short pause in editing and
 * never waits long while someone keeps editing. A failed save that may pass
 * is tried again quickly at first, then less and less often.
 */
const SAVE_IDLE_MS = 220,
	SAVE_MAX_WAIT_MS = 1200,
	/** A save quicker than this stays silent. */
	SAVE_SLOW_MS = 900,
	SAVE_RETRY_MS = 40,
	SAVE_RETRY_MAX_MS = 10_000,
	/** While typing, the recovery draft is written at most this often. */
	DRAFT_TYPING_MS = 500,
	/** Repeated nudges within this window undo as one step. */
	GROUP_MS = 800,
	/** Screen pixels the pointer travels before a press becomes a drag. */
	DRAG_SLOP = 3,
	MIN_WIDTH = 40,
	MIN_HEIGHT = 24,
	EASE = "cubic-bezier(0.2,0.8,0.2,1)";

const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const NO_TEXT: OsPresentationElementType[] = [
	"image",
	"svg",
	"shape",
	"divider",
	"arrow",
	"logo",
];
const ELEMENT_NAMES: Record<OsPresentationElementType, string> = {
	text: "Text",
	title: "Title",
	subtitle: "Subtitle",
	bullet: "Bullets",
	shape: "Shape",
	card: "Card",
	box: "Box",
	arrow: "Arrow",
	label: "Label",
	divider: "Divider",
	image: "Image",
	svg: "SVG",
	logo: "Logo",
};
const INSERT_GROUPS: OsPresentationElementType[][] = [
	["text", "title", "subtitle", "bullet", "label"],
	["shape", "card", "box", "arrow", "divider"],
	["image", "svg", "logo"],
];
const EXPORTS = [
	["pptx", "PowerPoint"],
	["pdf", "PDF"],
	["outline", "Outline"],
] as const;

const glyph = (path: string) =>
	`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
const GLYPHS = {
	more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
	format: "M2.5 5h5M11 5h2.5M2.5 11H5M8.5 11h5M9 3.5v3M6.5 9.5v3",
	addSlide: "M2.5 3.5h11v9h-11zM8 6v4M6 8h4",
	insert: "M6.5 3v7M3 6.5h7M12 11l1.5 1.5L15 11",
	previous: "M10 3.5 5.5 8l4.5 4.5",
	next: "M6 3.5 10.5 8 6 12.5",
	close: "M4 4l8 8M12 4l-8 8",
};

function hexColor(value: string | undefined, fallback: string) {
	const text = (value ?? "").trim();
	if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
	if (/^#[0-9a-f]{3}$/i.test(text))
		return `#${[...text.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase();
	return fallback;
}
const DENIED = /denied|forbidden|not_permitted/i;
const reason = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

export async function mountSlidesClient(
	root: HTMLElement,
	bridge: SlidesClientBridge,
) {
	const mac = /Mac|iPhone|iPad/.test(navigator.platform ?? "");
	const keys = (key: string, shift = false) =>
		mac ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
	const tool = (
		id: string,
		label: string,
		icon: string,
		shortcut = "",
		attrs = "",
	) =>
		`<button id="${id}" class="icon" title="${label}${shortcut ? ` (${shortcut})` : ""}" aria-label="${label}" ${attrs}>${icon}</button>`;
	const icon = (name: EditorIcon) => editorIcon(name);
	const divider = '<span class="bar-divider" aria-hidden="true"></span>';
	const style = document.createElement("style");
	style.textContent = EDITOR_ICON_CSS + SLIDES_CSS;
	document.head.append(style);
	root.innerHTML = `<main class="slides-app" aria-label="Slides gadget" data-loading>
<header class="slides-bar"><div class="slides-bar-left"><h1>Slides</h1></div>
<div class="slides-bar-tools" role="toolbar" aria-label="Slide tools">${tool("undo", "Undo", icon("undo"), keys("Z"))}${tool("redo", "Redo", icon("redo"), keys("Z", true))}${divider}${tool("add-slide", "Add slide", glyph(GLYPHS.addSlide))}<span class="slides-menu-anchor">${tool("insert", "Insert", glyph(GLYPHS.insert), "", 'aria-haspopup="menu" aria-expanded="false"')}<div class="slides-menu" id="insert-menu" role="menu" aria-label="Insert" hidden>${INSERT_GROUPS.map(
		(group) =>
			group
				.map(
					(type) =>
						`<button role="menuitem" data-insert="${type}">${ELEMENT_NAMES[type]}</button>`,
				)
				.join(""),
	).join(
		"<hr>",
	)}</div></span>${tool("upload", "Upload image", icon("image"))}${divider}${tool("duplicate-element", "Duplicate", icon("copy"), keys("D"))}${tool("delete-element", "Delete", icon("trash"), "Delete")}${tool("backward", "Send backward", icon("back"))}${tool("forward", "Bring forward", icon("front"))}</div>
<div class="slides-bar-right"><span class="slides-save" role="img" hidden></span><div class="slides-status" role="status" aria-live="polite"></div><button id="format" class="ghost" title="Format (Enter)" aria-expanded="false" aria-controls="slides-inspector">${glyph(GLYPHS.format)} Format</button><button id="present" class="ghost primary">${icon("play")} Present</button><span class="slides-menu-anchor">${tool("more", "More", glyph(GLYPHS.more), "", 'aria-haspopup="menu" aria-expanded="false"')}<div class="slides-menu end" id="more-menu" role="menu" aria-label="More" hidden>${EXPORTS.map(
		([format, name]) =>
			`<button role="menuitem" data-export="${format}">Download as ${name}</button>`,
	).join("")}</div></span></div></header>
<div class="slides-updates" role="status" aria-live="polite"></div>
<div class="slides-layout"><aside class="slides-rail"><nav aria-label="Slides"><div class="slides-skeleton"></div><div class="slides-skeleton"></div><div class="slides-skeleton"></div></nav></aside>
<section class="slides-workspace"><div class="slides-canvas"><div class="slides-stage" tabindex="0" aria-label="Slide canvas" aria-describedby="slides-help"></div></div><p class="slides-sr" id="slides-help">Select an element to move or resize it. Double-click text to write. Arrow keys move the selected element; Shift moves by 10 pixels. Press Enter to format the selected element. Drop or paste an image onto the canvas.</p><label class="slides-notes"><span class="slides-sr">Speaker notes</span><textarea id="notes" maxlength="${OS_SLIDE_MAX_TEXT_CHARS}" placeholder="Speaker notes"></textarea></label></section>
<aside class="slides-inspector" id="slides-inspector" aria-label="Slide and element properties" data-open="false"><div class="slides-inspector-body"><div id="properties"></div><h2>Layers</h2><div id="layers"></div></div></aside></div>
<input type="file" id="image-file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" hidden>
<section id="presenter" hidden tabindex="-1" aria-label="Presentation"><div class="slides-present-stage"></div><div class="slides-present-pill" id="position" role="status" aria-live="polite"></div><div class="slides-present-controls">${tool("previous", "Previous slide", glyph(GLYPHS.previous), "←")}${tool("next", "Next slide", glyph(GLYPHS.next), "→")}${tool("exit", "Exit presentation", glyph(GLYPHS.close), "Esc")}</div></section></main>`;
	const find = <T extends HTMLElement = HTMLElement>(selector: string) =>
		root.querySelector<T>(selector)!;
	const button = (id: string) => find<HTMLButtonElement>(`#${id}`);
	const main = find(".slides-app"),
		stage = find(".slides-stage"),
		canvasArea = find(".slides-canvas"),
		nav = find("nav"),
		inspector = find(".slides-inspector"),
		properties = find("#properties"),
		layers = find("#layers"),
		presenter = find("#presenter"),
		presentStage = find(".slides-present-stage"),
		pill = find("#position"),
		notes = find<HTMLTextAreaElement>("#notes"),
		status = find(".slides-status"),
		saveMark = find(".slides-save"),
		updates = find(".slides-updates");
	const guides = document.createElement("div");
	guides.className = "slides-guides";
	const context = await bridge.call<Context>("context");
	const slot = context.settings?.slot;
	if (!slot || !context.workspaceId)
		throw new Error("Presentation slot is not configured");
	// The frame has no network: linked images and images stored with the file
	// are drawn from copies the host embeds. They are for display only and
	// never enter the presentation.
	const linked = createSlideLinkedImages(
		root,
		async (url) =>
			(await bridge.call<{ dataUrl: string }>("outputs.image", { slot, url }))
				.dataUrl,
	);
	/** Store an embedded image with the file; the deck names it by reference. */
	const storeImage = async (source: string) =>
		isLargeEmbeddedImage(source)
			? (
					await bridge.call<{ reference: string }>("outputs.uploadImage", {
						slot,
						dataUrl: source,
					})
				).reference
			: source;
	/** Apply a typed image source; a pasted embedded image is stored first. */
	const stored = (source: string, apply: (source: string) => void) => {
		if (!isLargeEmbeddedImage(source)) return apply(source);
		void storeImage(source).then(apply, (error) =>
			message(reason(error), true, 6000),
		);
	};
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
		loading = true,
		available = false,
		destroyed = false,
		exporting = false,
		pendingRevision = 0,
		// A newer saved revision that overlaps the unsaved edits, waiting for a choice.
		choice = 0,
		// Unsaved edits restored from an earlier visit that predate the saved
		// presentation; there is no shared starting point to merge from.
		stale = false;
	// Counts edits, so a finishing save knows whether newer ones are waiting.
	// `stuck` is the edit count of a save refused for good; -1 when none is.
	let stuck = -1;
	let edits = 0,
		saving: Promise<boolean> | undefined,
		saveTimer: ReturnType<typeof setTimeout> | undefined,
		unsavedSince = 0,
		failures = 0,
		retryAt = 0,
		saveError = "",
		reading = false;
	let draftWrites: Promise<void> = Promise.resolve(),
		draftTimer: ReturnType<typeof setTimeout> | undefined,
		draftAt = 0;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let history: OsPresentationDeck[] = [],
		future: OsPresentationDeck[] = [],
		group = "",
		groupAt = 0;
	let pointer:
		| {
				id: number;
				x: number;
				y: number;
				box: DOMRect;
				node: HTMLElement;
				original: OsPresentationElement;
				next?: OsPresentationElement;
				handle: Handle | null;
				targets?: SnapTargets;
		  }
		| undefined;
	let editing: HTMLTextAreaElement | undefined, editingId: string | undefined;
	let inspectorOpen = false,
		advancedOpen = false,
		inspectorKey = "",
		syncs: Array<() => void> = [];
	// What the stage and the rail currently show, so a change repaints only
	// the nodes whose slide or element actually changed.
	const stageNodes = new Map<
		string,
		{ node: HTMLElement; element?: OsPresentationElement }
	>();
	let stageSlideId: string | undefined,
		stageSlide: OsPresentationCanvasSlide | undefined,
		stageTheme: OsPresentationDeck["theme"],
		stageBackground: HTMLElement | undefined,
		freshId: string | undefined;
	const thumbs = new Map<
		string,
		{
			item: HTMLElement;
			select: HTMLButtonElement;
			number: HTMLElement;
			canvas: HTMLElement;
			slide?: OsPresentationCanvasSlide;
			theme?: OsPresentationDeck["theme"];
			label?: string;
			/** In or near the visible part of the slide list. */
			near?: boolean;
		}
	>();
	// A long deck draws the first thumbnails at once and the rest as they
	// come into view, so opening 500 slides does not draw 500 slides.
	const thumbWatch =
		typeof IntersectionObserver === "function"
			? new IntersectionObserver(
					(entries) => {
						for (const { target, isIntersecting } of entries) {
							const entry = thumbs.get(
								(target as HTMLElement).dataset.slideId ?? "",
							);
							if (!entry) continue;
							entry.near = isIntersecting;
							if (isIntersecting) paintThumb(entry);
						}
					},
					{ root: nav, rootMargin: "600px 0px" },
				)
			: undefined;
	function paintThumb(entry: {
		item: HTMLElement;
		canvas: HTMLElement;
		slide?: OsPresentationCanvasSlide;
		theme?: OsPresentationDeck["theme"];
	}) {
		const slide = deck?.slides.find(
			(row) => row.id === entry.item.dataset.slideId,
		);
		if (!slide || (entry.slide === slide && entry.theme === deck?.theme))
			return;
		paintCanvas(entry.canvas, slide);
		entry.slide = slide;
		entry.theme = deck?.theme;
	}
	let railOrder: string | undefined,
		railCurrent: string | undefined,
		presentedId: string | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined,
		pillTimer: ReturnType<typeof setTimeout> | undefined;

	const call = <T>(method: string, input: unknown = {}) =>
		bridge.call<T>("app.call", { method, args: [input] });
	// The host reads the bound Output directly; the app server is the fallback
	// for hosts that cannot (share links, older hosts).
	const read = () =>
		bridge
			.call<Saved>("outputs.readRevision", { slot })
			.catch(() => call<Saved>("readPresentation"));
	// Saves send only what changed and catching up fetches only what changed.
	const sync = createOutputSync<PresentationContent, Saved>(bridge, slot, {
		presentationSlides: (merged) => projectDeck(merged).slides,
	});
	const stillMotion = () =>
		window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
	/** Show a status line; a flash clears itself, anything else stays. */
	function message(text: string, error = false, flash = 0) {
		clearTimeout(statusTimer);
		status.textContent = text;
		status.dataset.error = String(error);
		if (flash) statusTimer = setTimeout(quiet, flash);
	}
	/** Nothing to report: empty unless a save is failing or editing is off. */
	function quiet() {
		message(saveError || (editable ? "" : "View only"), !!saveError);
		markSave();
	}
	/** The steady dot beside the status: whether the latest changes are stored. */
	function markSave() {
		const state = !canWrite()
			? ""
			: saveError
				? "failed"
				: saving
					? "saving"
					: dirty
						? "pending"
						: "saved";
		saveMark.hidden = !state;
		saveMark.dataset.state = state;
		saveMark.title =
			state === "failed"
				? `Not saved. ${saveError}`
				: state === "saving"
					? "Saving…"
					: state === "pending"
						? "Changes not saved yet"
						: "All changes saved";
		saveMark.setAttribute("aria-label", saveMark.title);
	}
	const canWrite = () => !!editable && available && !loading;
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
	const deckOf = (content: PresentationContent) =>
		structuredClone(normalizePresentationContent(content).deck!);

	// ---- Recovery draft and autosave ----

	function retainDraft() {
		clearTimeout(draftTimer);
		draftTimer = undefined;
		if (!dirty || !deck || !loaded || !editable || destroyed)
			return Promise.resolve();
		draftAt = Date.now();
		// Post right away: an iframe can disappear before a timer or cleanup runs.
		const write = bridge
			.call("app.draft.write", {
				...draftArgs(),
				revision: basis,
				content: projectDeck(deck),
			})
			.then(
				() => undefined,
				() => {
					if (!destroyed && !saveError)
						message(
							"Your latest changes could not be kept on this device. Keep this tab open until they are saved.",
							true,
						);
				},
			);
		// The host applies messages in order; clearing waits for every receipt.
		draftWrites = Promise.all([draftWrites, write]).then(() => undefined);
		return write;
	}
	async function clearDraft(discard = false) {
		await draftWrites;
		// An edit made while waiting has already posted a newer draft; keep it.
		if (dirty && !discard) return;
		await bridge.call("app.draft.clear", draftArgs());
	}
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (
			!dirty ||
			!canWrite() ||
			destroyed ||
			exporting ||
			reading ||
			choice ||
			stale ||
			// A drag or resize is one change: its save waits for it to end.
			pointer ||
			stuck === edits
		)
			return;
		const now = Date.now();
		unsavedSince ||= now;
		// After a failed save only the retry delay counts: the pause in editing
		// it waited for has already passed.
		const wait = Math.max(
			0,
			retryAt > now
				? retryAt - now
				: Math.min(SAVE_IDLE_MS, unsavedSince + SAVE_MAX_WAIT_MS - now),
		);
		saveTimer = setTimeout(() => void save(), wait);
	}
	function changed(typing = false) {
		dirty = true;
		edits++;
		markSave();
		if (!typing || Date.now() - draftAt >= DRAFT_TYPING_MS) void retainDraft();
		else
			draftTimer ??= setTimeout(
				() => void retainDraft(),
				DRAFT_TYPING_MS - (Date.now() - draftAt),
			);
		scheduleSave();
	}
	/**
	 * Save the presentation. Only one save runs at a time; edits made while it
	 * runs are picked up by the save that follows it.
	 */
	function save(asked = false): Promise<boolean> {
		if (saving) return saving.then(() => (dirty || asked ? save(asked) : true));
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (!dirty) {
			if (asked && canWrite() && !saveError) message("Saved", false, 1600);
			return Promise.resolve(true);
		}
		if (asked) stuck = -1;
		// A save never races a read that is about to change what it builds on,
		// and a refused save is not sent again unchanged.
		if (
			!canWrite() ||
			!deck ||
			reading ||
			choice ||
			stale ||
			(pointer && !asked) ||
			stuck === edits
		)
			return Promise.resolve(false);
		const run = send(asked).finally(() => {
			saving = undefined;
			if (destroyed) return;
			controls();
			scheduleSave();
			refreshExternal();
		});
		saving = run;
		markSave();
		return run;
	}
	async function send(asked: boolean) {
		const sent = edits;
		const slow = setTimeout(() => message("Saving…"), SAVE_SLOW_MS);
		try {
			const result = parse(
				await sync.save(projectDeck(deck!), basis, read, asked),
			);
			if (destroyed) return false;
			loaded = result;
			basis = result.revision.revision;
			main.dataset.revision = String(basis);
			failures = 0;
			retryAt = 0;
			saveError = "";
			stuck = -1;
			// A link typed since the last save can be read now.
			linked.retry();
			if (edits === sent) {
				dirty = false;
				unsavedSince = 0;
				await clearDraft();
				// Show exactly what was stored, unless someone is mid-gesture.
				if (!dirty && !pointer && !editing && deck) {
					const stored = deckOf(result.revision.content);
					if (JSON.stringify(stored) !== JSON.stringify(deck)) {
						deck = stored;
						render();
					}
				}
			} else {
				// Newer edits are waiting: keep them recoverable against this save.
				unsavedSince = Date.now();
				void retainDraft();
			}
			if (asked && !dirty) message("Saved", false, 1600);
			else quiet();
			return true;
		} catch (error) {
			if (destroyed) return false;
			failures++;
			retryAt =
				Date.now() +
				Math.min(SAVE_RETRY_MAX_MS, SAVE_RETRY_MS * 2 ** (failures - 1));
			await retainDraft();
			const lasting = DENIED.test(reason(error))
				? "You can no longer edit this presentation. Your latest changes are kept on this device."
				: lastingSaveFailure(error);
			if (lasting) {
				// The same presentation would be refused again: say why and wait
				// for the next change instead of trying again.
				saveError = lasting;
				stuck = sent;
				retryAt = 0;
			} else if (
				(error as { code?: unknown } | null)?.code === "revision_conflict" ||
				/conflict/i.test(reason(error))
			) {
				// Someone else saved first: bring their version in, then save again.
				pendingRevision = Math.max(pendingRevision, basis + 1);
			} else
				saveError =
					"Your latest changes are not saved yet. They are kept on this device and saving will try again.";
			quiet();
			return false;
		} finally {
			clearTimeout(slow);
		}
	}
	/** Save now rather than after the usual pause. */
	function flush(asked = false) {
		commitText();
		commitNotes();
		if (draftTimer) void retainDraft();
		if (asked) retryAt = 0;
		return save(asked);
	}

	// ---- Editing ----

	function remember() {
		if (!deck) return;
		history.push(deck);
		if (history.length > OS_EDITOR_UNDO_STEPS) history.shift();
		future = [];
	}
	function updateSlide(next: OsPresentationCanvasSlide) {
		deck = {
			...deck!,
			slides: deck!.slides.map((slide) =>
				slide.id === next.id ? next : slide,
			),
		};
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
	/**
	 * Apply one edit as one undo step. Edits that share a `together` name and
	 * follow each other closely (arrow-key nudges, dragging in a color picker)
	 * share a single step.
	 */
	function mutate(action: () => void, together = "") {
		if (!canWrite() || !deck) return;
		const now = Date.now();
		if (!together || together !== group || now - groupAt > GROUP_MS) remember();
		group = together;
		groupAt = now;
		action();
		changed();
		render();
	}
	function travel(from: OsPresentationDeck[], to: OsPresentationDeck[]) {
		if (!deck || !from.length || !canWrite()) return;
		commitText();
		to.push(deck);
		deck = from.pop()!;
		group = "";
		changed();
		render();
	}
	function elementAction(action: SlideElementAction) {
		const slide = active();
		if (!slide || !canWrite()) return;
		const result = applySlideElementAction(action, slide, selectedId);
		if (!result?.slide) return;
		mutate(() => {
			updateSlide(result.slide!);
			selectedId = result.selectedId;
			if (action === "paste" || action === "duplicate")
				freshId = result.selectedId ?? undefined;
		});
	}
	function addElement(element: OsPresentationElement) {
		mutate(() => {
			const slide = active()!;
			updateSlide({ ...slide, elements: [...slide.elements, element] });
			selectedId = element.id;
			freshId = element.id;
		});
	}
	function insertElement(type: OsPresentationElementType) {
		const slide = active();
		if (!slide || slide.elements.length >= OS_SLIDE_MAX_ELEMENTS) return;
		addElement(newSlideElement(type, slide.elements.length));
		// Ready for arrow keys and typing shortcuts straight away.
		stage.focus({ preventScroll: true });
	}
	function placeSlide(slide: OsPresentationCanvasSlide, after?: string) {
		mutate(() => {
			const slides = [...deck!.slides];
			const index = slides.findIndex((row) => row.id === after);
			slides.splice(index < 0 ? slides.length : index + 1, 0, slide);
			deck = { ...deck!, activeSlideId: slide.id, slides };
			viewedId = slide.id;
			selectedId = null;
		});
	}
	function addSlide() {
		if ((deck?.slides.length ?? 0) < OS_DECK_MAX_SLIDES)
			placeSlide(newCanvasSlide(), active()?.id);
	}
	function duplicateSlide(id: string) {
		const slide = deck?.slides.find((row) => row.id === id);
		if (slide && deck!.slides.length < OS_DECK_MAX_SLIDES)
			placeSlide(duplicateCanvasSlide(slide), id);
	}
	function deleteSlide(id: string) {
		const index = deck?.slides.findIndex((slide) => slide.id === id) ?? -1;
		if (index < 0) return;
		const current = active()?.id;
		mutate(() => {
			const slides = deck!.slides.filter((slide) => slide.id !== id);
			if (current === id) {
				viewedId = slides[Math.min(index, slides.length - 1)]?.id;
				selectedId = null;
			}
			deck = {
				...deck!,
				slides,
				activeSlideId:
					deck!.activeSlideId === id
						? (viewedId ?? slides[0]?.id ?? "empty-deck")
						: deck!.activeSlideId,
			};
		});
	}
	function moveSlide(id: string, to: number) {
		const from = deck?.slides.findIndex((slide) => slide.id === id) ?? -1;
		if (from < 0 || to === from || to < 0 || to >= deck!.slides.length) return;
		mutate(() => {
			deck = reorderSlide(deck!, from, to);
		});
	}
	function selectSlide(index: number, focus = false) {
		commitText();
		const slide = deck?.slides[index];
		if (!slide) return;
		viewedId = slide.id;
		selectedId = null;
		render();
		if (focus) thumbs.get(slide.id)?.select.focus();
	}
	function commitNotes() {
		const slide = active();
		if (slide && canWrite() && notes.value !== (slide.notes ?? ""))
			mutate(() => updateSlide({ ...active()!, notes: notes.value }));
	}

	// ---- Painting ----

	function cssBox(node: HTMLElement, element: OsPresentationElement) {
		const next = slideElementStyle(
			element,
			"canvas",
			context.appearance,
			deck?.theme,
		) as Record<string, string | number | undefined>;
		const target = node.style as unknown as Record<string, string>;
		// Nodes are reused, so a value that went away has to be cleared.
		for (const key in next)
			target[key] = next[key] === undefined ? "" : String(next[key]);
		ensureSlideFontLoaded(slideThemeFontFamily(element, deck?.theme));
	}
	const elementLabel = (element: OsPresentationElement) =>
		`${ELEMENT_NAMES[element.type]}: ${(element.text || element.props?.title || "Visual").slice(0, 80)}`;
	/** Paint a whole slide from scratch: thumbnails and the presenter. */
	function paintCanvas(
		container: HTMLElement,
		slide: OsPresentationCanvasSlide | undefined,
	) {
		container.replaceChildren();
		container.style.background = slide?.background ?? "#ffffff";
		if (!slide) return;
		const background = document.createElement("div");
		background.className = "slides-background";
		linked.background(background, slide, context.appearance);
		container.append(background);
		for (const element of slide.elements) {
			const node = document.createElement("div");
			node.className = "slides-element";
			node.dataset.elementId = element.id;
			cssBox(node, element);
			linked.element(node, element, context.appearance);
			container.append(node);
		}
	}
	function restart(node: HTMLElement, name: string) {
		node.classList.remove(name);
		void node.offsetWidth;
		node.classList.add(name);
	}
	function stageNode(id: string) {
		const node = document.createElement("div");
		node.className = "slides-element";
		node.dataset.elementId = id;
		node.tabIndex = 0;
		node.setAttribute("role", "button");
		node.onpointerdown = (event) => beginPointer(event, id, null);
		node.ondblclick = () => beginText(id);
		node.onanimationend = () => node.classList.remove("fresh");
		node.onkeydown = (event) => {
			if (event.target !== node) return;
			if (event.key === "F2") {
				event.preventDefault();
				beginText(id);
			} else if (
				(event.key === "Enter" || event.key === " ") &&
				selectedId !== id
			) {
				// Enter on the element that is already selected opens Format.
				event.preventDefault();
				event.stopPropagation();
				selectedId = id;
				render();
			}
		};
		return node;
	}
	function addHandles(node: HTMLElement, id: string) {
		for (const handle of HANDLES) {
			const grip = document.createElement("button");
			grip.className = "slides-resize";
			grip.dataset.handle = handle;
			grip.tabIndex = -1;
			grip.setAttribute("aria-label", "Resize element");
			grip.disabled = !canWrite();
			grip.onpointerdown = (event) => beginPointer(event, id, handle);
			node.append(grip);
		}
	}
	/** Bring the stage in line with the current slide, touching only what changed. */
	function renderStage() {
		const slide = active();
		if (!slide || slide.id !== stageSlideId) {
			const switched = !!slide && stageSlideId !== undefined;
			stageNodes.clear();
			stage.replaceChildren();
			stageBackground = undefined;
			stageSlide = undefined;
			stageSlideId = slide?.id;
			if (switched) restart(stage, "switching");
		}
		stage.style.background = slide?.background ?? "#ffffff";
		if (!slide) {
			if (!available) return;
			const blank = document.createElement("div");
			blank.className = "slides-empty";
			blank.textContent = "Add a slide to begin your presentation.";
			stage.append(blank);
			return;
		}
		if (!stageBackground) {
			stageBackground = document.createElement("div");
			stageBackground.className = "slides-background";
			stage.append(stageBackground, guides);
		}
		if (stageSlide !== slide)
			linked.background(stageBackground, slide, context.appearance);
		const restyle = stageTheme !== deck?.theme;
		const keep = new Set<string>();
		let previous: Element = stageBackground;
		for (const element of slide.elements) {
			keep.add(element.id);
			let entry = stageNodes.get(element.id);
			if (!entry) {
				entry = { node: stageNode(element.id) };
				stageNodes.set(element.id, entry);
			}
			const { node } = entry;
			// Never repaint the element someone is typing in.
			const typing = editingId === element.id;
			if ((entry.element !== element || restyle) && !typing) {
				cssBox(node, element);
				linked.element(node, element, context.appearance);
				node.setAttribute("aria-label", elementLabel(element));
				entry.element = element;
			}
			if (previous.nextSibling !== node) previous.after(node);
			previous = node;
			const chosen = selectedId === element.id;
			node.classList.toggle("selected", chosen);
			node.setAttribute("aria-pressed", String(chosen));
			const grips = node.querySelector(":scope > .slides-resize");
			if (chosen && !typing && !grips) addHandles(node, element.id);
			else if ((!chosen || typing) && grips)
				node
					.querySelectorAll(":scope > .slides-resize")
					.forEach((grip) => grip.remove());
			if (freshId === element.id) {
				freshId = undefined;
				node.classList.add("fresh");
			}
		}
		for (const [id, entry] of stageNodes)
			if (!keep.has(id)) {
				entry.node.remove();
				stageNodes.delete(id);
			}
		stageSlide = slide;
		stageTheme = deck?.theme;
	}
	function thumb(id: string) {
		const item = document.createElement("div");
		item.className = "slides-thumb";
		item.dataset.slideId = id;
		item.draggable = !!editable;
		const number = document.createElement("span");
		number.className = "slides-thumb-number";
		number.setAttribute("aria-hidden", "true");
		const select = document.createElement("button");
		select.className = "slides-thumbnail";
		const canvas = document.createElement("div");
		canvas.className = "slides-thumb-canvas";
		select.append(canvas);
		const actions = document.createElement("div");
		actions.className = "slides-thumb-actions";
		for (const [name, label, glyphName] of [
			["duplicate", "Duplicate slide", "copy"],
			["delete", "Delete slide", "trash"],
		] as const) {
			const action = document.createElement("button");
			action.dataset.act = name;
			action.title = label;
			action.innerHTML = editorIcon(glyphName);
			action.onclick = () => {
				if (name === "duplicate") duplicateSlide(id);
				else deleteSlide(id);
				const current = active();
				if (current) thumbs.get(current.id)?.select.focus();
			};
			actions.append(action);
		}
		item.append(number, select, actions);
		const index = () => deck?.slides.findIndex((slide) => slide.id === id) ?? 0;
		select.onclick = () => selectSlide(index());
		select.onkeydown = (event) => {
			const last = (deck?.slides.length ?? 1) - 1;
			const by =
				event.key === "ArrowDown" || event.key === "ArrowRight"
					? 1
					: event.key === "ArrowUp" || event.key === "ArrowLeft"
						? -1
						: 0;
			if (by && event.altKey) {
				moveSlide(id, index() + by);
				thumbs.get(id)?.select.focus();
			} else if (by) selectSlide(index() + by, true);
			else if (event.key === "Home") selectSlide(0, true);
			else if (event.key === "End") selectSlide(last, true);
			else if (event.key === "Delete" || event.key === "Backspace") {
				const at = index();
				deleteSlide(id);
				const next = deck?.slides[Math.min(at, deck.slides.length - 1)];
				if (next) thumbs.get(next.id)?.select.focus();
			} else return;
			event.preventDefault();
			event.stopPropagation();
		};
		item.ondragstart = (event) => {
			event.dataTransfer?.setData("application/x-tedix-slide", id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		};
		const after = (event: DragEvent) => {
			const box = item.getBoundingClientRect();
			return event.clientY > box.top + box.height / 2;
		};
		item.ondragover = (event) => {
			if (!event.dataTransfer?.types.includes("application/x-tedix-slide"))
				return;
			event.preventDefault();
			item.dataset.drop = after(event) ? "after" : "before";
		};
		item.ondragleave = () => {
			delete item.dataset.drop;
		};
		item.ondragend = () => {
			for (const row of nav.querySelectorAll<HTMLElement>("[data-drop]"))
				delete row.dataset.drop;
		};
		item.ondrop = (event) => {
			delete item.dataset.drop;
			const moved = event.dataTransfer?.getData("application/x-tedix-slide");
			if (!moved) return;
			event.preventDefault();
			const from = deck?.slides.findIndex((slide) => slide.id === moved) ?? -1;
			let to = index() + (after(event) ? 1 : 0);
			if (from < to) to--;
			moveSlide(moved, to);
		};
		return { item, select, number, canvas };
	}
	/** Keep one thumbnail per slide, repainting only slides that changed. */
	function renderRail() {
		const slides = deck?.slides ?? [];
		const order = slides.map((slide) => slide.id).join("\n");
		const reflow = order !== railOrder;
		const animate =
			reflow &&
			railOrder !== undefined &&
			!stillMotion() &&
			typeof nav.animate === "function";
		const tops = new Map<string, number>();
		if (animate)
			for (const [id, entry] of thumbs)
				tops.set(id, entry.item.getBoundingClientRect().top);
		if (reflow && !thumbs.size) nav.replaceChildren();
		const current = active()?.id;
		let previous: Element | null = null;
		slides.forEach((slide, index) => {
			let entry = thumbs.get(slide.id);
			if (!entry) {
				entry = thumb(slide.id);
				thumbs.set(slide.id, entry);
				if (animate) entry.item.classList.add("entering");
				thumbWatch?.observe(entry.item);
			}
			if (
				(entry.slide !== slide || entry.theme !== deck?.theme) &&
				(!thumbWatch ||
					index < EAGER_THUMBNAILS ||
					entry.near ||
					current === slide.id)
			) {
				paintCanvas(entry.canvas, slide);
				entry.slide = slide;
				entry.theme = deck?.theme;
			}
			const label = `Slide ${index + 1}: ${slide.name}`;
			if (entry.label !== label) {
				entry.label = label;
				entry.number.textContent = String(index + 1);
				entry.select.setAttribute("aria-label", label);
				entry.select.title = slide.name;
				for (const action of entry.item.querySelectorAll<HTMLButtonElement>(
					"[data-act]",
				))
					action.setAttribute(
						"aria-label",
						`${action.title} ${index + 1}: ${slide.name}`,
					);
			}
			const chosen = current === slide.id;
			entry.item.classList.toggle("current", chosen);
			entry.select.setAttribute("aria-pressed", String(chosen));
			entry.select.tabIndex = chosen ? 0 : -1;
			if (reflow) {
				if (!previous) {
					if (nav.firstChild !== entry.item) nav.prepend(entry.item);
				} else if (previous.nextSibling !== entry.item)
					previous.after(entry.item);
				previous = entry.item;
			}
		});
		if (reflow) {
			const keep = new Set(slides.map((slide) => slide.id));
			for (const [id, entry] of thumbs)
				if (!keep.has(id)) {
					thumbWatch?.unobserve(entry.item);
					entry.item.remove();
					thumbs.delete(id);
				}
			railOrder = order;
		}
		if (animate)
			for (const [id, top] of tops) {
				const item = thumbs.get(id)?.item;
				const shift = item ? top - item.getBoundingClientRect().top : 0;
				if (item && Math.abs(shift) > 1)
					item.animate(
						[{ transform: `translateY(${shift}px)` }, { transform: "none" }],
						{ duration: 240, easing: EASE },
					);
			}
		if (current !== railCurrent) {
			railCurrent = current;
			if (current)
				thumbs.get(current)?.item.scrollIntoView?.({ block: "nearest" });
		}
	}
	function field(
		parent: HTMLElement,
		label: string,
		get: () => string | number,
		set: (value: string) => void,
		options: FieldOptions = {},
	) {
		const wrapper = document.createElement("label");
		wrapper.textContent = label;
		if (options.wide || options.multiline) wrapper.className = "wide";
		const input = options.choices
			? document.createElement("select")
			: options.multiline
				? document.createElement("textarea")
				: document.createElement("input");
		input.setAttribute("aria-label", label);
		if (input instanceof HTMLSelectElement)
			for (const option of options.choices!) {
				const node = document.createElement("option");
				node.value = option;
				node.textContent = option;
				input.append(node);
			}
		if (input instanceof HTMLInputElement) {
			input.type = options.type ?? "text";
			if (options.min !== undefined) input.min = String(options.min);
			if (options.max !== undefined) input.max = String(options.max);
			if (options.step) input.step = options.step;
		}
		input.value = String(get());
		// A field someone is typing in keeps what they typed.
		syncs.push(() => {
			const value = String(get());
			if (document.activeElement !== input && input.value !== value)
				input.value = value;
		});
		input.onchange = () => {
			if (input instanceof HTMLInputElement && !input.checkValidity()) {
				message(`${label} is outside the allowed range.`, true, 5000);
				return;
			}
			set(input.value);
		};
		wrapper.append(input);
		parent.append(wrapper);
		return input;
	}
	/** A color as a swatch that opens the picker; `none` adds a way to clear it. */
	function colorField(
		parent: HTMLElement,
		label: string,
		get: () => string,
		set: (value: string) => void,
		none?: { label: string; value: string },
	) {
		const wrapper = document.createElement("label");
		wrapper.className = "slides-color wide";
		wrapper.textContent = label;
		const swatch = document.createElement("span");
		swatch.className = "slides-swatch";
		const fill = document.createElement("i");
		const input = document.createElement("input");
		input.type = "color";
		input.setAttribute("aria-label", label);
		const show = () => {
			const value = get();
			fill.style.background = "";
			fill.style.background = value || "transparent";
			if (document.activeElement !== input)
				input.value = hexColor(value, "#000000");
		};
		show();
		syncs.push(show);
		input.oninput = input.onchange = () => {
			if (input.value !== get()) set(input.value);
		};
		swatch.append(fill, input);
		if (none) {
			const clear = document.createElement("button");
			clear.type = "button";
			clear.textContent = none.label;
			clear.setAttribute("aria-label", `${label}: ${none.label}`);
			clear.onclick = (event) => {
				event.preventDefault();
				if (get() !== none.value) set(none.value);
			};
			wrapper.append(clear);
		}
		wrapper.append(swatch);
		parent.append(wrapper);
	}
	function buildInspector(element: OsPresentationElement | undefined) {
		syncs = [];
		properties.replaceChildren();
		const heading = document.createElement("h2");
		heading.textContent = element ? ELEMENT_NAMES[element.type] : "Slide";
		const basics = document.createElement("div");
		basics.className = "slides-fields";
		const advanced = document.createElement("details");
		advanced.className = "slides-advanced";
		advanced.open = advancedOpen;
		advanced.ontoggle = () => {
			advancedOpen = advanced.open;
		};
		const summary = document.createElement("summary");
		summary.textContent = "Advanced";
		const extras = document.createElement("div");
		extras.className = "slides-fields";
		advanced.append(summary, extras);
		properties.append(heading, basics, advanced);
		if (!element) {
			const slide = <T>(read: (slide: OsPresentationCanvasSlide) => T) =>
				read(active()!);
			const edit = (
				make: (slide: OsPresentationCanvasSlide) => OsPresentationCanvasSlide,
				together = "",
			) =>
				mutate(() => {
					const current = active();
					if (current) updateSlide(make(current));
				}, together);
			field(
				basics,
				"Slide name",
				() => slide((row) => row.name),
				(value) =>
					edit((row) => ({
						...row,
						name: value.trim().slice(0, 200) || "Untitled slide",
					})),
				{ wide: true },
			);
			colorField(
				basics,
				"Background",
				() => slide((row) => row.background),
				(value) => edit((row) => ({ ...row, background: value }), "background"),
			);
			field(
				extras,
				"Background style",
				() => slide((row) => row.background),
				(value) => edit((row) => ({ ...row, background: value })),
				{ wide: true },
			);
			field(
				extras,
				"Background image",
				() => slide((row) => row.backgroundImage ?? ""),
				(value) =>
					stored(value, (source) =>
						edit((row) => ({ ...row, backgroundImage: source || undefined })),
					),
				{ wide: true },
			);
			field(
				extras,
				"Dot grid opacity",
				() => slide((row) => row.dotGridOpacity ?? 0),
				(value) => edit((row) => ({ ...row, dotGridOpacity: Number(value) })),
				{ type: "number", min: 0, max: 1, step: "0.05" },
			);
			colorField(
				extras,
				"Inset surface color",
				() => slide((row) => row.insetSurface?.color ?? ""),
				(value) =>
					edit(
						(row) => ({
							...row,
							insetSurface: value
								? {
										...row.insetSurface,
										color: value,
										inset: row.insetSurface?.inset ?? 24,
										radius: row.insetSurface?.radius ?? 8,
									}
								: undefined,
						}),
						"inset",
					),
				{ label: "None", value: "" },
			);
			for (const key of ["headingFont", "bodyFont"] as const)
				field(
					extras,
					key === "headingFont" ? "Deck heading font" : "Deck body font",
					() => deck?.theme?.[key] ?? "Arial, sans-serif",
					(value) =>
						mutate(() => {
							deck = { ...deck!, theme: { ...deck!.theme, [key]: value } };
						}),
					{ wide: true },
				);
			return;
		}
		const type = element.type;
		const edit = (
			make: (element: OsPresentationElement) => OsPresentationElement,
			together = "",
		) =>
			mutate(() => {
				const current = selected();
				if (current) updateElement(make(current));
			}, together);
		const styleField = (
			parent: HTMLElement,
			label: string,
			key: keyof OsPresentationElement["style"],
			fallback: string | number,
			options?: FieldOptions,
		) =>
			field(
				parent,
				label,
				() => selected()?.style[key] ?? fallback,
				(value) =>
					edit((current) => ({
						...current,
						style: {
							...current.style,
							[key]: options?.type === "number" ? Number(value) : value,
						},
					})),
				options,
			);
		const styleColor = (
			label: string,
			key: "color" | "background" | "borderColor",
			fallback: string,
			none?: { label: string; value: string },
		) =>
			colorField(
				basics,
				label,
				() => selected()?.style[key] ?? fallback,
				(value) =>
					edit(
						(current) => ({
							...current,
							style: { ...current.style, [key]: value },
						}),
						`color:${key}`,
					),
				none,
			);
		const propsField = (
			label: string,
			key: keyof NonNullable<OsPresentationElement["props"]>,
			fallback: string,
			choices?: string[],
		) =>
			field(
				basics,
				label,
				() => String(selected()?.props?.[key] ?? fallback),
				(value) =>
					edit((current) => ({
						...current,
						props: { ...current.props, [key]: value },
					})),
				choices ? { choices, wide: true } : { wide: true },
			);
		field(
			basics,
			"Text",
			() => selected()?.text ?? "",
			(value) => edit((current) => ({ ...current, text: value })),
			{ multiline: true },
		);
		if (type === "shape")
			propsField("Shape", "kind", "rectangle", ["rectangle", "ellipse"]);
		if (type === "card" || type === "box") {
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
		if (type === "arrow") propsField("Arrow label", "label", "");
		if (type === "image" || type === "svg")
			styleField(basics, "Image fit", "fit", "contain", {
				choices: ["contain", "cover"],
				wide: true,
			});
		styleField(basics, "Font size", "fontSize", 24, {
			type: "number",
			min: 8,
			max: 180,
		});
		styleField(basics, "Font weight", "fontWeight", "normal", {
			choices: ["light", "normal", "medium", "semibold", "bold"],
		});
		styleField(basics, "Text alignment", "textAlign", "left", {
			choices: ["left", "center", "right"],
		});
		styleField(basics, "Vertical alignment", "verticalAlign", "top", {
			choices: ["top", "middle", "bottom"],
		});
		styleColor("Text color", "color", "#111111");
		styleColor("Fill", "background", "transparent", {
			label: "None",
			value: "transparent",
		});
		styleColor("Border color", "borderColor", "#000000");
		styleField(basics, "Border width", "borderWidth", 0, {
			type: "number",
			min: 0,
			max: 24,
		});
		styleField(basics, "Corner radius", "borderRadius", 0, {
			type: "number",
			min: 0,
			max: 200,
		});
		styleField(basics, "Opacity", "opacity", 1, {
			type: "number",
			min: 0,
			max: 1,
			step: "0.05",
		});
		for (const [label, key] of [
			["X", "x"],
			["Y", "y"],
			["Width", "width"],
			["Height", "height"],
		] as const)
			field(
				extras,
				label,
				() => selected()?.[key] ?? 0,
				(value) =>
					edit((current) =>
						updateElementGeometry(current, { [key]: Number(value) }),
					),
				{
					type: "number",
					min: key === "width" || key === "height" ? 1 : 0,
					max: key === "x" || key === "width" ? 1200 : 675,
				},
			);
		styleField(extras, "Font family", "fontFamily", "Arial, sans-serif", {
			wide: true,
		});
		styleField(extras, "Rotation", "rotation", 0, {
			type: "number",
			min: -360,
			max: 360,
		});
		styleField(extras, "Padding", "padding", 0, {
			type: "number",
			min: 0,
			max: 200,
		});
		styleField(extras, "Line height", "lineHeight", 1.3, {
			type: "number",
			min: 0.1,
			max: 10,
			step: "0.1",
		});
		styleField(extras, "Letter spacing", "letterSpacing", 0, {
			type: "number",
			min: -50,
			max: 100,
			step: "0.5",
		});
		if (type === "image" || type === "svg")
			field(
				extras,
				"Image source",
				() => selected()?.src ?? "",
				(value) =>
					stored(value, (src) => edit((current) => ({ ...current, src }))),
				{ wide: true },
			);
		if (type === "svg")
			field(
				extras,
				"SVG markup",
				() =>
					svgMarkupFromSource(linked.copy(selected()?.src) ?? selected()?.src),
				(value) => {
					const result = svgSourceFromMarkup(value);
					if (result.ok)
						stored(result.src ?? "", (src) =>
							edit((current) => ({ ...current, src: src || undefined })),
						);
					else message(result.error, true, 5000);
				},
				{ multiline: true },
			);
		if (type === "arrow")
			for (const point of ["from", "to"] as const)
				for (const axis of ["x", "y"] as const)
					field(
						extras,
						`${point === "from" ? "Start" : "End"} ${axis.toUpperCase()}`,
						() => {
							const current = selected();
							return (
								current?.props?.[point]?.[axis] ??
								(axis === "x" ? current?.x : current?.y) ??
								0
							);
						},
						(value) =>
							edit((current) => ({
								...current,
								props: {
									...current.props,
									[point]: {
										...(current.props?.[point] ?? {
											x: current.x,
											y: current.y,
										}),
										[axis]: Number(value),
									},
								},
							})),
						{ type: "number", min: 0, max: axis === "x" ? 1200 : 675 },
					);
	}
	/** Refresh the Format panel; its fields are rebuilt only when the selection changes. */
	function renderInspector() {
		if (!inspectorOpen) return;
		const slide = active(),
			element = selected();
		const key = !slide
			? ""
			: element
				? `element:${element.id}:${element.type}`
				: `slide:${slide.id}`;
		if (key !== inspectorKey) {
			inspectorKey = key;
			if (slide) buildInspector(element);
			else {
				syncs = [];
				properties.replaceChildren();
			}
		} else for (const sync of syncs) sync();
		const rows = [...(slide?.elements ?? [])].reverse();
		const existing = Array.from(layers.children) as HTMLButtonElement[];
		rows.forEach((row, index) => {
			const item = existing[index] ?? document.createElement("button");
			const label = `${ELEMENT_NAMES[row.type]} · ${(row.text || row.props?.title || "Untitled").slice(0, 36)}`;
			if (item.textContent !== label) item.textContent = label;
			item.setAttribute("aria-pressed", String(row.id === selectedId));
			item.onclick = () => {
				commitText();
				selectedId = row.id;
				render();
			};
			if (!existing[index]) layers.append(item);
		});
		existing.slice(rows.length).forEach((item) => item.remove());
	}
	function setInspector(open: boolean, focus = false) {
		inspectorOpen = open;
		inspector.dataset.open = String(open);
		button("format").setAttribute("aria-expanded", String(open));
		if (!open) return;
		renderInspector();
		controls();
		if (focus)
			properties
				.querySelector<HTMLElement>("input,select,textarea")
				?.focus({ preventScroll: true });
	}
	function renderPresentation() {
		const slide = active();
		if (slide?.id !== presentedId) {
			if (presentedId && !stillMotion()) restart(presentStage, "switching");
			presentedId = slide?.id;
			pill.classList.add("show");
			clearTimeout(pillTimer);
			pillTimer = setTimeout(() => pill.classList.remove("show"), 1400);
		}
		paintCanvas(presentStage, slide);
		const index = slide ? deck!.slides.indexOf(slide) : -1;
		pill.textContent = `${index + 1} / ${deck?.slides.length ?? 0}`;
		button("previous").disabled = index <= 0;
		button("next").disabled = index >= (deck?.slides.length ?? 0) - 1;
	}
	function controls() {
		const write = canWrite(),
			slide = active();
		markSave();
		button("undo").disabled = !write || !history.length;
		button("redo").disabled = !write || !future.length;
		button("add-slide").disabled =
			!write || (deck?.slides.length ?? 0) >= OS_DECK_MAX_SLIDES;
		button("insert").disabled =
			!write || !slide || slide.elements.length >= OS_SLIDE_MAX_ELEMENTS;
		button("upload").disabled = button("insert").disabled;
		for (const id of [
			"duplicate-element",
			"delete-element",
			"backward",
			"forward",
		])
			button(id).disabled = !write || !selected();
		button("format").disabled = !available;
		button("present").disabled = !available || !slide;
		button("more").disabled = !available || exporting;
		notes.disabled = !write || !slide;
		nav
			.querySelectorAll<HTMLButtonElement>("[data-act]")
			.forEach((action) => (action.disabled = !write));
		stage
			.querySelectorAll<HTMLButtonElement>(".slides-resize")
			.forEach((grip) => (grip.disabled = !write));
		// A disabled button swallows the keyboard; keep shortcuts working.
		const focused = document.activeElement;
		if (
			focused instanceof HTMLButtonElement &&
			focused.disabled &&
			main.contains(focused)
		)
			stage.focus({ preventScroll: true });
		if (inspectorOpen)
			properties
				.querySelectorAll<
					| HTMLInputElement
					| HTMLSelectElement
					| HTMLTextAreaElement
					| HTMLButtonElement
				>("input,select,textarea,button")
				.forEach((input) => (input.disabled = !write));
	}
	function render() {
		if (destroyed) return;
		renderStage();
		renderRail();
		renderInspector();
		if (document.activeElement !== notes) notes.value = active()?.notes ?? "";
		if (!presenter.hidden) renderPresentation();
		controls();
	}

	// ---- Stage size ----

	/** Scale the slide to the largest size that fits the space around it. */
	function fit() {
		const padding = parseFloat(getComputedStyle(canvasArea).paddingLeft) || 0;
		const width = canvasArea.clientWidth - padding * 2,
			height = canvasArea.clientHeight - padding * 2;
		if (width <= 0 || height <= 0) return;
		stage.style.width = `${Math.max(120, Math.floor(Math.min(width, (height * 16) / 9)))}px`;
	}
	const fitObserver =
		typeof ResizeObserver === "function" ? new ResizeObserver(fit) : undefined;
	fitObserver?.observe(canvasArea);

	// ---- Pointer gestures ----

	function showGuides(vertical: number[] = [], horizontal: number[] = []) {
		guides.replaceChildren(
			...vertical.map((x) => {
				const line = document.createElement("div");
				line.className = "slides-guide v";
				line.style.left = `${(x / 1200) * 100}%`;
				return line;
			}),
			...horizontal.map((y) => {
				const line = document.createElement("div");
				line.className = "slides-guide h";
				line.style.top = `${(y / 675) * 100}%`;
				return line;
			}),
		);
	}
	/** Keep receiving the pointer when it leaves the slide mid-gesture. */
	function capture(pointerId: number) {
		try {
			stage.setPointerCapture?.(pointerId);
		} catch {
			// The pointer is already gone; the gesture ends on its own.
		}
	}
	function beginPointer(
		event: PointerEvent,
		elementId: string,
		handle: Handle | null,
	) {
		if (event.button !== 0 || (editing && editingId === elementId)) return;
		commitText();
		event.preventDefault();
		event.stopPropagation();
		const element = active()?.elements.find((row) => row.id === elementId),
			node = stageNodes.get(elementId)?.node;
		if (!element || !node) return;
		if (selectedId !== elementId) {
			selectedId = elementId;
			render();
		}
		stage.focus({ preventScroll: true });
		if (!canWrite()) return;
		pointer = {
			id: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			box: stage.getBoundingClientRect(),
			node,
			original: element,
			handle,
		};
		if (handle) capture(event.pointerId);
	}
	function resized(
		original: OsPresentationElement,
		handle: Handle,
		dx: number,
		dy: number,
		keepShape: boolean,
	) {
		// An element that is already thinner than the minimum may stay that thin.
		const minWidth = Math.min(MIN_WIDTH, original.width),
			minHeight = Math.min(MIN_HEIGHT, original.height);
		const right = original.x + original.width,
			bottom = original.y + original.height;
		let { x, y, width, height } = original;
		if (handle.includes("e")) width = Math.max(minWidth, width + dx);
		if (handle.includes("w")) {
			width = Math.max(minWidth, Math.min(right, width - dx));
			x = right - width;
		}
		if (handle.includes("s")) height = Math.max(minHeight, height + dy);
		if (handle.includes("n")) {
			height = Math.max(minHeight, Math.min(bottom, height - dy));
			y = bottom - height;
		}
		if (keepShape && handle.length === 2) {
			height = Math.max(minHeight, (width * original.height) / original.width);
			if (handle.includes("n")) y = bottom - height;
		}
		return updateElementGeometry(original, { x, y, width, height });
	}
	const onPointerMove = (event: PointerEvent) => {
		const gesture = pointer;
		if (!gesture || event.pointerId !== gesture.id || !gesture.box.width)
			return;
		const moveX = event.clientX - gesture.x,
			moveY = event.clientY - gesture.y;
		if (!gesture.next && Math.hypot(moveX, moveY) < DRAG_SLOP) return;
		const { original, handle } = gesture;
		const dx = (moveX * 1200) / gesture.box.width,
			dy = (moveY * 675) / gesture.box.height;
		if (!gesture.next) capture(event.pointerId);
		let next: OsPresentationElement;
		if (handle) next = resized(original, handle, dx, dy, event.shiftKey);
		else {
			next = updateElementGeometry(original, {
				x: original.x + dx,
				y: original.y + dy,
			});
			if (event.altKey) showGuides();
			else {
				gesture.targets ??= computeSnapTargets(
					active()!.elements.filter((element) => element.id !== original.id),
					1200,
					675,
				);
				const snapped = applySnap(next, gesture.targets);
				next = updateElementGeometry(original, { x: snapped.x, y: snapped.y });
				showGuides(snapped.guidesV, snapped.guidesH);
			}
		}
		gesture.next = next;
		// Only the moving node is touched until the gesture ends.
		cssBox(gesture.node, next);
		if (next.props !== original.props) {
			linked.element(gesture.node, next, context.appearance);
			addHandles(gesture.node, next.id);
		}
	};
	const endPointer = (event: PointerEvent) => {
		const gesture = pointer;
		if (!gesture || event.pointerId !== gesture.id) return;
		pointer = undefined;
		showGuides();
		if (gesture.next && event.type === "pointercancel") {
			const entry = stageNodes.get(gesture.original.id);
			if (entry) entry.element = undefined;
			render();
		} else if (gesture.next) {
			// The whole gesture is one undo step, one draft and one save.
			remember();
			group = "";
			updateElement(gesture.next);
			changed();
			render();
		}
		// A save that waited for this gesture goes out now.
		scheduleSave();
		refreshExternal();
	};
	stage.addEventListener("pointermove", onPointerMove);
	stage.addEventListener("pointerup", endPointer);
	stage.addEventListener("pointercancel", endPointer);
	stage.onpointerdown = (event) => {
		if (
			event.target === stage ||
			(event.target as HTMLElement).classList.contains("slides-background") ||
			(event.target as HTMLElement).classList.contains("slides-empty")
		) {
			commitText();
			if (selectedId) {
				selectedId = null;
				render();
			}
		}
	};

	// ---- Writing on the slide ----

	function beginText(elementId: string) {
		const element = active()?.elements.find((row) => row.id === elementId);
		if (!element || !canWrite() || NO_TEXT.includes(element.type)) return;
		if (editingId === elementId) return;
		commitText();
		selectedId = elementId;
		editingId = elementId;
		render();
		const entry = stageNodes.get(elementId)!;
		const input = document.createElement("textarea");
		input.className = "slides-inline-editor";
		input.setAttribute("aria-label", "Edit canvas text");
		input.value = element.text ?? "";
		entry.node.replaceChildren(input);
		entry.element = undefined;
		editing = input;
		input.focus();
		input.select();
		let remembered = false;
		input.onpointerdown = (event) => event.stopPropagation();
		input.ondblclick = (event) => event.stopPropagation();
		input.oninput = () => {
			const current = active()?.elements.find((row) => row.id === elementId);
			if (!current) return;
			if (!remembered) {
				remember();
				group = "";
				remembered = true;
			}
			updateElement({ ...current, text: input.value });
			changed(true);
			controls();
		};
		input.onblur = () => {
			if (editing !== input) return;
			editing = undefined;
			editingId = undefined;
			render();
			refreshExternal();
		};
		input.onkeydown = (event) => {
			event.stopPropagation();
			const command = event.metaKey || event.ctrlKey;
			if (command && event.key.toLowerCase() === "s") {
				event.preventDefault();
				void flush(true);
			} else if (
				event.key === "Escape" ||
				(event.key === "Enter" &&
					!event.isComposing &&
					// Enter finishes a line of text; in a bullet list it starts the
					// next point, and Shift+Enter always adds a line.
					(command || (!event.shiftKey && element.type !== "bullet")))
			) {
				event.preventDefault();
				input.blur();
				stage.focus({ preventScroll: true });
			}
		};
	}
	function commitText() {
		const input = editing;
		if (!input) return;
		input.blur();
		// A detached editor never reports its blur.
		if (editing === input) input.onblur?.(new FocusEvent("blur"));
	}

	// ---- Loading and other people's saves ----

	function showChoice(
		key: string,
		text: string,
		options: [string, () => void][],
	) {
		if (updates.dataset.key === key) return;
		updates.dataset.key = key;
		const prompt = document.createElement("span");
		prompt.textContent = text;
		updates.replaceChildren(
			prompt,
			...options.map(([label, choose]) => {
				const option = document.createElement("button");
				option.type = "button";
				option.textContent = label;
				option.onclick = choose;
				return option;
			}),
		);
	}
	/** The presentation can no longer be read: show nothing rather than stale slides. */
	async function unavailable(error: unknown) {
		available = false;
		clearTimeout(saveTimer);
		if (loaded && editable && DENIED.test(reason(error))) {
			dirty = false;
			await clearDraft(true).catch(() => undefined);
		}
		deck = undefined;
		selectedId = null;
		inspectorKey = "";
		thumbs.clear();
		railOrder = undefined;
		nav.replaceChildren();
		properties.replaceChildren();
		layers.replaceChildren();
		notes.value = "";
		presenter.hidden = true;
		presentStage.replaceChildren();
		render();
		message(reason(error), true);
	}
	async function load() {
		loading = true;
		controls();
		try {
			const value = sync.remember(parse(await read()));
			if (destroyed) return;
			loaded = value;
			let retained: RetainedDraft | null = null;
			if (editable)
				retained = await bridge.call<RetainedDraft | null>(
					"app.draft.read",
					draftArgs(),
				);
			if (
				retained &&
				(retained.content?.kind !== "presentation" ||
					!Number.isInteger(retained.revision) ||
					retained.revision < 1)
			)
				throw new Error("The unsaved changes kept on this device are damaged");
			deck = deckOf(retained?.content ?? value.revision.content);
			basis = retained?.revision ?? value.revision.revision;
			dirty = !!retained;
			stale = basis < value.revision.revision;
			available = true;
			find("h1").textContent = value.output.title;
			main.dataset.revision = String(value.revision.revision);
			loading = false;
			quiet();
			render();
		} catch (error) {
			await unavailable(error);
		} finally {
			loading = false;
			main.removeAttribute("data-loading");
			controls();
			scheduleSave();
			refreshExternal();
		}
	}
	function refreshExternal() {
		if (!loaded || loading || destroyed || !available) return;
		if (stale)
			return showChoice(
				"stale",
				"This presentation was changed somewhere else after your last unsaved edits here. Choose which one to keep.",
				[
					["Keep my edits", () => resolveStale(true)],
					["Use the saved version", () => resolveStale(false)],
				],
			);
		if (dirty && choice > basis)
			return showChoice(
				`choice:${choice}`,
				"Someone else changed some of the same parts you are editing. Choose which version to keep there; all other changes from both of you are kept.",
				[
					["Keep mine", () => void mergeLatest("mine")],
					["Use theirs", () => void mergeLatest("theirs")],
				],
			);
		delete updates.dataset.key;
		updates.replaceChildren();
		if (pendingRevision <= basis) {
			pendingRevision = 0;
			return;
		}
		// Nothing changes under an active drag, text edit or save; each of them
		// comes back here when it ends.
		if (reading || saving || pointer || editing) return;
		if (dirty) void mergeLatest();
		else void pull();
	}
	function resolveStale(keepMine: boolean) {
		stale = false;
		if (keepMine) {
			basis = loaded!.revision.revision;
			void retainDraft();
			refreshExternal();
			void save();
			return;
		}
		dirty = false;
		deck = deckOf(loaded!.revision.content);
		basis = loaded!.revision.revision;
		history = [];
		future = [];
		selectedId = null;
		void clearDraft(true).catch(() => undefined);
		render();
		refreshExternal();
	}
	/** Show someone else's save. Nothing here is unsaved, so it simply replaces the canvas. */
	async function pull() {
		reading = true;
		try {
			const latest = parse(await sync.latest(read));
			if (destroyed) return;
			if (latest.revision.revision <= basis) {
				pendingRevision = 0;
				return;
			}
			// An edit or gesture began while reading: the merge takes over later.
			if (dirty || pointer || editing) return;
			pendingRevision = 0;
			loaded = latest;
			basis = latest.revision.revision;
			deck = deckOf(latest.revision.content);
			find("h1").textContent = latest.output.title;
			main.dataset.revision = String(basis);
			if (!selected()) selectedId = null;
			render();
		} catch (error) {
			pendingRevision = 0;
			await unavailable(error);
		} finally {
			reading = false;
			controls();
			scheduleSave();
			if (!destroyed && (dirty || pendingRevision > basis)) refreshExternal();
		}
	}
	/**
	 * Bring someone else's newer save into the unsaved canvas. Both sides'
	 * changes are kept; where they touch the same part, the person chooses.
	 */
	async function mergeLatest(prefer?: OutputMergePreference) {
		if (
			!loaded ||
			!deck ||
			!dirty ||
			reading ||
			saving ||
			destroyed ||
			pointer ||
			editing ||
			basis !== loaded.revision.revision
		)
			return;
		reading = true;
		let done = false;
		try {
			const latest = parse(await sync.latest(read));
			if (destroyed) return;
			if (latest.revision.revision <= basis) {
				pendingRevision = 0;
				return;
			}
			// A gesture began while reading; it comes back here when it ends.
			if (pointer || editing) return;
			// Never retry in a loop: the next change notice or save tries again.
			pendingRevision = 0;
			const result = mergeOutputContent(
				normalizePresentationContent(loaded.revision.content),
				projectDeck(deck),
				normalizePresentationContent(latest.revision.content),
				{ prefer, presentationSlides: (merged) => projectDeck(merged).slides },
			);
			if (!result.ok) {
				choice = latest.revision.revision;
				clearTimeout(saveTimer);
				return;
			}
			choice = 0;
			loaded = latest;
			basis = latest.revision.revision;
			deck = deckOf(result.content as PresentationContent);
			main.dataset.revision = String(basis);
			if (!selected()) selectedId = null;
			done = true;
			edits++;
			render();
			void retainDraft();
		} catch (error) {
			pendingRevision = 0;
			if (DENIED.test(reason(error))) await unavailable(error);
			else
				message(
					`Could not bring in the latest saved changes: ${reason(error)}. Your edits are kept on this device.`,
					true,
				);
		} finally {
			reading = false;
			controls();
			if (!destroyed) {
				refreshExternal();
				if (done) void save();
				else scheduleSave();
			}
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
	const onHide = () => {
		if (document.visibilityState === "hidden") void flush();
	};
	const onLeave = () => void flush();
	document.addEventListener("visibilitychange", onHide);
	window.addEventListener("pagehide", onLeave);

	// ---- Bar, menus and panels ----

	const menus: Array<(focus?: boolean) => void> = [];
	function menu(trigger: HTMLButtonElement, list: HTMLElement) {
		const close = (focus = false) => {
			if (list.hidden) return;
			// Hand focus back only if it would otherwise be lost with the list.
			const inside = list.contains(document.activeElement);
			list.hidden = true;
			trigger.setAttribute("aria-expanded", "false");
			if (focus && inside) trigger.focus();
		};
		const items = () =>
			Array.from(
				list.querySelectorAll<HTMLButtonElement>("[role=menuitem]"),
			).filter((item) => !item.disabled);
		trigger.onclick = () => {
			if (!list.hidden) return close();
			for (const other of menus) other();
			list.hidden = false;
			trigger.setAttribute("aria-expanded", "true");
			items()[0]?.focus();
		};
		list.onkeydown = (event) => {
			const all = items(),
				at = all.indexOf(document.activeElement as HTMLButtonElement);
			if (event.key === "Escape") close(true);
			else if (event.key === "ArrowDown") all[(at + 1) % all.length]?.focus();
			else if (event.key === "ArrowUp")
				all[(at - 1 + all.length) % all.length]?.focus();
			else if (event.key === "Home") all[0]?.focus();
			else if (event.key === "End") all.at(-1)?.focus();
			else if (event.key === "Tab") return close();
			else return;
			event.preventDefault();
			event.stopPropagation();
		};
		list.addEventListener("click", (event) => {
			if ((event.target as HTMLElement).closest("[role=menuitem]")) close(true);
		});
		menus.push(close);
	}
	menu(button("insert"), find("#insert-menu"));
	menu(button("more"), find("#more-menu"));
	const onOutside = (event: Event) => {
		if (!(event.target as HTMLElement).closest?.(".slides-menu-anchor"))
			for (const close of menus) close();
	};
	document.addEventListener("pointerdown", onOutside);
	button("undo").onclick = () => travel(history, future);
	button("redo").onclick = () => travel(future, history);
	for (const item of root.querySelectorAll<HTMLButtonElement>("[data-insert]"))
		item.onclick = () =>
			insertElement(item.dataset.insert as OsPresentationElementType);
	for (const [id, action] of [
		["duplicate-element", "duplicate"],
		["delete-element", "delete"],
		["backward", "backward"],
		["forward", "forward"],
	] as const)
		button(id).onclick = () => elementAction(action);
	button("add-slide").onclick = addSlide;
	button("format").onclick = () => setInspector(!inspectorOpen);
	notes.onchange = commitNotes;
	async function insertImage(file: File) {
		if (!canWrite() || !active()) return;
		try {
			const src = await storeImage(await fileToSlideImageSource(file));
			const slide = active();
			if (!slide || !canWrite()) return;
			const element = newSlideElement(
				file.type === "image/svg+xml" ? "svg" : "image",
				slide.elements.length,
			);
			element.src = src;
			element.text = file.name;
			addElement(element);
		} catch (error) {
			message(reason(error), true, 6000);
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

	// ---- Presenting ----

	/** Controls and the cursor fade away while the pointer rests. */
	function wake() {
		presenter.classList.remove("idle");
		clearTimeout(idleTimer);
		if (!presenter.hidden)
			idleTimer = setTimeout(() => presenter.classList.add("idle"), 2200);
	}
	const step = (by: number) =>
		selectSlide((deck?.slides.indexOf(active()!) ?? 0) + by);
	button("present").onclick = () => {
		commitText();
		presentedId = undefined;
		presenter.hidden = false;
		renderPresentation();
		presenter.focus({ preventScroll: true });
		wake();
	};
	button("exit").onclick = () => {
		presenter.hidden = true;
		clearTimeout(idleTimer);
		render();
		button("present").focus();
	};
	button("previous").onclick = () => step(-1);
	button("next").onclick = () => step(1);
	presentStage.onclick = () => step(1);
	presenter.onpointermove = wake;
	presenter.onpointerdown = wake;

	// ---- Export ----

	async function exportAs(format: (typeof EXPORTS)[number][0]) {
		if (exporting || !available) return;
		const name = EXPORTS.find(([id]) => id === format)![1];
		exporting = true;
		controls();
		message(`Preparing ${name}…`);
		try {
			// The download holds what is saved, so wait for the save in progress.
			await flush();
			if (dirty)
				throw new Error("your latest changes are not saved yet. Try again");
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
			message(`${name} is ready`, false, 2400);
		} catch (error) {
			message(`Could not export: ${reason(error)}.`, true, 8000);
		} finally {
			exporting = false;
			controls();
			scheduleSave();
			refreshExternal();
		}
	}
	for (const item of root.querySelectorAll<HTMLButtonElement>("[data-export]"))
		item.onclick = () =>
			void exportAs(item.dataset.export as (typeof EXPORTS)[number][0]);

	// ---- Keyboard ----

	const onKeyDown = (event: KeyboardEvent) => {
		const command = event.metaKey || event.ctrlKey;
		if (command && event.key.toLowerCase() === "s") {
			event.preventDefault();
			void flush(true);
			return;
		}
		const target = event.target as HTMLElement;
		if (
			target.closest(
				"input,textarea,select,summary,[contenteditable=true],[role=menu]",
			)
		)
			return;
		if (!presenter.hidden) {
			const last = (deck?.slides.length ?? 1) - 1;
			if (event.key === "Escape") button("exit").click();
			else if (
				["ArrowRight", "ArrowDown", "PageDown"].includes(event.key) ||
				(event.key === " " && !target.closest("button"))
			)
				step(1);
			else if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) step(-1);
			else if (event.key === "Home") selectSlide(0);
			else if (event.key === "End") selectSlide(last);
			else return;
			event.preventDefault();
			wake();
			return;
		}
		if (command && event.key.toLowerCase() === "z") {
			event.preventDefault();
			button(event.shiftKey ? "redo" : "undo").click();
			return;
		}
		if (command && event.key.toLowerCase() === "y") {
			event.preventDefault();
			button("redo").click();
			return;
		}
		const action = slideElementShortcut(event);
		if (action) {
			event.preventDefault();
			elementAction(action);
			return;
		}
		if (event.key === "Escape") {
			if (selectedId) {
				selectedId = null;
				render();
			} else if (inspectorOpen) setInspector(false);
			return;
		}
		const element = selected();
		if (!element) {
			if (event.key === "PageDown" || event.key === "PageUp") {
				event.preventDefault();
				step(event.key === "PageDown" ? 1 : -1);
			}
			return;
		}
		if (event.key === "Enter") {
			// Enter on a button presses that button.
			if (target.closest("button")) return;
			event.preventDefault();
			setInspector(true, true);
			return;
		}
		if (event.key === "Delete" || event.key === "Backspace") {
			event.preventDefault();
			elementAction("delete");
			return;
		}
		const delta = event.shiftKey ? 10 : 1;
		const [dx, dy] =
			{
				ArrowLeft: [-delta, 0],
				ArrowRight: [delta, 0],
				ArrowUp: [0, -delta],
				ArrowDown: [0, delta],
			}[event.key] ?? [];
		if (dx === undefined || dy === undefined) return;
		event.preventDefault();
		// A run of nudges is one undo step and one save.
		mutate(
			() =>
				updateElement(
					updateElementGeometry(selected()!, {
						x: element.x + dx,
						y: element.y + dy,
					}),
				),
			`nudge:${element.id}`,
		);
	};
	root.addEventListener("keydown", onKeyDown);
	await load();
	return {
		save: () => flush(true),
		destroy() {
			destroyed = true;
			for (const timer of [
				saveTimer,
				draftTimer,
				statusTimer,
				idleTimer,
				pillTimer,
			])
				clearTimeout(timer);
			fitObserver?.disconnect();
			thumbWatch?.disconnect();
			window.removeEventListener("message", onMessage);
			window.removeEventListener("pagehide", onLeave);
			document.removeEventListener("visibilitychange", onHide);
			document.removeEventListener("pointerdown", onOutside);
			root.removeEventListener("keydown", onKeyDown);
			root.removeEventListener("paste", onPaste);
			stage.removeEventListener("pointermove", onPointerMove);
			stage.removeEventListener("pointerup", endPointer);
			stage.removeEventListener("pointercancel", endPointer);
			style.remove();
		},
	};
}
