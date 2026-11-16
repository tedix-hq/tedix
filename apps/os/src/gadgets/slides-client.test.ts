import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SLIDES_CLIENT_SOURCE } from "@tedix/api-contract/assets/slides-blueprint";
import { mountSlidesClient, type SlidesClientBridge } from "./slides-client";
import { projectDeck, type PresentationContent } from "./slides-engine";
import {
	applyOutputPatch,
	diffOutputContent,
	type OutputPatch,
} from "@tedix/api-contract/utils/output-patch";
import { projectPresentationDeck } from "@tedix/api-contract/utils/presentation-patch";

const projections = { presentationSlides: projectPresentationDeck };

const workspaceId = "11111111-1111-4111-8111-111111111111",
	outputId = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void> = [];
afterEach(() => {
	vi.useRealTimers();
	cleanup.splice(0).forEach((fn) => fn());
	document.body.replaceChildren();
	vi.restoreAllMocks();
});
const button = (id: string) =>
	document.querySelector<HTMLButtonElement>(`#${id}`)!;
const field = (label: string) =>
	document.querySelector<
		HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
	>(`[aria-label="${label}"]`)!;
const status = () => document.querySelector(".slides-status")?.textContent;
const stage = () => document.querySelector<HTMLElement>(".slides-stage")!;
const stageElement = (id = "title-1") =>
	document.querySelector<HTMLElement>(
		`.slides-stage [data-element-id="${id}"]`,
	)!;
const format = () => {
	if (button("format").getAttribute("aria-expanded") !== "true")
		button("format").click();
};
const insert = (type: string) =>
	document.querySelector<HTMLButtonElement>(`[data-insert="${type}"]`)!.click();
const thumb = (id: string) =>
	document.querySelector<HTMLElement>(`[data-slide-id="${id}"]`)!;
const key = (target: Element, init: KeyboardEventInit) =>
	target.dispatchEvent(
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
	);
const change = (label: string, value: string) => {
	field(label).value = value;
	field(label).dispatchEvent(new Event("change"));
};
const press = (id = "title-1", x = 100, y = 80, pointerId = 1) =>
	stageElement(id).dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			pointerId,
			clientX: x,
			clientY: y,
		}),
	);
const move = (x: number, y: number, pointerId = 1, altKey = false) =>
	stage().dispatchEvent(
		new PointerEvent("pointermove", {
			bubbles: true,
			pointerId,
			clientX: x,
			clientY: y,
			altKey,
		}),
	);
const pressWith = (id: string, init: PointerEventInit) =>
	stageElement(id).dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			pointerId: 1,
			clientX: 100,
			clientY: 80,
			...init,
		}),
	);
const pressSlide = (x: number, y: number, init: PointerEventInit = {}) =>
	document.querySelector(".slides-stage .slides-background")!.dispatchEvent(
		new PointerEvent("pointerdown", {
			bubbles: true,
			button: 0,
			pointerId: 1,
			clientX: x,
			clientY: y,
			...init,
		}),
	);
const chosenIds = () =>
	[...document.querySelectorAll<HTMLElement>(".slides-stage .selected")].map(
		(node) => node.dataset.elementId,
	);
const grips = () => document.querySelectorAll(".slides-stage .slides-resize");
const release = (pointerId = 1) =>
	stage().dispatchEvent(new PointerEvent("pointerup", { pointerId }));
const clickElement = (id = "title-1") => {
	press(id);
	release();
};
function fullSizeStage() {
	vi.spyOn(stage(), "getBoundingClientRect").mockReturnValue({
		x: 0,
		y: 0,
		width: 1200,
		height: 675,
		top: 0,
		left: 0,
		right: 1200,
		bottom: 675,
		toJSON() {},
	});
}

function fixture(role = "owner", write = true) {
	let denied = false,
		failures = 0;
	let draftGate: Promise<void> | undefined;
	let releaseDraft: (() => void) | undefined;
	let revision = 3,
		draft: { revision: number; content: PresentationContent } | null = null;
	// Who saved the newest revision: a person, or an agent.
	let savedBy = "user";
	let content = projectDeck({
		width: 1200,
		height: 675,
		activeSlideId: "slide-1",
		theme: { headingFont: "Georgia", bodyFont: "Arial" },
		slides: [
			{
				id: "slide-1",
				name: "One",
				layout: "title-content",
				background: "linear-gradient(120deg, #ffffff, #ddeeff)",
				backgroundImage: "data:image/png;base64,aGVsbG8=",
				dotGridOpacity: 0.1,
				notes: "Preserved notes",
				elements: [
					{
						id: "title-1",
						type: "title",
						x: 72,
						y: 60,
						width: 800,
						height: 100,
						text: "Original title",
						style: { fontSize: 46, fontFamily: "Georgia", color: "#123456" },
					},
					{
						id: "artwork",
						type: "card",
						x: 100,
						y: 240,
						width: 350,
						height: 180,
						props: {
							title: "Artwork",
							body: "Keep this",
							tone: "accent",
							kind: "rectangle",
						},
						style: { borderRadius: 22, background: "#ffeecc" },
					},
				],
			},
			{
				id: "slide-2",
				name: "Two",
				layout: "blank",
				background: "#eeeeee",
				elements: [],
				notes: "Second notes",
			},
		],
	});
	// What the server holds at each revision a client has read or saved.
	const stored = new Map<number, PresentationContent>();
	const result = () => {
		stored.set(revision, content);
		return {
			output: { id: outputId, workspaceId, title: "Launch canvas" },
			revision: { revision, content: structuredClone(content) },
		};
	};
	const call = vi.fn(
		async (method: string, args?: unknown): Promise<unknown> => {
			const input = args as {
				slot: string;
				content: PresentationContent;
				revision: number;
				expectedRevision: number;
				baseRevision: number;
				sinceRevision: number;
				patch: OutputPatch;
				method: string;
			};
			if (method === "context")
				return {
					workspaceId,
					role,
					settings: { slot: "slides" },
					grants: [
						{
							slot: "slides",
							operations: write
								? ["outputs.read", "outputs.write"]
								: ["outputs.read"],
						},
					],
				};
			if (denied && method !== "app.draft.clear")
				throw new Error("Source access denied");
			if (method === "app.draft.read") return structuredClone(draft);
			if (method === "app.draft.write") {
				await draftGate;
				draft = structuredClone({
					revision: input.revision,
					content: input.content,
				});
				return null;
			}
			if (method === "app.draft.clear") {
				draft = null;
				return null;
			}
			if (method === "app.call" && input.method === "readPresentation")
				return result();
			if (method === "outputs.readRevision") {
				if (input.revision === undefined) return result();
				const older = stored.get(input.revision);
				if (!older) throw new Error("Output revision not found");
				return {
					output: result().output,
					revision: {
						revision: input.revision,
						content: structuredClone(older),
					},
				};
			}
			if (method === "outputs.patch") {
				if (failures-- > 0) throw new Error("Network unreachable");
				if (input.slot !== "slides" || input.baseRevision !== revision)
					throw Object.assign(new Error("Revision conflict"), {
						code: "revision_conflict",
					});
				// Only the changed parts arrive; the server applies them to its copy.
				const sent = applyOutputPatch(content, input.patch, projections);
				const parsed = OsOutputContentSchema.parse(sent);
				if (parsed.kind !== "presentation")
					throw new Error("Wrong content kind");
				content = parsed;
				revision++;
				stored.set(revision, content);
				return {
					output: result().output,
					revision: { revision },
					mergedWith: null,
					catchUp: diffOutputContent(sent, parsed),
				};
			}
			if (method === "outputs.changes") {
				const since = stored.get(input.sinceRevision);
				return {
					output: result().output,
					revision: { revision, createdByKind: savedBy },
					patch: since ? diffOutputContent(since, content) : null,
					...(since ? {} : { content: structuredClone(content) }),
				};
			}
			if (method === "outputs.replace")
				throw new Error("The editor must not send the whole presentation");
			if (method === "app.exportOutput") {
				if (input.expectedRevision !== revision)
					throw new Error("Export revision conflict");
				return { revision, format: "pptx", filename: "Launch.pptx" };
			}
			if (method === "app.call" && input.method === "exportOutline")
				return {
					title: "Launch canvas",
					mimeType: "text/markdown",
					text: content.slides[0]?.title,
				};
			if (method === "app.download") return { filename: "Launch.md" };
			throw new Error(`Unexpected method: ${method}`);
		},
	);
	return {
		bridge: { call } as SlidesClientBridge,
		call,
		result,
		draft: () => draft,
		holdDraftWrites() {
			draftGate = new Promise((resolve) => {
				releaseDraft = resolve;
			});
			return () => {
				releaseDraft?.();
				draftGate = undefined;
			};
		},
		failSaves(count: number) {
			failures = count;
		},
		saves: () =>
			call.mock.calls.filter(([method]) => method === "outputs.patch").length,
		patches: () =>
			call.mock.calls
				.filter(([method]) => method === "outputs.patch")
				.map(([, args]) => (args as { patch: OutputPatch }).patch),
		draftWrites: () =>
			call.mock.calls.filter(([method]) => method === "app.draft.write").length,
		seedDraft(basis: number, text: string) {
			draft = structuredClone({ revision: basis, content });
			draft.content.deck!.slides[0]!.elements[0]!.text = text;
		},
		load(next: PresentationContent) {
			content = next;
		},
		deny() {
			denied = true;
		},
		externalDeck(
			change: (
				deck: NonNullable<PresentationContent["deck"]>,
			) => NonNullable<PresentationContent["deck"]>,
		) {
			savedBy = "user";
			revision++;
			content = { ...content, deck: change(structuredClone(content.deck!)) };
		},
		external(by = "user", text = "External title") {
			savedBy = by;
			revision++;
			content = {
				...content,
				deck: {
					...content.deck!,
					slides: content.deck!.slides.map((slide, index) =>
						index === 0
							? {
									...slide,
									elements: slide.elements.map((element) =>
										element.id === "title-1" ? { ...element, text } : element,
									),
								}
							: slide,
					),
				},
			};
		},
		notify(
			source: MessageEventSource | null = window.parent,
			slot = "slides",
			id = outputId,
		) {
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					data: {
						jsonrpc: "2.0",
						method: "tedix/outputs-changed",
						params: { outputs: [{ slot, outputId: id, revision }] },
					},
				}),
			);
		},
	};
}
async function mount(
	role = "owner",
	write = true,
	prepare?: (api: ReturnType<typeof fixture>) => void,
	view: "view" | "edit" = "edit",
) {
	document.body.innerHTML = '<div id="app"></div>';
	const api = fixture(role, write);
	prepare?.(api);
	const app = await mountSlidesClient(
		document.getElementById("app")!,
		api.bridge,
	);
	cleanup.push(() => app.destroy());
	// Most tests edit: switch out of the view mode a presentation opens in.
	if (view !== "view") {
		const mode = document.querySelector<HTMLButtonElement>("#mode");
		if (mode && !mode.hidden && mode.getAttribute("aria-pressed") !== "true")
			mode.click();
	}
	return { ...api, app };
}

