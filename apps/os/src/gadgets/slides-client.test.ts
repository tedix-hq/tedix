import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SLIDES_CLIENT_SOURCE } from "@tedix/api-contract/assets/slides-blueprint";
import { mountSlidesClient, type SlidesClientBridge } from "./slides-client";
import { projectDeck, type PresentationContent } from "./slides-engine";

const workspaceId = "11111111-1111-4111-8111-111111111111",
	outputId = "22222222-2222-4222-8222-222222222222";
const cleanup: Array<() => void> = [];
afterEach(() => {
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
const change = (label: string, value: string) => {
	field(label).value = value;
	field(label).dispatchEvent(new Event("change"));
};
const clickElement = (id = "title-1") =>
	document
		.querySelector<HTMLElement>(`.slides-stage [data-element-id="${id}"]`)!
		.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 1,
				clientX: 100,
				clientY: 80,
			}),
		);

function fixture(role = "owner", write = true) {
	let denied = false;
	let draftGate: Promise<void> | undefined;
	let releaseDraft: (() => void) | undefined;
	let revision = 3,
		draft: { revision: number; content: PresentationContent } | null = null;
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
	const result = () => ({
		output: { id: outputId, workspaceId, title: "Launch canvas" },
		revision: { revision, content: structuredClone(content) },
	});
	const call = vi.fn(
		async (method: string, args?: unknown): Promise<unknown> => {
			const input = args as {
				slot: string;
				content: PresentationContent;
				revision: number;
				expectedRevision: number;
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
			if (method === "outputs.replace") {
				if (input.slot !== "slides" || input.expectedRevision !== revision)
					throw new Error("Revision conflict");
				const parsed = OsOutputContentSchema.parse(input.content);
				if (parsed.kind !== "presentation")
					throw new Error("Wrong content kind");
				content = parsed;
				revision++;
				return result();
			}
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
		deny() {
			denied = true;
		},
		external() {
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
										element.id === "title-1"
											? { ...element, text: "External title" }
											: element,
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
async function mount(role = "owner", write = true) {
	document.body.innerHTML = '<div id="app"></div>';
	const api = fixture(role, write);
	const app = await mountSlidesClient(
		document.getElementById("app")!,
		api.bridge,
	);
	cleanup.push(() => app.destroy());
	return { ...api, app };
}
async function save() {
	button("save").click();
	await vi.waitFor(() =>
		expect(document.querySelector(".slides-status")?.textContent).toContain(
			"Saved · revision",
		),
	);
}

describe("portable Slides canvas", () => {
	it("posts edits before immediate iframe removal and restores them on reopen without a debounce wait", async () => {
		const api = await mount();
		document
			.querySelector<HTMLElement>('.slides-stage [data-element-id="title-1"]')!
			.dispatchEvent(new Event("dblclick"));
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
		document.body.innerHTML = '<div id="app"></div>';
		const reopened = await mountSlidesClient(
			document.getElementById("app")!,
			api.bridge,
		);
		cleanup.push(() => reopened.destroy());
		expect(
			document.querySelector('.slides-stage [data-element-id="title-1"]')
				?.textContent,
		).toBe("Immediate draft");
		expect(document.querySelector(".slides-status")?.textContent).toContain(
			"Restored draft",
		);
	});
	it.each(["save", "discard", "denial"] as const)(
		"clears drafts after all pending write receipts on %s",
		async (action) => {
			const api = await mount(),
				release = api.holdDraftWrites();
			clickElement();
			change("Text", "Pending draft");
			if (action === "save") button("save").click();
			else {
				if (action === "denial") api.deny();
				button("reload").click();
				button("reload").click();
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
		change("Text", "Edited title");
		change("Font size", "56");
		change("Fill", "#eefaff");
		const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
		notes.value = "New speaker note";
		notes.dispatchEvent(new Event("change"));
		await save();
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
			"outputs.replace",
			expect.objectContaining({ slot: "slides", expectedRevision: 3 }),
		);
	});
	it("drags and resizes in slide coordinates with undo redo and layer ordering", async () => {
		const api = await mount();
		const stage = document.querySelector<HTMLElement>(".slides-stage")!;
		vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
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
		clickElement();
		stage.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 1,
				clientX: 130,
				clientY: 100,
				altKey: true,
			}),
		);
		stage.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
		expect(field("X").value).toBe("102");
		expect(field("Y").value).toBe("80");
		button("undo").click();
		expect(field("X").value).toBe("72");
		button("redo").click();
		expect(field("X").value).toBe("102");
		document.querySelector<HTMLElement>(".slides-resize")!.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				button: 0,
				pointerId: 2,
				clientX: 0,
				clientY: 0,
			}),
		);
		stage.dispatchEvent(
			new PointerEvent("pointermove", {
				pointerId: 2,
				clientX: 80,
				clientY: 20,
			}),
		);
		stage.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2 }));
		expect(field("WIDTH").value).toBe("880");
		button("forward").click();
		await save();
		expect(
			api.result().revision.content.deck!.slides[0]!.elements.at(-1)?.id,
		).toBe("title-1");
	});
	it("adds shapes and SVG and duplicates or reorders slides with fresh identities", async () => {
		const api = await mount();
		field("Element type").value = "shape";
		button("insert").click();
		change("Shape", "ellipse");
		change("Fill", "#abcdef");
		button("duplicate-element").click();
		button("duplicate-slide").click();
		button("slide-down").click();
		await save();
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
		field("Element type").value = "svg";
		button("insert").click();
		change(
			"SVG markup",
			'<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>',
		);
		await save();
		expect(
			api.result().revision.content.deck!.slides[2]!.elements.at(-1)?.src,
		).toContain("data:image/svg+xml");
	});
	it("retains embedded images beyond the app.call argument limit and edits fit without dropping artwork", async () => {
		const api = await mount();
		field("Element type").value = "image";
		button("insert").click();
		const src = "data:image/png;base64," + "A".repeat(90_000);
		change("Image source", src);
		change("Image fit", "cover");
		await save();
		expect(
			api.result().revision.content.deck!.slides[0]!.elements.at(-1),
		).toMatchObject({ type: "image", src, style: { fit: "cover" } });
		expect(api.call).toHaveBeenCalledWith(
			"outputs.replace",
			expect.objectContaining({ slot: "slides", expectedRevision: 3 }),
		);
	});
	it("keeps dirty inline text through external updates and CAS conflict until explicit discard", async () => {
		const api = await mount();
		const target = document.querySelector<HTMLElement>(
			'.slides-stage [data-element-id="title-1"]',
		)!;
		clickElement();
		document
			.querySelector(".slides-stage")!
			.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
		expect(
			document.querySelector('.slides-stage [data-element-id="title-1"]'),
		).toBe(target);
		target.dispatchEvent(new Event("dblclick"));
		const input = field("Edit canvas text") as HTMLTextAreaElement;
		input.value = "My uncommitted draft";
		input.dispatchEvent(new Event("input"));
		api.external();
		api.notify();
		expect(field("Edit canvas text")).toBe(input);
		expect(document.querySelector(".slides-updates")?.textContent).toContain(
			"draft is preserved",
		);
		button("save").click();
		await vi.waitFor(() =>
			expect(document.querySelector(".slides-status")?.textContent).toContain(
				"Revision conflict",
			),
		);
		expect(api.draft()?.content.deck!.slides[0]!.elements[0]!.text).toBe(
			"My uncommitted draft",
		);
		button("reload").click();
		expect(button("reload").textContent).toContain("Discard");
		button("reload").click();
		await vi.waitFor(() =>
			expect(
				document.querySelector('.slides-stage [data-element-id="title-1"]')
					?.textContent,
			).toBe("External title"),
		);
	});
	it("clears the visible canvas and disables presentation after source authority is denied", async () => {
		const api = await mount();
		api.deny();
		button("reload").click();
		await vi.waitFor(() =>
			expect(document.querySelector(".slides-status")?.textContent).toContain(
				"Source access denied",
			),
		);
		expect(
			document.querySelectorAll(".slides-stage [data-element-id]"),
		).toHaveLength(0);
		expect(button("present").disabled).toBe(true);
		expect(button("export").disabled).toBe(true);
		expect(button("insert").disabled).toBe(true);
	});
	it("refreshes clean canvases only for the trusted parent and bound output", async () => {
		const api = await mount();
		api.external();
		api.notify(null);
		api.notify(window.parent, "wrong");
		api.notify(window.parent, "slides", "wrong");
		expect(
			document.querySelector('.slides-stage [data-element-id="title-1"]')
				?.textContent,
		).toBe("Original title");
		api.notify();
		await vi.waitFor(() =>
			expect(
				document.querySelector('.slides-stage [data-element-id="title-1"]')
					?.textContent,
			).toBe("External title"),
		);
	});
	it("presents the full canvas and saves before scoped PPTX and PDF export", async () => {
		const api = await mount();
		clickElement();
		change("Text", "Exported title");
		button("present").click();
		expect(
			document.querySelector(
				'.slides-present-stage [data-element-id="artwork"] [data-slide-part="title"]',
			)?.textContent,
		).toBe("Artwork");
		expect(
			document.querySelector(".slides-present-status")?.textContent,
		).toContain("Draft");
		button("next").click();
		expect(document.querySelector("#position")?.textContent).toBe("2 / 2");
		button("exit").click();
		button("export").click();
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
		await vi.waitFor(() => expect(button("export").disabled).toBe(false));
		field("Export format").value = "pdf";
		button("export").click();
		await vi.waitFor(() =>
			expect(api.call).toHaveBeenCalledWith("app.exportOutput", {
				slot: "slides",
				format: "pdf",
				expectedRevision: 4,
			}),
		);
	});
	it.each([
		["read", true],
		["owner", false],
	])("requires both role and write grant (%s)", async (role, write) => {
		const api = await mount(role, write);
		clickElement();
		expect(field("Text").disabled).toBe(true);
		expect(button("save").disabled).toBe(true);
		expect(button("insert").disabled).toBe(true);
		expect(button("present").disabled).toBe(false);
		document
			.querySelector(".slides-stage")!
			.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
			);
		expect(
			api.call.mock.calls.some(([method]) => method === "outputs.replace"),
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
			expect(document.querySelector(".slides-meta")?.textContent).toContain(
				"revision 3",
			),
		);
		expect(SLIDES_CLIENT_SOURCE).not.toMatch(
			/import\s*\(|from\s*["']react|native-editor/,
		);
		expect(
			document.querySelectorAll(".slides-stage [data-element-id]"),
		).toHaveLength(2);
	});
});