describe("portable Slides canvas", () => {
	it("opens a 500-slide deck, drawing the first thumbnails at once and the rest as they come into view", async () => {
		let seen: IntersectionObserverCallback | undefined;
		const watched = new Set<Element>();
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				constructor(callback: IntersectionObserverCallback) {
					seen = callback;
				}
				observe(target: Element) {
					watched.add(target);
				}
				unobserve(target: Element) {
					watched.delete(target);
				}
				disconnect() {}
			},
		);
		cleanup.push(() => vi.unstubAllGlobals());
		const deck = projectDeck({
			width: 1200,
			height: 675,
			activeSlideId: "s-0",
			slides: Array.from({ length: 500 }, (_, index) => ({
				id: `s-${index}`,
				name: `Slide ${index + 1}`,
				layout: "title" as const,
				background: "#ffffff",
				elements: [
					{
						id: `t-${index}`,
						type: "title" as const,
						x: 72,
						y: 60,
						width: 800,
						height: 100,
						text: `Title ${index + 1}`,
						style: { fontSize: 46 },
					},
				],
			})),
		});
		expect(OsOutputContentSchema.parse(deck).kind).toBe("presentation");
		await mount("owner", true, (api) => api.load(deck));
		const drawn = (index: number) =>
			thumb(`s-${index}`).querySelector(".slides-thumb-canvas")!.children
				.length > 0;
		expect(document.querySelectorAll("[data-slide-id]")).toHaveLength(500);
		expect(watched.size).toBe(500);
		expect(drawn(0)).toBe(true);
		expect(drawn(39)).toBe(true);
		expect(drawn(40)).toBe(false);
		expect(drawn(450)).toBe(false);
		expect(
			[...document.querySelectorAll(".slides-thumb-canvas")].filter(
				(canvas) => canvas.children.length > 0,
			),
		).toHaveLength(40);
		// Scrolling the list to slide 451 draws it.
		seen!(
			[
				{ target: thumb("s-450"), isIntersecting: true },
			] as unknown as IntersectionObserverEntry[],
			{} as IntersectionObserver,
		);
		expect(drawn(450)).toBe(true);
		// Opening a slide far down draws its thumbnail too.
		thumb("s-300").querySelector<HTMLButtonElement>("button")!.click();
		expect(drawn(300)).toBe(true);
		expect(stageElement("t-300").textContent).toContain("Title 301");
		// 500 is the most a deck holds.
		expect(button("add-slide").disabled).toBe(true);
	});
	it("draws linked images from one embedded copy per link and never stores that copy", async () => {
		vi.useFakeTimers();
		const link = "https://example.org/visual.png";
		const embedded = "data:image/png;base64,ZW1iZWRkZWQ=";
		let fail = true;
		const api = await mount("owner", true, (api) => {
			api.seedDraft(3, "With artwork");
			const slide = api.draft()!.content.deck!.slides[0]!;
			slide.backgroundImage = link;
			Object.assign(slide.elements[1]!, { type: "image", src: link });
			const answer = api.call.getMockImplementation()!;
			api.call.mockImplementation(async (method, args) => {
				if (method !== "outputs.image") return answer(method, args);
				expect(args).toEqual({ slot: "slides", url: link });
				if (fail)
					throw new Error("This link is not an image of the saved file");
				return { dataUrl: embedded };
			});
		});
		const images = () => [
			...document.querySelectorAll<HTMLImageElement>("img[data-linked-image]"),
		];
		const requests = () =>
			api.call.mock.calls.filter(([method]) => method === "outputs.image")
				.length;
		// Stage and rail thumbnail, each with the element and the background.
		expect(images()).toHaveLength(4);
		expect(document.body.innerHTML).not.toContain('src="https:');
		expect(requests()).toBe(1);
		await vi.advanceTimersByTimeAsync(0);
		expect(images().map((image) => image.dataset.linkedState)).toEqual(
			Array(4).fill("failed"),
		);
		// The restored edits save; the link is readable from then on.
		fail = false;
		await vi.advanceTimersByTimeAsync(1600);
		expect(api.saves()).toBe(1);
		expect(requests()).toBe(2);
		expect(images().map((image) => image.getAttribute("src"))).toEqual(
			Array(4).fill(embedded),
		);
		expect(images().some((image) => image.dataset.linkedState)).toBe(false);
		button("present").click();
		expect(
			document
				.querySelector(".slides-present-stage img[data-linked-image]")
				?.getAttribute("src"),
		).toBe(embedded);
		expect(requests()).toBe(2);
		const saved = JSON.stringify(api.result().revision.content);
		expect(saved).toContain(link);
		expect(saved).not.toContain(embedded);
		expect(
			JSON.stringify(
				api.call.mock.calls.filter(([method]) => method !== "outputs.image"),
			),
		).not.toContain(embedded);
	});
	it("posts edits before immediate iframe removal, restores them on reopen and saves them", async () => {
		const api = await mount();
		stageElement().dispatchEvent(new Event("dblclick"));
		const input = field("Edit canvas text") as HTMLTextAreaElement;
		input.value = "Immediate draft";
		input.dispatchEvent(new Event("input"));
		expect(api.call).toHaveBeenCalledWith(
			"app.draft.write",
			expect.objectContaining({
				revision: 3,
				content: expect.objectContaining({ kind: "presentation" }),
			}),
		);
		api.app.destroy();
		vi.useFakeTimers();
		document.body.innerHTML = '<div id="app"></div>';
		const reopened = await mountSlidesClient(
			document.getElementById("app")!,
			api.bridge,
		);
		cleanup.push(() => reopened.destroy());
		expect(stageElement().textContent).toBe("Immediate draft");
		expect(api.saves()).toBe(0);
		await vi.advanceTimersByTimeAsync(1600);
		expect(api.result().revision.content.slides[0]?.title).toBe(
			"Immediate draft",
		);
		expect(api.draft()).toBeNull();
	});
	it("says once why a file over the limit is not saved, stops retrying and tries the next change", async () => {
		vi.useFakeTimers();
		const api = await mount();
		const mark = () => document.querySelector<HTMLElement>(".slides-save")!;
		expect(mark().hidden).toBe(false);
		expect(mark().title).toBe("All changes saved");
		const answer = api.call.getMockImplementation()!;
		let refuse = true;
		api.call.mockImplementation(async (method, args) => {
			if (method === "outputs.patch" && refuse)
				throw Object.assign(new Error("too_large"), { code: "too_large" });
			return answer(method, args);
		});
		const attempts = () =>
			api.call.mock.calls.filter(([method]) => method === "outputs.patch")
				.length;
		clickElement();
		format();
		change("Text", "Too big");
		expect(mark().title).toBe("Changes not saved yet");
		await vi.advanceTimersByTimeAsync(1600);
		expect(attempts()).toBe(1);
		expect(status()).toBe(
			"This file is over the 8 MB limit, so new changes are not saved. Remove or shrink large images.",
		);
		expect(mark().dataset.state).toBe("failed");
		expect(mark().title).toContain("Not saved. This file is over the 8 MB");
		expect(api.draft()).not.toBeNull();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(attempts()).toBe(1);
		refuse = false;
		change("Text", "Smaller");
		await vi.advanceTimersByTimeAsync(1600);
		expect(attempts()).toBe(2);
		expect(status()).toBe("");
		expect(mark().title).toBe("All changes saved");
		expect(api.result().revision.content.slides[0]?.title).toBe("Smaller");
	});
	it("keeps retrying quietly when a save fails for a passing reason", async () => {
		vi.useFakeTimers();
		const api = await mount();
		api.failSaves(2);
		clickElement();
		format();
		change("Text", "Flaky network");
		await vi.advanceTimersByTimeAsync(230);
		expect(status()).toContain("saving will try again");
		expect(
			document.querySelector<HTMLElement>(".slides-save")!.dataset.state,
		).toBe("failed");
		// Retries follow after 40 ms, then 80 ms.
		await vi.advanceTimersByTimeAsync(200);
		expect(api.result().revision.content.slides[0]?.title).toBe(
			"Flaky network",
		);
		expect(status()).toBe("");
	});
	it("saves by itself after a pause, stays quiet and flashes Saved on Ctrl+S", async () => {
		vi.useFakeTimers();
		const api = await mount();
		expect(document.querySelector("#save,#reload")).toBeNull();
		clickElement();
		format();
		change("Text", "First edit");
		await vi.advanceTimersByTimeAsync(150);
		change("Font size", "50");
		// 220 ms after the last edit, not after the first.
		await vi.advanceTimersByTimeAsync(200);
		expect(api.saves()).toBe(0);
		await vi.advanceTimersByTimeAsync(30);
		expect(api.saves()).toBe(1);
		// Only the two changed properties of one element travelled.
		expect(api.patches()).toEqual([
			{
				kind: "presentation",
				ops: [
					{
						op: "set",
						path: [
							"deck",
							"slides",
							{ id: "slide-1" },
							"elements",
							{ id: "title-1" },
							"text",
						],
						value: "First edit",
					},
					{
						op: "set",
						path: [
							"deck",
							"slides",
							{ id: "slide-1" },
							"elements",
							{ id: "title-1" },
							"style",
							"fontSize",
						],
						value: 50,
					},
				],
			},
		]);
		expect(status()).toBe("");
		expect(
			api.result().revision.content.deck!.slides[0]!.elements[0],
		).toMatchObject({ text: "First edit", style: { fontSize: 50 } });
		expect(api.draft()).toBeNull();
		key(stage(), { key: "s", ctrlKey: true });
		await vi.advanceTimersByTimeAsync(0);
		expect(status()).toBe("Saved");
		await vi.advanceTimersByTimeAsync(2000);
		expect(status()).toBe("");
		expect(api.saves()).toBe(1);
	});
	it("never waits longer than the maximum while edits keep coming", async () => {
		vi.useFakeTimers();
		const api = await mount();
		clickElement();
		// An edit every 200 ms never leaves a 220 ms pause; the save still
		// goes out 1.2 s after the first of them.
		for (let index = 0; index < 5; index++) {
			key(stage(), { key: "ArrowRight" });
			await vi.advanceTimersByTimeAsync(200);
		}
		expect(api.saves()).toBe(0);
		key(stage(), { key: "ArrowRight" });
		await vi.advanceTimersByTimeAsync(200);
		expect(api.saves()).toBe(1);
	});
	it("holds a save while a drag is under way and sends it when the drag ends", async () => {
		vi.useFakeTimers();
		const api = await mount();
		fullSizeStage();
		clickElement();
		format();
		change("Text", "Before the drag");
		// The pointer goes down before the pause that would have saved.
		await vi.advanceTimersByTimeAsync(100);
		press("title-1", 100, 80);
		move(160, 120);
		await vi.advanceTimersByTimeAsync(3000);
		expect(api.saves()).toBe(0);
		release();
		await vi.advanceTimersByTimeAsync(230);
		// The text and the move travel in one save.
		expect(api.saves()).toBe(1);
		expect(
			api.result().revision.content.deck!.slides[0]!.elements[0],
		).toMatchObject({ text: "Before the drag" });
	});
	it("keeps trying after a failed save and says so in plain words", async () => {
		vi.useFakeTimers();
		const api = await mount();
		api.failSaves(1);
		clickElement();
		format();
		change("Text", "Survives a failure");
		await vi.advanceTimersByTimeAsync(230);
		expect(status()).toContain("not saved yet");
		expect(api.draft()?.content.deck!.slides[0]!.elements[0]!.text).toBe(
			"Survives a failure",
		);
		// The first retry follows 40 ms after the failure, not sooner.
		expect(api.saves()).toBe(1);
		await vi.advanceTimersByTimeAsync(20);
		expect(api.saves()).toBe(1);
		await vi.advanceTimersByTimeAsync(30);
		expect(api.saves()).toBe(2);
		expect(api.result().revision.content.slides[0]?.title).toBe(
			"Survives a failure",
		);
		expect(status()).toBe("");
		expect(api.draft()).toBeNull();
	});
	it("saves when the tab is hidden", async () => {
		const api = await mount();
		clickElement();
		format();
		change("Text", "Hidden tab");
		vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.waitFor(() =>
			expect(api.result().revision.content.slides[0]?.title).toBe("Hidden tab"),
		);
	});
	it.each(["save", "denial"] as const)(
		"clears drafts after all pending write receipts on %s",
		async (action) => {
			const api = await mount(),
				release = api.holdDraftWrites();
			clickElement();
			format();
			change("Text", "Pending draft");
			if (action === "save") void api.app.save();
			else {
				api.deny();
				api.external();
				api.notify();
			}
			await Promise.resolve();
			await Promise.resolve();
			expect(
				api.call.mock.calls.some(([method]) => method === "app.draft.clear"),
			).toBe(false);
			release();
			await vi.waitFor(() =>
				expect(
					api.call.mock.calls.some(([method]) => method === "app.draft.clear"),
				).toBe(true),
			);
			expect(api.draft()).toBeNull();
			if (action === "save")
				expect(api.result().revision.content.slides[0]?.title).toBe(
					"Pending draft",
				);
		},
	);

	it("edits styled canvas text and notes without replacing artwork or identities", async () => {
		const api = await mount();
		const before = api.result().revision.content.deck!;
		clickElement();
		format();
		change("Text", "Edited title");
		change("Font size", "56");
		change("Fill", "#eefaff");
		const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
		notes.value = "New speaker note";
		notes.dispatchEvent(new Event("change"));
		await api.app.save();
		const next = api.result().revision.content.deck!;
		expect(next.theme).toEqual(before.theme);
		expect(next.slides[0]).toMatchObject({
			id: "slide-1",
			background: before.slides[0]!.background,
			backgroundImage: before.slides[0]!.backgroundImage,
			dotGridOpacity: 0.1,
			notes: "New speaker note",
		});
		expect(next.slides[0]!.elements[0]).toMatchObject({
			id: "title-1",
			x: 72,
			y: 60,
			text: "Edited title",
			style: {
				fontSize: 56,
				fontFamily: "Georgia",
				color: "#123456",
				background: "#eefaff",
			},
		});
		expect(next.slides[0]!.elements[1]).toEqual(before.slides[0]!.elements[1]);
		expect(api.call).toHaveBeenCalledWith(
			"outputs.patch",
			expect.objectContaining({ slot: "slides", baseRevision: 3 }),
		);
	});
	it("drags and resizes in slide coordinates with one draft and one undo step per gesture", async () => {
		const api = await mount();
		fullSizeStage();
		format();
		press();
		const node = stageElement();
		move(102, 80, 1, true);
		expect(node.style.left).toBe("6%");
		move(130, 100, 1, true);
		move(130, 100, 1, true);
		// Only the moving node changes until the pointer is released.
		expect(stageElement()).toBe(node);
		expect(node.style.left).toBe("8.5%");
		expect(api.draftWrites()).toBe(0);
		expect(button("undo").disabled).toBe(true);
		release();
		expect(api.draftWrites()).toBe(1);
		expect(stageElement()).toBe(node);
		expect(field("X").value).toBe("102");
		expect(field("Y").value).toBe("80");
		button("undo").click();
		expect(field("X").value).toBe("72");
		expect(button("undo").disabled).toBe(true);
		button("redo").click();
		expect(field("X").value).toBe("102");
		const grip = (handle: string) =>
			document.querySelector<HTMLElement>(
				`.slides-resize[data-handle="${handle}"]`,
			)!;
		grip("se").dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 2,
				clientX: 0,
				clientY: 0,
			}),
		);
		move(80, 20, 2);
		release(2);
		expect(field("Width").value).toBe("880");
		expect(field("Height").value).toBe("120");
		// A resize stops at a size that can still be grabbed.
		grip("se").dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 3,
				clientX: 0,
				clientY: 0,
			}),
		);
		move(-2000, -2000, 3);
		release(3);
		expect(field("Width").value).toBe("40");
		expect(field("Height").value).toBe("24");
		button("undo").click();
		button("forward").click();
		await api.app.save();
		expect(
			api.result().revision.content.deck!.slides[0]!.elements.at(-1),
		).toMatchObject({ id: "title-1", x: 102, y: 80, width: 880, height: 120 });
	});
	it("ignores a press that barely moves and draws snap guides while dragging", async () => {
		const api = await mount();
		fullSizeStage();
		press();
		move(102, 81);
		release();
		expect(api.draftWrites()).toBe(0);
		expect(button("undo").disabled).toBe(true);
		press();
		// The title's centre lands two units from the slide's centre and snaps.
		move(226, 80);
		expect(document.querySelectorAll(".slides-guide.v")).toHaveLength(1);
		expect(stageElement().style.left).toBe(`${(200 / 1200) * 100}%`);
		release();
		expect(document.querySelectorAll(".slides-guide")).toHaveLength(0);
		format();
		expect(field("X").value).toBe("200");
	});
	describe("several selected elements", () => {
		const elementsOf = async (api: Awaited<ReturnType<typeof mount>>) => {
			await api.app.save();
			return Object.fromEntries(
				api
					.result()
					.revision.content.deck!.slides[0]!.elements.map((element) => [
						element.id,
						{ x: element.x, y: element.y },
					]),
			);
		};
		const selectBoth = () => {
			clickElement();
			pressWith("artwork", { shiftKey: true });
			release();
		};
		it("adds and removes elements with Shift, Cmd or Ctrl, and shows resize handles only for one", async () => {
			await mount();
			clickElement();
			expect(chosenIds()).toEqual(["title-1"]);
			expect(grips().length).toBeGreaterThan(0);
			pressWith("artwork", { shiftKey: true });
			release();
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
			expect(grips()).toHaveLength(0);
			format();
			expect(document.querySelector("#properties h2")?.textContent).toBe(
				"2 elements",
			);
			pressWith("title-1", { metaKey: true });
			release();
			expect(chosenIds()).toEqual(["artwork"]);
			expect(grips().length).toBeGreaterThan(0);
			pressWith("title-1", { ctrlKey: true });
			release();
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
			// A plain click on one of them, without dragging, selects only that one.
			clickElement("artwork");
			expect(chosenIds()).toEqual(["artwork"]);
		});
		it("selects what a box drawn over the empty slide touches, adding to the selection with Shift", async () => {
			await mount();
			fullSizeStage();
			pressSlide(20, 20);
			move(300, 200);
			expect(document.querySelector(".slides-marquee")).not.toBeNull();
			expect(chosenIds()).toEqual(["title-1"]);
			release();
			expect(document.querySelector(".slides-marquee")).toBeNull();
			expect(chosenIds()).toEqual(["title-1"]);
			pressSlide(20, 230, { shiftKey: true });
			move(200, 300);
			release();
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
			// Without Shift a new box starts over, and a plain click clears it.
			pressSlide(20, 230);
			move(200, 300);
			release();
			expect(chosenIds()).toEqual(["artwork"]);
			pressSlide(1100, 600);
			release();
			expect(chosenIds()).toEqual([]);
		});
		it("drags the whole selection as one change and one undo step, snapping the group's box", async () => {
			const api = await mount();
			fullSizeStage();
			selectBoth();
			press("title-1", 100, 80);
			move(150, 110, 1, true);
			expect(api.draftWrites()).toBe(0);
			release();
			expect(api.draftWrites()).toBe(1);
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 122, y: 90 },
				artwork: { x: 150, y: 270 },
			});
			button("undo").click();
			expect(button("undo").disabled).toBe(true);
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 72, y: 60 },
				artwork: { x: 100, y: 240 },
			});
			// The group's centre lands two units from the slide's centre and snaps.
			press("artwork", 100, 80);
			move(226, 80);
			expect(document.querySelectorAll(".slides-guide.v")).toHaveLength(1);
			release();
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 200, y: 60 },
				artwork: { x: 228, y: 240 },
			});
		});
		it("nudges and deletes the whole selection", async () => {
			const api = await mount();
			selectBoth();
			key(stage(), { key: "ArrowRight" });
			key(stage(), { key: "ArrowRight" });
			key(stage(), { key: "ArrowDown", shiftKey: true });
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 74, y: 70 },
				artwork: { x: 102, y: 250 },
			});
			button("undo").click();
			expect(button("undo").disabled).toBe(true);
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
			key(stage(), { key: "Delete" });
			expect(chosenIds()).toEqual([]);
			expect(await elementsOf(api)).toEqual({});
			button("undo").click();
			expect(Object.keys(await elementsOf(api))).toEqual([
				"title-1",
				"artwork",
			]);
		});
		it("lines up the selection from the Align menu as one undo step", async () => {
			const api = await mount();
			expect(button("align").disabled).toBe(true);
			clickElement();
			expect(button("align").disabled).toBe(true);
			pressWith("artwork", { shiftKey: true });
			release();
			expect(button("align").disabled).toBe(false);
			const item = (mode: string) =>
				document.querySelector<HTMLButtonElement>(`[data-align="${mode}"]`)!;
			// Spacing evenly needs three elements.
			expect(item("distribute-horizontal").disabled).toBe(true);
			item("right").click();
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 72, y: 60 },
				artwork: { x: 522, y: 240 },
			});
			item("middle").click();
			expect(await elementsOf(api)).toEqual({
				"title-1": { x: 72, y: 190 },
				artwork: { x: 522, y: 150 },
			});
			button("undo").click();
			button("undo").click();
			expect(button("undo").disabled).toBe(true);
			expect(chosenIds()).toEqual(["title-1", "artwork"]);
		});
		it("keeps the selection when someone else's save lands, minus what they removed", async () => {
			const api = await mount();
			selectBoth();
			api.externalDeck((deck) => ({
				...deck,
				slides: deck.slides.map((slide) => ({
					...slide,
					elements: slide.elements.filter(
						(element) => element.id !== "artwork",
					),
				})),
			}));
			api.notify();
			await vi.waitFor(() => expect(stageElement("artwork")).toBeNull());
			expect(chosenIds()).toEqual(["title-1"]);
			expect(grips().length).toBeGreaterThan(0);
		});
	});
	it("folds a run of arrow-key nudges into one undo step", async () => {
		const api = await mount();
		clickElement();
		format();
		for (let index = 0; index < 3; index++) key(stage(), { key: "ArrowRight" });
		key(stage(), { key: "ArrowDown", shiftKey: true });
		expect(field("X").value).toBe("75");
		expect(field("Y").value).toBe("70");
		button("undo").click();
		expect(field("X").value).toBe("72");
		expect(field("Y").value).toBe("60");
		expect(button("undo").disabled).toBe(true);
		expect(api.saves()).toBe(0);
	});
	it("repaints only the changed thumbnail and leaves a focused field alone", async () => {
		await mount();
		const first = thumb("slide-1").querySelector(".slides-thumb-canvas")!,
			second = thumb("slide-2").querySelector(".slides-thumb-canvas")!;
		const firstPaint = first.firstChild,
			secondPaint = second.firstChild;
		clickElement();
		format();
		const size = field("Font size") as HTMLInputElement,
			text = field("Text");
		size.focus();
		size.value = "9";
		key(stage(), { key: "ArrowRight" });
		expect(field("Font size")).toBe(size);
		expect(size.value).toBe("9");
		expect(field("Text")).toBe(text);
		expect(field("X").value).toBe("73");
		expect(thumb("slide-1").querySelector(".slides-thumb-canvas")).toBe(first);
		expect(first.firstChild).not.toBe(firstPaint);
		expect(second.firstChild).toBe(secondPaint);
	});
	it("adds shapes and SVG and duplicates or reorders slides with fresh identities", async () => {
		const api = await mount();
		insert("shape");
		format();
		change("Shape", "ellipse");
		change("Fill", "#abcdef");
		button("duplicate-element").click();
		thumb("slide-1")
			.querySelector<HTMLButtonElement>('[data-act="duplicate"]')!
			.click();
		const copyThumb = document.querySelector<HTMLElement>(
			".slides-thumb.current",
		)!;
		expect(copyThumb.previousElementSibling).toBe(thumb("slide-1"));
		key(copyThumb.querySelector(".slides-thumbnail")!, {
			key: "ArrowDown",
			altKey: true,
		});
		await api.app.save();
		const slides = api.result().revision.content.deck!.slides;
		expect(slides.map((slide) => slide.id)).toEqual([
			"slide-1",
			"slide-2",
			expect.stringMatching(/^slide-/),
		]);
		const copy = slides[2]!;
		expect(copy.notes).toBe("Preserved notes");
		expect(
			copy.elements.every(
				(element) =>
					!slides[0]!.elements.some((original) => original.id === element.id),
			),
		).toBe(true);
		expect(copy.elements.at(-1)).toMatchObject({
			type: "shape",
			props: { kind: "ellipse" },
			style: { background: "#abcdef" },
		});
		insert("svg");
		change(
			"SVG markup",
			'<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
		);
		await api.app.save();
		expect(
			api.result().revision.content.deck!.slides[2]!.elements.at(-1)?.src,
		).toContain("data:image/svg+xml");
	});
	it("adds a slide after the current one and moves through the rail by keyboard", async () => {
		const api = await mount();
		button("add-slide").click();
		const order = () =>
			Array.from(document.querySelectorAll<HTMLElement>(".slides-thumb")).map(
				(item) => item.dataset.slideId,
			);
		expect(order()).toEqual([
			"slide-1",
			expect.stringMatching(/^slide-/),
			"slide-2",
		]);
		const added = order()[1]!;
		expect(thumb(added).classList.contains("current")).toBe(true);
		key(thumb(added).querySelector(".slides-thumbnail")!, { key: "End" });
		expect(thumb("slide-2").classList.contains("current")).toBe(true);
		key(thumb("slide-2").querySelector(".slides-thumbnail")!, { key: "Home" });
		key(thumb("slide-1").querySelector(".slides-thumbnail")!, {
			key: "ArrowDown",
		});
		expect(thumb(added).classList.contains("current")).toBe(true);
		thumb(added)
			.querySelector<HTMLButtonElement>('[data-act="delete"]')!
			.click();
		expect(order()).toEqual(["slide-1", "slide-2"]);
		button("undo").click();
		expect(order()).toHaveLength(3);
		await api.app.save();
		expect(api.result().revision.content.deck!.slides).toHaveLength(3);
	});
	it("stores a typed embedded image with the file and saves only its reference", async () => {
		const reference = `tedix-asset:${"a".repeat(64)}`;
		const src = "data:image/png;base64," + "A".repeat(90_000);
		const api = await mount("owner", true, (api) => {
			const answer = api.call.getMockImplementation()!;
			api.call.mockImplementation(async (method, args) => {
				if (method === "outputs.uploadImage") {
					expect(args).toEqual({ slot: "slides", dataUrl: src });
					return { reference };
				}
				if (method === "outputs.image") {
					expect(args).toEqual({ slot: "slides", url: reference });
					return { dataUrl: src };
				}
				return answer(method, args);
			});
		});
		insert("image");
		format();
		change("Image source", src);
		await vi.waitFor(() =>
			expect(
				document
					.querySelector<HTMLImageElement>(
						".slides-stage img[data-linked-image]",
					)
					?.getAttribute("src"),
			).toBe(src),
		);
		change("Image fit", "cover");
		await api.app.save();
		expect(
			api.result().revision.content.deck!.slides[0]!.elements.at(-1),
		).toMatchObject({ type: "image", src: reference, style: { fit: "cover" } });
		expect(api.call).toHaveBeenCalledWith(
			"outputs.patch",
			expect.objectContaining({ slot: "slides", baseRevision: 3 }),
		);
		// The picture itself travels once, in the upload.
		expect(
			JSON.stringify(
				api.call.mock.calls.filter(
					([method]) => method !== "outputs.uploadImage",
				),
			),
		).not.toContain(src);
		expect(api.draft() ? JSON.stringify(api.draft()) : "").not.toContain(src);
	});
	it("uploads a dropped image file and inserts its reference", async () => {
		const reference = `tedix-asset:${"b".repeat(64)}`;
		const api = await mount("owner", true, (api) => {
			const answer = api.call.getMockImplementation()!;
			api.call.mockImplementation(async (method, args) => {
				if (method === "outputs.uploadImage") return { reference };
				if (method === "outputs.image")
					return { dataUrl: "data:image/svg+xml;base64,PHN2Zy8+" };
				return answer(method, args);
			});
		});
		const file = new File(
			[`<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(3_000)}</svg>`],
			"mark.svg",
			{ type: "image/svg+xml" },
		);
		const drop = new Event("drop", { bubbles: true, cancelable: true });
		Object.assign(drop, { dataTransfer: { files: [file], items: [] } });
		document.querySelector(".slides-stage")!.dispatchEvent(drop);
		await vi.waitFor(() =>
			expect(
				api.call.mock.calls.some(
					([method, args]) =>
						method === "outputs.uploadImage" &&
						String((args as { dataUrl: string }).dataUrl).startsWith(
							"data:image/svg+xml;base64,",
						),
				),
			).toBe(true),
		);
		await api.app.save();
		expect(
			api.result().revision.content.deck!.slides[0]!.elements.at(-1),
		).toMatchObject({ type: "svg", src: reference, text: "mark.svg" });
	});
	it("keeps inline text through someone else's save and asks before overwriting the same part", async () => {
		const api = await mount();
		const target = stageElement();
		clickElement();
		expect(stageElement()).toBe(target);
		target.dispatchEvent(new Event("dblclick"));
		const input = field("Edit canvas text") as HTMLTextAreaElement;
		input.value = "My uncommitted draft";
		input.dispatchEvent(new Event("input"));
		api.external();
		api.notify();
		await Promise.resolve();
		expect(field("Edit canvas text")).toBe(input);
		expect(input.value).toBe("My uncommitted draft");
		input.dispatchEvent(new FocusEvent("blur"));
		const updates = document.querySelector<HTMLElement>(".slides-updates")!;
		await vi.waitFor(() =>
			expect(updates.textContent).toContain("same parts you are editing"),
		);
		expect(updates.textContent).not.toMatch(/\d/);
		expect(stageElement().textContent).toBe("My uncommitted draft");
		expect(api.draft()?.content.deck!.slides[0]!.elements[0]!.text).toBe(
			"My uncommitted draft",
		);
		expect(api.saves()).toBe(0);
		Array.from(updates.querySelectorAll("button"))
			.find((option) => option.textContent === "Keep mine")!
			.click();
		await vi.waitFor(() =>
			expect(api.result().revision.content.slides[0]?.title).toBe(
				"My uncommitted draft",
			),
		);
		expect(updates.textContent).toBe("");
		expect(api.call).toHaveBeenCalledWith(
			"outputs.patch",
			expect.objectContaining({ baseRevision: 4 }),
		);
	});
	it("merges someone else's save into unsaved notes and saves both", async () => {
		const api = await mount();
		const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
		notes.value = "Merged speaker note";
		notes.dispatchEvent(new Event("change"));
		api.external();
		api.notify();
		await vi.waitFor(() =>
			expect(stageElement().textContent).toBe("External title"),
		);
		await vi.waitFor(() =>
			expect(api.result().revision.content.deck!.slides[0]!.notes).toBe(
				"Merged speaker note",
			),
		);
		expect(
			api.result().revision.content.deck!.slides[0]!.elements[0],
		).toMatchObject({ id: "title-1", text: "External title" });
	});
	it("merges after a save is refused because someone else saved first", async () => {
		const api = await mount();
		const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
		notes.value = "Late note";
		notes.dispatchEvent(new Event("change"));
		api.external();
		await api.app.save();
		await vi.waitFor(() =>
			expect(api.result().revision.content.deck!.slides[0]!.notes).toBe(
				"Late note",
			),
		);
		expect(
			api.result().revision.content.deck!.slides[0]!.elements[0],
		).toMatchObject({ text: "External title" });
		expect(status()).not.toContain("conflict");
	});
	it("merges restored edits into a newer saved presentation without asking", async () => {
		const api = await mount("owner", true, (fresh) => {
			fresh.result();
			fresh.seedDraft(3, "Original title");
			fresh.draft()!.content.deck!.slides[1]!.notes = "Restored note";
			fresh.external("user", "Her newer title");
		});
		const updates = document.querySelector<HTMLElement>(".slides-updates")!;
		await vi.waitFor(() =>
			expect(api.result().revision.content.deck!.slides[1]!.notes).toBe(
				"Restored note",
			),
		);
		expect(api.result().revision.content.slides[0]?.title).toBe(
			"Her newer title",
		);
		expect(stageElement().textContent).toBe("Her newer title");
		expect(updates.textContent).toBe("");
		expect(api.call).toHaveBeenCalledWith(
			"outputs.readRevision",
			expect.objectContaining({ revision: 3 }),
		);
	});
	it("asks only about the clashing part when restored edits overlap a newer save", async () => {
		const api = await mount("owner", true, (fresh) => {
			fresh.result();
			fresh.seedDraft(3, "My restored title");
			fresh.draft()!.content.deck!.slides[1]!.notes = "Restored note";
			fresh.external("user", "Her newer title");
		});
		const updates = document.querySelector<HTMLElement>(".slides-updates")!;
		await vi.waitFor(() =>
			expect(updates.textContent).toContain("some of the same parts"),
		);
		expect(api.saves()).toBe(0);
		Array.from(updates.querySelectorAll("button"))
			.find((option) => option.textContent === "Keep mine")!
			.click();
		await vi.waitFor(() =>
			expect(api.result().revision.content.slides[0]?.title).toBe(
				"My restored title",
			),
		);
		expect(api.result().revision.content.deck!.slides[1]!.notes).toBe(
			"Restored note",
		);
		expect(updates.textContent).toBe("");
	});
	it.each(["Keep my edits", "Use the saved version"])(
		"asks which whole version to keep when restored edits start from a revision no longer stored (%s)",
		async (answer) => {
			vi.useFakeTimers();
			const api = await mount("owner", true, (fresh) =>
				fresh.seedDraft(2, "Older unsaved title"),
			);
			const updates = document.querySelector<HTMLElement>(".slides-updates")!;
			expect(stageElement().textContent).toBe("Older unsaved title");
			await vi.advanceTimersByTimeAsync(0);
			expect(updates.textContent).toContain("no longer stored");
			await vi.advanceTimersByTimeAsync(6000);
			expect(api.saves()).toBe(0);
			Array.from(updates.querySelectorAll("button"))
				.find((option) => option.textContent === answer)!
				.click();
			await vi.advanceTimersByTimeAsync(0);
			expect(updates.textContent).toBe("");
			expect(api.draft()).toBeNull();
			const mine = answer === "Keep my edits";
			expect(api.saves()).toBe(mine ? 1 : 0);
			expect(stageElement().textContent).toBe(
				mine ? "Older unsaved title" : "Original title",
			);
			expect(api.result().revision.content.slides[0]?.title).toBe(
				mine ? "Older unsaved title" : "Original title",
			);
		},
	);
	it("applies someone else's save in place and keeps undo history", async () => {
		const api = await mount();
		clickElement("artwork");
		key(stage(), { key: "ArrowRight" });
		await api.app.save();
		const node = stageElement("artwork");
		api.external();
		api.notify();
		await vi.waitFor(() =>
			expect(stageElement().textContent).toBe("External title"),
		);
		expect(stageElement("artwork")).toBe(node);
		expect(node.classList.contains("selected")).toBe(true);
		expect(button("undo").disabled).toBe(false);
	});
	describe("editing shortcuts and quick controls", () => {
		const saved = (api: Awaited<ReturnType<typeof mount>>) =>
			api.result().revision.content.deck!;
		it("moves between slides with the arrow keys, Home and End when nothing is selected", async () => {
			await mount();
			key(stage(), { key: "ArrowRight" });
			expect(thumb("slide-2").classList.contains("current")).toBe(true);
			key(stage(), { key: "Home" });
			expect(thumb("slide-1").classList.contains("current")).toBe(true);
			key(stage(), { key: "End" });
			expect(thumb("slide-2").classList.contains("current")).toBe(true);
			key(stage(), { key: "ArrowLeft" });
			expect(thumb("slide-1").classList.contains("current")).toBe(true);
		});
		it("steps the selected text through the type scale", async () => {
			const api = await mount();
			clickElement("title-1");
			key(stage(), { key: ">", metaKey: true, shiftKey: true });
			await api.app.save();
			expect(saved(api).slides[0]!.elements[0]!.style.fontSize).toBe(48);
			key(stage(), { key: "<", metaKey: true, shiftKey: true });
			key(stage(), { key: "<", metaKey: true, shiftKey: true });
			await api.app.save();
			expect(saved(api).slides[0]!.elements[0]!.style.fontSize).toBe(36);
		});
		it("opens a searchable insert menu with / and inserts the first match on Enter", async () => {
			const api = await mount();
			key(stage(), { key: "/" });
			const search = document.querySelector<HTMLInputElement>(
				".slides-menu-search",
			)!;
			expect(
				document.querySelector("#insert-menu")!.hasAttribute("hidden"),
			).toBe(false);
			expect(document.activeElement).toBe(search);
			search.value = "divi";
			search.dispatchEvent(new Event("input"));
			expect(
				document.querySelector<HTMLElement>('[data-insert="text"]')!.hidden,
			).toBe(true);
			key(search, { key: "Enter" });
			await api.app.save();
			expect(saved(api).slides[0]!.elements.at(-1)!.type).toBe("divider");
		});
		it("lands each further paste a step along", async () => {
			const api = await mount();
			clickElement("artwork");
			key(stage(), { key: "c", metaKey: true });
			key(stage(), { key: "v", metaKey: true });
			key(stage(), { key: "v", metaKey: true });
			await api.app.save();
			const [, , first, second] = saved(api).slides[0]!.elements;
			expect([first!.x, second!.x]).toEqual([124, 148]);
		});
		it("sets a color from the palette in one click", async () => {
			const api = await mount();
			clickElement("title-1");
			format();
			document
				.querySelector<HTMLButtonElement>('[aria-label="Text color: White"]')!
				.click();
			await api.app.save();
			expect(saved(api).slides[0]!.elements[0]!.style.color).toBe("#ffffff");
			expect(
				document
					.querySelector('[aria-label="Text color: White"]')!
					.getAttribute("aria-pressed"),
			).toBe("true");
		});
		it("edits title highlight words", async () => {
			const api = await mount();
			clickElement("title-1");
			format();
			change("Highlight words (comma list)", "Original, title ,");
			await api.app.save();
			expect(saved(api).slides[0]!.elements[0]!.props?.highlight).toEqual([
				"Original",
				"title",
			]);
		});
		it("hides the slide list, shows shortcuts, and captions thumbnails with their title", async () => {
			await mount();
			expect(
				thumb("slide-1").querySelector(".slides-thumb-caption")!.textContent,
			).toBe("Original title");
			expect(
				thumb("slide-2").querySelector(".slides-thumb-caption")!.textContent,
			).toBe("Two");
			key(stage(), { key: "\\", metaKey: true });
			expect(
				document.querySelector<HTMLElement>(".slides-app")!.dataset.rail,
			).toBe("hidden");
			key(stage(), { key: "/", metaKey: true });
			expect(document.querySelector<HTMLElement>("#shortcuts")!.hidden).toBe(
				false,
			);
			key(document.querySelector("#shortcuts")!, { key: "Escape" });
			expect(document.querySelector<HTMLElement>("#shortcuts")!.hidden).toBe(
				true,
			);
		});
	});
	describe("layouts, view mode, selection bar and arrows", () => {
		const saved = (api: Awaited<ReturnType<typeof mount>>) =>
			api.result().revision.content.deck!;
		it("opens for viewing; E switches to editing and back", async () => {
			await mount("owner", true, undefined, "view");
			const app = document.querySelector<HTMLElement>(".slides-app")!;
			expect(app.dataset.mode).toBe("view");
			clickElement("title-1");
			expect(stageElement().classList.contains("selected")).toBe(false);
			key(stage(), { key: "e" });
			expect(app.dataset.mode).toBe("edit");
			expect(button("mode").textContent).toBe("Done");
			clickElement("title-1");
			expect(stageElement().classList.contains("selected")).toBe(true);
			key(stage(), { key: "e" });
			expect(app.dataset.mode).toBe("view");
			expect(stageElement().classList.contains("selected")).toBe(false);
		});
		it("adds a slide from a layout", async () => {
			const api = await mount();
			document
				.querySelector<HTMLButtonElement>('[data-layout="two-column"]')!
				.click();
			await api.app.save();
			const added = saved(api).slides[1]!;
			expect(added.layout).toBe("two-column");
			expect(added.elements.map((element) => element.text)).toContain(
				"Column heading",
			);
			button("add-slide").click();
			await api.app.save();
			expect(saved(api).slides[2]!.layout).toBe("title-content");
		});
		it("shows a selection bar whose actions apply to the selection", async () => {
			const api = await mount();
			clickElement("title-1");
			const bar = document.querySelector<HTMLElement>(".slides-selbar")!;
			expect(bar.hidden).toBe(false);
			bar
				.querySelector<HTMLButtonElement>('[aria-label="Larger text"]')!
				.click();
			bar.querySelector<HTMLButtonElement>('[aria-label="Duplicate"]')!.click();
			await api.app.save();
			const elements = saved(api).slides[0]!.elements;
			expect(elements[0]!.style.fontSize).toBe(48);
			expect(elements).toHaveLength(3);
		});
		it("starts writing when the selected text is clicked again", async () => {
			await mount();
			clickElement("title-1");
			expect(document.querySelector(".slides-inline-editor")).toBeNull();
			clickElement("title-1");
			const editor = document.querySelector<HTMLTextAreaElement>(
				".slides-inline-editor",
			)!;
			expect(editor.value).toBe("Original title");
			expect(editor.placeholder).toBe("Type here");
		});
		it("shows only the fields an element type uses", async () => {
			await mount();
			clickElement("artwork");
			format();
			expect(field("Font size")).not.toBeNull();
			clickElement("title-1");
			button("upload");
			document
				.querySelector<HTMLButtonElement>('[data-insert="divider"]')!
				.click();
			expect(field("Font size")).toBeNull();
			expect(field("Color")).not.toBeNull();
		});
		it("drags one end of an arrow and the arrow follows", async () => {
			const api = await mount();
			insert("arrow");
			fullSizeStage();
			const end = document.querySelector<HTMLElement>(
				'.slides-resize[data-handle="to"]',
			)!;
			end.dispatchEvent(
				new PointerEvent("pointerdown", {
					bubbles: true,
					button: 0,
					pointerId: 1,
					clientX: 600,
					clientY: 400,
				}),
			);
			move(700, 500);
			release();
			await api.app.save();
			const arrow = saved(api).slides[0]!.elements.at(-1)!;
			expect(arrow.props?.to).toEqual({ x: 700, y: 500 });
			expect(arrow.props?.from).toEqual({ x: 200, y: 400 });
		});
		it("zooms in and back to fit", async () => {
			await mount();
			const area = document.querySelector<HTMLElement>(".slides-canvas")!;
			Object.defineProperty(area, "clientWidth", { value: 648 });
			Object.defineProperty(area, "clientHeight", { value: 1000 });
			button("zoom-fit").click();
			// 600 of 1200 slide pixels: fit is 50%; the next step is 75%.
			expect(stage().style.width).toBe("600px");
			button("zoom-in").click();
			expect(stage().style.width).toBe("900px");
			expect(button("zoom-fit").textContent).toBe("75%");
			key(stage(), { key: "0", metaKey: true });
			expect(stage().style.width).toBe("600px");
			expect(button("zoom-fit").textContent).toBe("Fit");
		});
	});
	describe("changes someone else makes while the presentation is open", () => {
		const banner = () => document.querySelector(".slides-updates")!;
		const offer = () =>
			[...banner().querySelectorAll("button")].find(
				(node) => node.textContent === "Undo agent change",
			);
		const landed = async (
			api: Awaited<ReturnType<typeof mount>>,
			text: string,
		) => {
			api.notify();
			await vi.waitFor(() => expect(stageElement().textContent).toBe(text));
		};
		it("lights the changed element and its slide, leaves the rest alone, then lets go", async () => {
			const api = await mount();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			api.external();
			await landed(api, "External title");
			expect(stageElement().classList.contains("landed")).toBe(true);
			expect(stageElement("artwork").classList.contains("landed")).toBe(false);
			expect(thumb("slide-1").classList.contains("landed")).toBe(true);
			expect(thumb("slide-2").classList.contains("landed")).toBe(false);
			// A person's change: nothing to undo here, and nothing to save.
			expect(offer()).toBeUndefined();
			expect(button("undo").disabled).toBe(true);
			expect(api.saves()).toBe(0);
			await vi.advanceTimersByTimeAsync(4_100);
			expect(document.querySelector(".landed")).toBeNull();
		});
		it("follows an editor to the changed slide only 2.5 seconds after they chose a slide", async () => {
			const api = await mount();
			thumb("slide-2").dispatchEvent(
				new PointerEvent("pointerdown", { bubbles: true }),
			);
			thumb("slide-2").querySelector("button")!.click();
			expect(thumb("slide-2").classList.contains("current")).toBe(true);
			// They just clicked: the view stays with them.
			api.external();
			api.notify();
			await vi.waitFor(() =>
				expect(thumb("slide-1").classList.contains("landed")).toBe(true),
			);
			expect(thumb("slide-2").classList.contains("current")).toBe(true);
			const clock = vi.spyOn(Date, "now");
			clock.mockReturnValue(Date.now() + 10_000);
			api.external("user", "Second change");
			api.notify();
			await vi.waitFor(() =>
				expect(thumb("slide-1").classList.contains("current")).toBe(true),
			);
			expect(stageElement().textContent).toBe("Second change");
			expect(stageElement().classList.contains("landed")).toBe(true);
		});
		const renameSecond = (deck: NonNullable<PresentationContent["deck"]>) => ({
			...deck,
			slides: deck.slides.map((slide) =>
				slide.id === "slide-2" ? { ...slide, name: "Renamed" } : slide,
			),
		});
		it("leaves someone with an element selected on their slide and keeps the selection", async () => {
			const api = await mount();
			clickElement("artwork");
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
			api.externalDeck(renameSecond);
			api.notify();
			await vi.waitFor(() =>
				expect(thumb("slide-2").classList.contains("landed")).toBe(true),
			);
			expect(thumb("slide-1").classList.contains("current")).toBe(true);
			expect(stageElement("artwork").classList.contains("selected")).toBe(true);
		});
		it("never moves a reader", async () => {
			const api = await mount("use", false);
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
			api.externalDeck(renameSecond);
			api.notify();
			await vi.waitFor(() =>
				expect(thumb("slide-2").classList.contains("landed")).toBe(true),
			);
			expect(thumb("slide-1").classList.contains("current")).toBe(true);
		});
		it("keeps the person's slide when someone else changes the deck's current slide", async () => {
			const api = await mount();
			api.externalDeck((deck) => ({
				...deck,
				activeSlideId: "slide-2",
				slides: deck.slides.map((slide) =>
					slide.id === "slide-1" ? { ...slide, name: "First" } : slide,
				),
			}));
			api.notify();
			await vi.waitFor(() =>
				expect(thumb("slide-1").classList.contains("landed")).toBe(true),
			);
			expect(thumb("slide-1").classList.contains("current")).toBe(true);
		});
		it("offers to undo an agent's change and undoes it as a new saved change", async () => {
			const api = await mount();
			api.external("tedi");
			await landed(api, "External title");
			expect(banner().textContent).toContain(
				"An agent changed this presentation.",
			);
			offer()!.click();
			expect(stageElement().textContent).toBe("Original title");
			expect(status()).toBe("Agent change undone.");
			expect(offer()).toBeUndefined();
			await api.app.save();
			expect(api.saves()).toBe(1);
			expect(JSON.stringify(api.patches()[0])).toContain("Original title");
			expect(
				api.result().revision.content.deck!.slides[0]!.elements[0]!.text,
			).toBe("Original title");
			// It was the person's own edit: their undo brings the agent's work back.
			button("undo").click();
			expect(stageElement().textContent).toBe("External title");
		});
		it("undoes the agent's change with the undo shortcut while it is the newest change", async () => {
			const api = await mount();
			clickElement("artwork");
			key(stage(), { key: "ArrowRight" });
			await api.app.save();
			api.external("external_agent");
			await landed(api, "External title");
			key(stage(), { key: "z", ctrlKey: true });
			expect(stageElement().textContent).toBe("Original title");
			// The person's own earlier nudge is still there to undo next.
			const left = stageElement("artwork").style.left;
			key(stage(), { key: "z", ctrlKey: true });
			expect(stageElement().textContent).toBe("External title");
			key(stage(), { key: "z", ctrlKey: true });
			expect(stageElement("artwork").style.left).not.toBe(left);
		});
		it("stops offering once the person edits, after half a minute, and for a reader", async () => {
			const api = await mount();
			api.external("tedi");
			await landed(api, "External title");
			expect(offer()).toBeDefined();
			clickElement("artwork");
			key(stage(), { key: "ArrowRight" });
			expect(offer()).toBeUndefined();
			key(stage(), { key: "z", ctrlKey: true });
			expect(stageElement().textContent).toBe("External title");
			await api.app.save();
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			api.external("tedi", "Agent again");
			await landed(api, "Agent again");
			expect(offer()).toBeDefined();
			await vi.advanceTimersByTimeAsync(30_000);
			expect(offer()).toBeUndefined();
			vi.useRealTimers();
			api.app.destroy();
			const reader = await mount("use", false);
			reader.external("tedi");
			await landed(reader, "External title");
			expect(stageElement().classList.contains("landed")).toBe(true);
			expect(offer()).toBeUndefined();
		});
	});
	it("clears the visible canvas and disables presentation after source authority is denied", async () => {
		const api = await mount();
		api.deny();
		api.external();
		api.notify();
		await vi.waitFor(() => expect(status()).toContain("Source access denied"));
		expect(
			document.querySelectorAll(".slides-stage [data-element-id]"),
		).toHaveLength(0);
		expect(document.querySelectorAll(".slides-thumb")).toHaveLength(0);
		expect(button("present").disabled).toBe(true);
		expect(button("more").disabled).toBe(true);
		expect(button("insert").disabled).toBe(true);
	});
	it("refreshes clean canvases only for the trusted parent and bound output", async () => {
		const api = await mount();
		api.external();
		api.notify(null);
		api.notify(window.parent, "wrong");
		api.notify(window.parent, "slides", "wrong");
		expect(stageElement().textContent).toBe("Original title");
		api.notify();
		await vi.waitFor(() =>
			expect(stageElement().textContent).toBe("External title"),
		);
	});
	it("tells the page when a show starts and ends, and stops when the page ends it", async () => {
		const api = await mount();
		const present = vi.fn();
		api.bridge.present = present;
		const presenter = document.querySelector<HTMLElement>("#presenter")!;
		button("present").click();
		expect(present).toHaveBeenLastCalledWith(true);
		button("exit").click();
		expect(present).toHaveBeenLastCalledWith(false);
		expect(presenter.hidden).toBe(true);

		button("present").click();
		const pageEnds = (source: MessageEventSource | null) =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					data: {
						jsonrpc: "2.0",
						method: "tedix/present",
						params: { active: false },
					},
				}),
			);
		pageEnds(null);
		expect(presenter.hidden).toBe(false);
		pageEnds(window.parent);
		expect(presenter.hidden).toBe(true);
		expect(present).toHaveBeenLastCalledWith(false);
		expect(document.activeElement).toBe(button("present"));
	});
	it("presents the full canvas and exports the saved edits without a manual save", async () => {
		const api = await mount();
		clickElement();
		format();
		change("Text", "Exported title");
		button("present").click();
		expect(
			document.querySelector(
				'.slides-present-stage [data-element-id="artwork"] [data-slide-part="title"]',
			)?.textContent,
		).toBe("Artwork");
		expect(document.querySelector("#presenter")?.textContent).not.toMatch(
			/unsaved|draft/i,
		);
		expect(document.querySelector("#position")?.textContent).toBe("1 / 2");
		key(document.querySelector("#presenter")!, { key: " " });
		expect(document.querySelector("#position")?.textContent).toBe("2 / 2");
		key(document.querySelector("#presenter")!, { key: "Home" });
		expect(document.querySelector("#position")?.textContent).toBe("1 / 2");
		button("next").click();
		expect(document.querySelector("#position")?.textContent).toBe("2 / 2");
		button("exit").click();
		const download = (format: string) =>
			document
				.querySelector<HTMLButtonElement>(`[data-export="${format}"]`)!
				.click();
		download("pptx");
		await vi.waitFor(() =>
			expect(api.call).toHaveBeenCalledWith("app.exportOutput", {
				slot: "slides",
				format: "pptx",
				expectedRevision: 4,
			}),
		);
		expect(api.result().revision.content.slides[0]!.title).toBe(
			"Exported title",
		);
		await vi.waitFor(() => expect(button("more").disabled).toBe(false));
		download("pdf");
		await vi.waitFor(() =>
			expect(api.call).toHaveBeenCalledWith("app.exportOutput", {
				slot: "slides",
				format: "pdf",
				expectedRevision: 4,
			}),
		);
	});
	it("opens Format on demand and with Enter on a selected element", async () => {
		await mount();
		const panel = document.querySelector<HTMLElement>(".slides-inspector")!;
		expect(panel.dataset.open).toBe("false");
		expect(field("Text")).toBeNull();
		clickElement();
		key(stage(), { key: "Enter" });
		expect(panel.dataset.open).toBe("true");
		expect(button("format").getAttribute("aria-expanded")).toBe("true");
		expect(field("Text").value).toBe("Original title");
		expect(field("X").closest("details")?.open).toBe(false);
		expect((field("Fill") as HTMLInputElement).type).toBe("color");
		button("format").click();
		expect(panel.dataset.open).toBe("false");
	});
	it.each([
		["read", true],
		["owner", false],
	])("requires both role and write grant (%s)", async (role, write) => {
		const api = await mount(role, write);
		clickElement();
		format();
		expect(field("Text").disabled).toBe(true);
		expect(status()).toBe("View only");
		expect(button("insert").disabled).toBe(true);
		expect(button("add-slide").disabled).toBe(true);
		expect(button("present").disabled).toBe(false);
		key(stage(), { key: "Delete" });
		key(stage(), { key: "s", ctrlKey: true });
		await Promise.resolve();
		expect(api.saves()).toBe(0);
		expect(api.draftWrites()).toBe(0);
	});
	it("hides the editing tools from someone who can only look", async () => {
		await mount("use");
		expect(
			document.querySelector<HTMLElement>(".slides-bar-tools")!.hidden,
		).toBe(true);
		expect(button("format").hidden).toBe(true);
		expect(button("present").hidden).toBe(false);
		expect(
			document.querySelector<HTMLElement>('[data-export="pptx"]')!.hidden,
		).toBe(false);
	});
	it("lets someone invited to edit through a link change the deck, without the upload and file exports their page lacks", async () => {
		await mount("edit");
		expect(
			document.querySelector<HTMLElement>(".slides-bar-tools")!.hidden,
		).toBe(false);
		expect(button("add-slide").disabled).toBe(false);
		expect(button("insert").disabled).toBe(false);
		expect(button("upload").hidden).toBe(true);
		expect(
			document.querySelector<HTMLElement>('[data-export="pptx"]')!.hidden,
		).toBe(true);
		expect(
			document.querySelector<HTMLElement>('[data-export="pdf"]')!.hidden,
		).toBe(true);
		expect(
			document.querySelector<HTMLElement>('[data-export="outline"]')!.hidden,
		).toBe(false);
	});
	it("runs the standalone bundle without importing a host editor", async () => {
		document.body.innerHTML = '<div id="app"></div>';
		const api = fixture();
		const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
		const add = window.addEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation(
			(name, listener, options) => {
				listeners.push([name, listener]);
				add(name, listener, options);
			},
		);
		cleanup.push(() =>
			listeners.forEach(([name, listener]) =>
				window.removeEventListener(name, listener),
			),
		);
		new Function("window", SLIDES_CLIENT_SOURCE)(
			Object.assign(window, { tedix: api.bridge }),
		);
		await vi.waitFor(() =>
			expect(
				document.querySelector<HTMLElement>(".slides-app")?.dataset.revision,
			).toBe("3"),
		);
		expect(SLIDES_CLIENT_SOURCE).not.toMatch(
			/import\s*\(|from\s*["']react|native-editor/,
		);
		expect(
			document.querySelectorAll(".slides-stage [data-element-id]"),
		).toHaveLength(2);
	});
});
