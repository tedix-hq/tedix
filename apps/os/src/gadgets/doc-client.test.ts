import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Editor } from "@tiptap/core";
import type {
	OsOutputContent,
	OsRichTextDocument,
} from "@tedix/api-contract/schemas/os-workspaces";
import { DOC_CLIENT_SOURCE } from "@tedix/api-contract/assets/doc-blueprint";
import { blocksFromRichText } from "./doc-engine";
import { mountDocClient, type DocClientBridge } from "./doc-client";

type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;
const workspaceId = "11111111-1111-4111-8111-111111111111",
	outputId = "22222222-2222-4222-8222-222222222222";
const file = {
	workspaceId,
	resourceId: "33333333-3333-4333-8333-333333333333",
};
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function fixture(role = "owner") {
	let revision = 4,
		denied = false,
		gate: Promise<void> | undefined;
	let richText: OsRichTextDocument = {
		type: "doc",
		content: [
			{ type: "paragraph", content: [{ type: "text", text: "Original" }] },
			{
				type: "paragraph",
				attrs: { textAlign: "right", indent: 2 },
				content: [
					{
						type: "text",
						text: "Keep formatting",
						marks: [
							{ type: "bold" },
							{ type: "textStyle", attrs: { color: "#123456" } },
						],
					},
				],
			},
		],
	};
	let content: DocumentContent = {
		kind: "document",
		richText,
		blocks: blocksFromRichText(richText),
		file,
	};
	let retained: { revision: number; content: DocumentContent } | null = null;
	const calls = vi.fn(
		async (method: string, args?: unknown): Promise<unknown> => {
			const input = args as {
				method?: string;
				revision: number;
				expectedRevision?: number;
				content: DocumentContent;
			};
			if (method === "context")
				return {
					workspaceId,
					role,
					gadget: { revision: 3 },
					settings: { slot: "document" },
					grants: [
						{
							slot: "document",
							operations: ["outputs.read", "outputs.write", "outputs.patch"],
						},
					],
				};
			if (denied && method !== "app.draft.clear")
				throw new Error("Source denied");
			if (method === "app.draft.read") return structuredClone(retained);
			if (method === "app.draft.write") {
				retained = structuredClone({
					revision: input.revision,
					content: input.content,
				});
				return null;
			}
			if (method === "app.draft.clear") {
				retained = null;
				return null;
			}
			if (method === "app.download") return { filename: "Doc.md" };
			if (input.method === "exportMarkdown")
				return { title: "Doc", revision, text: "Saved semantic content" };
			if (method === "outputs.replace") {
				await gate;
				if (input.expectedRevision !== revision)
					throw new Error("Output revision changed");
				content = structuredClone(input.content);
				revision++;
			}
			return {
				output: {
					id: outputId,
					title: "Project plan",
					workspaceId,
					kind: "document",
				},
				revision: { revision, content: structuredClone(content) },
			};
		},
	);
	const bridge = { call: calls } as DocClientBridge;
	const mount = async () => {
		const root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const mounted = await mountDocClient(root, bridge);
		cleanups.push(() => {
			mounted.destroy();
			root.remove();
		});
		return { root, mounted, editor: mounted.editor! };
	};
	return {
		calls,
		bridge,
		mount,
		persisted: () => structuredClone(content),
		retained: () => structuredClone(retained),
		deny: () => {
			denied = true;
		},
		/** Hold the next saves open until the returned function is called. */
		hold() {
			let open = () => {};
			gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			return () => {
				gate = undefined;
				open();
			};
		},
		content: (next: DocumentContent) => {
			content = next;
		},
		external(
			text: string | OsRichTextDocument,
			source: MessageEventSource | null = window.parent,
		) {
			revision++;
			richText =
				typeof text === "string"
					? {
							type: "doc",
							content: [
								{ type: "paragraph", content: [{ type: "text", text }] },
							],
						}
					: text;
			content = {
				kind: "document",
				richText,
				blocks: blocksFromRichText(richText),
				file,
			};
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					data: {
						jsonrpc: "2.0",
						method: "tedix/outputs-changed",
						params: { outputs: [{ slot: "document", outputId, revision }] },
					},
				}),
			);
		},
	};
}
const find = (root: HTMLElement, label: string) =>
	[...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => {
		const name = node.getAttribute("aria-label") ?? node.textContent ?? "";
		return name === label || name.startsWith(`${label} `);
	});
const click = (root: HTMLElement, label: string) => {
	const button = find(root, label);
	expect(button, label).toBeDefined();
	button!.click();
};
/** Toolbar state is refreshed once per animation frame. */
const frame = () =>
	new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const press = (target: HTMLElement, init: KeyboardEventInit) =>
	target.dispatchEvent(
		new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
	);
const fakeClock = () =>
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
const saves = (test: ReturnType<typeof fixture>) =>
	test.calls.mock.calls.filter(([method]) => method === "outputs.replace")
		.length;
const statusText = (root: HTMLElement) =>
	root.querySelector(".doc-status")!.textContent;

describe("portable rich Doc client", () => {
	it("names the writing surface and keeps one toolbar row with the rest in a menu", async () => {
		const test = fixture();
		const { root, editor } = await test.mount();
		expect(
			root.querySelector(
				'[role="textbox"][aria-label="Document writing area"][aria-multiline="true"]',
			),
		).toBe(editor.view.dom);
		const toolbar = root.querySelector('[role="toolbar"]')!;
		for (const label of [
			"Undo",
			"Bold",
			"Italic",
			"Bulleted list",
			"To-do list",
			"Link",
			"Image",
			"Table",
			"More",
		])
			expect(toolbar.contains(find(root, label)!), label).toBe(true);
		expect(find(root, "Bold")!.title).toMatch(/^Bold (⌘|Ctrl\+)B$/);
		expect(find(root, "Save document")).toBeUndefined();
		expect(find(root, "Reload saved document")).toBeUndefined();
		expect(root.querySelector("h1")).toBeNull();
		const menu = root.querySelector<HTMLElement>('[role="menu"]')!;
		expect(menu.hidden).toBe(true);
		click(root, "More");
		expect(menu.hidden).toBe(false);
		expect(
			[...menu.querySelectorAll('[role="menuitem"]')].map(
				(node) => node.textContent || node.getAttribute("aria-label"),
			),
		).toEqual([
			"Align left",
			"Align center",
			"Align right",
			"Align justify",
			"Note",
			"Collapsible section",
			"Divider",
			"Export as Markdown",
			"Export as Word",
			"Export as PDF",
			"Export as HTML",
			"Export as PNG",
		]);
		press(menu, { key: "Escape" });
		expect(menu.hidden).toBe(true);
		const tableTools = find(root, "Add row below")!.parentElement!;
		expect(tableTools.hidden).toBe(true);
		click(root, "Table");
		expect(
			editor.getJSON().content?.some((node) => node.type === "table"),
		).toBe(true);
		await frame();
		expect(tableTools.hidden).toBe(false);
		click(root, "Bold");
		await frame();
		expect(find(root, "Bold")!.getAttribute("aria-pressed")).toBe("true");
	});
	it("starts a fresh empty canonical document without requiring native initialization", async () => {
		const test = fixture();
		test.content({ kind: "document", blocks: [] });
		const { root, editor, mounted } = await test.mount();
		expect(mounted.dirty).toBe(false);
		expect(root.querySelector(".tiptap p")?.getAttribute("data-hint")).toBe(
			"Start writing…",
		);
		editor.commands.insertContent("Fresh gadget document");
		expect(root.querySelector(".tiptap [data-hint]")).toBeNull();
		await mounted.save();
		expect(mounted.dirty).toBe(false);
		expect(test.persisted().blocks).toEqual([
			{ type: "paragraph", text: "Fresh gadget document" },
		]);
		expect(test.persisted().richText?.content[0]?.type).toBe("paragraph");
	});
	it("names the empty heading or list line the caret is in", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		editor.commands.insertContentAt(editor.state.doc.content.size, {
			type: "heading",
			attrs: { level: 2 },
		});
		editor.state.doc.forEach((node, offset) => {
			if (node.type.name === "heading")
				editor.commands.setTextSelection(offset + 1);
		});
		expect(root.querySelector(".tiptap h2")?.getAttribute("data-hint")).toBe(
			"Heading 2",
		);
		editor.commands.setTextSelection(2);
		expect(root.querySelector(".tiptap [data-hint]")).toBeNull();
	});

	it("saves by itself after a pause without touching the caret, focus or document on screen", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		expect(mounted.dirty).toBe(false);
		expect(statusText(root)).toBe("");
		const untouched = test.persisted().richText!.content[1];
		const editableChanges = vi.spyOn(editor, "setEditable");
		fakeClock();
		editor
			.chain()
			.setTextSelection({ from: 1, to: 9 })
			.toggleBold()
			.toggleItalic()
			.run();
		expect(mounted.dirty).toBe(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(test.retained()?.revision).toBe(4);
		expect(saves(test)).toBe(0);
		const shown = editor.state.doc,
			selection = editor.state.selection;
		await vi.advanceTimersByTimeAsync(600);
		expect(test.calls).toHaveBeenCalledWith("outputs.replace", {
			slot: "document",
			expectedRevision: 4,
			content: expect.objectContaining({ file }),
		});
		expect(mounted.dirty).toBe(false);
		expect(editor.state.doc).toBe(shown);
		expect(editor.state.selection).toBe(selection);
		expect(editableChanges).not.toHaveBeenCalled();
		expect(editor.isEditable).toBe(true);
		expect(statusText(root)).toBe("");
		expect(test.retained()).toBeNull();
		expect(test.persisted().richText!.content[0]!.content![0]!.marks).toEqual(
			expect.arrayContaining([{ type: "bold" }, { type: "italic" }]),
		);
		const preserved = test.persisted().richText!.content[1]!;
		expect(preserved.attrs).toMatchObject(untouched!.attrs!);
		expect(preserved.content![0]!.text).toBe("Keep formatting");
		expect(preserved.content![0]!.marks).toEqual(
			expect.arrayContaining([
				{ type: "bold" },
				expect.objectContaining({
					type: "textStyle",
					attrs: expect.objectContaining({ color: "#123456" }),
				}),
			]),
		);
		// A second edit builds on the revision the first save produced.
		editor.commands.insertContentAt(1, "Next ");
		await vi.advanceTimersByTimeAsync(1600);
		expect(test.calls).toHaveBeenLastCalledWith(
			"app.draft.clear",
			expect.anything(),
		);
		expect(saves(test)).toBe(2);
		expect(mounted.dirty).toBe(false);
	});
	it("does not wait longer than five seconds while someone keeps typing", async () => {
		const test = fixture(),
			{ editor } = await test.mount();
		fakeClock();
		for (let second = 0; second < 6; second++) {
			editor.commands.insertContentAt(1, "a");
			await vi.advanceTimersByTimeAsync(1000);
		}
		expect(saves(test)).toBe(1);
	});
	it("keeps edits made during a save and saves them next, one save at a time", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		fakeClock();
		const release = test.hold();
		editor.commands.insertContentAt(1, "First ");
		const saving = mounted.save();
		await vi.advanceTimersByTimeAsync(1100);
		expect(statusText(root)).toBe("Saving…");
		editor.commands.insertContentAt(1, "Second ");
		void mounted.save();
		void mounted.save();
		const typed = editor.state.doc;
		release();
		await saving;
		expect(editor.state.doc).toBe(typed);
		expect(mounted.dirty).toBe(true);
		await mounted.save();
		expect(saves(test)).toBe(2);
		expect(mounted.dirty).toBe(false);
		expect(test.persisted().richText!.content[0]!.content![0]!.text).toBe(
			"Second First Original",
		);
		expect(statusText(root)).toBe("Saved");
		await vi.advanceTimersByTimeAsync(1400);
		expect(statusText(root)).toBe("");
	});
	it("saves when the tab is hidden and on the save shortcut", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		editor.commands.insertContentAt(1, "Leaving ");
		window.dispatchEvent(new Event("pagehide"));
		await vi.waitFor(() => expect(mounted.dirty).toBe(false));
		expect(statusText(root)).toBe("");
		editor.commands.insertContentAt(1, "Shortcut ");
		expect(press(editor.view.dom, { key: "s", metaKey: true })).toBe(false);
		await vi.waitFor(() => expect(statusText(root)).toBe("Saved"));
		expect(saves(test)).toBe(2);
	});
	it("moves complete blocks from the keyboard with native undo and keeps table, tasks, details and embedded images", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		editor.commands.setTextSelection(2);
		expect(find(root, "Move block down")).toBeUndefined();
		press(editor.view.dom, { key: "ArrowDown", altKey: true, shiftKey: true });
		expect(editor.state.doc.child(0).textContent).toBe("Keep formatting");
		await frame();
		click(root, "Undo");
		expect(editor.state.doc.child(0).textContent).toBe("Original");
		editor.state.doc.forEach((node, offset) => {
			if (node.type.name === "heading")
				editor.commands.setTextSelection(offset + 1);
		});
		click(root, "Table");
		expect(root.querySelectorAll(".tiptap th")).toHaveLength(3);
		editor
			.chain()
			.focus()
			.insertContent([
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Done" }],
								},
							],
						},
					],
				},
				{
					type: "details",
					content: [
						{
							type: "detailsSummary",
							content: [{ type: "text", text: "Summary" }],
						},
						{
							type: "detailsContent",
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Details" }],
								},
							],
						},
					],
				},
				{
					type: "image",
					attrs: {
						src: "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBA==",
						alt: "Diagram",
						width: 100,
						height: 100,
					},
				},
			])
			.run();
		const types = JSON.stringify(editor.getJSON());
		expect(types).toContain('"taskList"');
		expect(types).toContain('"details"');
		expect(types).toContain('"image"');
	});
	it("stores an inserted picture with the file and draws it from the host's copy", async () => {
		const reference = `tedix-asset:${"d".repeat(64)}`;
		const copy = "data:image/png;base64,Y29weQ==";
		const test = fixture();
		const answer = test.calls.getMockImplementation()!;
		test.calls.mockImplementation(async (method, args) => {
			if (method === "outputs.uploadImage") return { reference };
			if (method === "outputs.image") {
				expect(args).toEqual({ slot: "document", url: reference });
				return { dataUrl: copy };
			}
			return answer(method, args);
		});
		// The picture is measured before it is stored; jsdom loads no images.
		vi.stubGlobal(
			"Image",
			class {
				naturalWidth = 200;
				naturalHeight = 100;
				onload: (() => void) | null = null;
				set src(_value: string) {
					queueMicrotask(() => this.onload?.());
				}
			},
		);
		cleanups.push(() => vi.unstubAllGlobals());
		const { root, editor } = await test.mount();
		const input = root.querySelector<HTMLInputElement>("input[type=file]")!;
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [new File(["picture"], "chart.png", { type: "image/png" })],
		});
		input.dispatchEvent(new Event("change"));
		await vi.waitFor(() =>
			expect(JSON.stringify(editor.getJSON())).toContain(reference),
		);
		expect(test.calls).toHaveBeenCalledWith("outputs.uploadImage", {
			slot: "document",
			dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
		});
		const picture = () => root.querySelector<HTMLImageElement>("img")!;
		await vi.waitFor(() => expect(picture().getAttribute("src")).toBe(copy));
		expect(picture().dataset.linkedImage).toBe(reference);
		// The document keeps the reference: the copy is only what is drawn.
		expect(JSON.stringify(editor.getJSON())).not.toContain(copy);
		expect(
			test.calls.mock.calls.filter(([method]) => method === "outputs.image"),
		).toHaveLength(1);
	});
	it("applies, edits and removes a link from the pop-up", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		const form = root.querySelector<HTMLFormElement>(".doc-link")!,
			input = form.querySelector("input")!;
		const submit = () =>
			form.dispatchEvent(
				new Event("submit", { bubbles: true, cancelable: true }),
			);
		editor.commands.setTextSelection({ from: 1, to: 9 });
		expect(form.hidden).toBe(true);
		press(editor.view.dom, { key: "k", ctrlKey: true });
		expect(form.hidden).toBe(false);
		input.value = "example.test/page";
		submit();
		expect(form.hidden).toBe(true);
		expect(editor.getAttributes("link").href).toBe("https://example.test/page");
		click(root, "Link");
		expect(input.value).toBe("https://example.test/page");
		press(input, { key: "Escape" });
		expect(form.hidden).toBe(true);
		click(root, "Link");
		input.value = "";
		submit();
		expect(editor.isActive("link")).toBe(false);
	});
	it("restores a tab draft after an authorized read and asks before it replaces a newer save", async () => {
		const test = fixture(),
			first = await test.mount();
		fakeClock();
		first.editor.commands.insertContentAt(1, "My draft ");
		await vi.advanceTimersByTimeAsync(1000);
		first.mounted.destroy();
		first.root.remove();
		vi.useRealTimers();
		expect(test.retained()?.revision).toBe(4);
		test.external("Newer saved version");
		const second = await test.mount();
		expect(second.editor.getText()).toContain("My draft");
		expect(second.root.textContent).toContain("Restored your unsaved changes");
		await second.mounted.save();
		expect(second.editor.getText()).toContain("My draft");
		expect(second.mounted.dirty).toBe(true);
		expect(second.root.textContent).toContain("Keep mine");
		expect(second.root.textContent).not.toMatch(/revision/i);
		click(second.root, "Use theirs");
		await vi.waitFor(() =>
			expect(second.editor.getText()).toBe("Newer saved version"),
		);
		expect(second.mounted.dirty).toBe(false);
		expect(test.retained()).toBeNull();
		expect(statusText(second.root)).toBe("");
	});
	it("keeps a restored draft over a newer save when asked to", async () => {
		const test = fixture(),
			first = await test.mount();
		fakeClock();
		first.editor.commands.insertContentAt(1, "My draft ");
		await vi.advanceTimersByTimeAsync(1000);
		first.mounted.destroy();
		first.root.remove();
		vi.useRealTimers();
		test.external("Newer saved version");
		const second = await test.mount();
		await second.mounted.save();
		click(second.root, "Keep mine");
		await vi.waitFor(() => expect(second.mounted.dirty).toBe(true));
		await second.mounted.save();
		expect(second.mounted.dirty).toBe(false);
		expect(test.persisted().richText!.content[0]!.content![0]!.text).toBe(
			"My draft Original",
		);
	});
	it("refreshes clean documents only from the parent, quietly, and fails closed on lost source access", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		const saved = test.persisted().richText!;
		const editableChanges = vi.spyOn(editor, "setEditable");
		test.external("Untrusted", null);
		expect(editor.getText()).toContain("Original");
		// The caret sits in the second paragraph while the first one changes.
		const caret = editor.state.doc.child(0).nodeSize + 5;
		editor.commands.setTextSelection(caret);
		test.external({
			...saved,
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "Agent edited this" }],
				},
				saved.content[1]!,
			],
		});
		await vi.waitFor(() =>
			expect(editor.getText()).toContain("Agent edited this"),
		);
		expect(statusText(root)).toBe("");
		expect(root.textContent).not.toContain("Loading");
		expect(editableChanges).not.toHaveBeenCalled();
		expect(editor.state.selection.from).toBe(
			editor.state.doc.child(0).nodeSize + 5,
		);
		expect(editor.state.doc.child(1).textContent).toBe("Keep formatting");
		expect(editor.can().undo()).toBe(false);
		expect(saves(test)).toBe(0);
		test.deny();
		test.external("No longer readable");
		await vi.waitFor(() => expect(root.textContent).toContain("Source denied"));
		expect(root.querySelector<HTMLElement>(".doc-page")!.hidden).toBe(true);
		expect(editor.isEditable).toBe(false);
		expect(find(root, "Try again")).toBeDefined();
	});
	it("merges someone else's save into a draft that changed another paragraph without saying anything", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		const second = editor.state.doc.child(0).nodeSize + 1;
		editor.commands.insertContentAt(second, "Mine: ");
		const saved = test.persisted().richText!;
		test.external({
			...saved,
			content: [
				{ type: "paragraph", content: [{ type: "text", text: "Theirs" }] },
				saved.content[1]!,
			],
		});
		await vi.waitFor(() => expect(editor.getText()).toContain("Theirs"));
		expect(statusText(root)).toBe("");
		expect(editor.getText()).toContain("Mine: Keep formatting");
		await mounted.save();
		const merged = test.persisted().richText!.content;
		expect(merged[0]!.content![0]!.text).toBe("Theirs");
		expect(merged[1]!.content![0]!.text).toBe("Mine: Keep formatting");
		expect(merged[1]!.attrs).toMatchObject({ textAlign: "right", indent: 2 });
	});
	it("merges after a save that lost the race to someone else's save", async () => {
		const test = fixture(),
			{ editor, mounted } = await test.mount();
		const second = editor.state.doc.child(0).nodeSize + 1;
		editor.commands.insertContentAt(second, "Mine: ");
		const saved = test.persisted().richText!;
		// Their save lands, but its notice has not arrived yet.
		test.external(
			{
				...saved,
				content: [
					{ type: "paragraph", content: [{ type: "text", text: "Theirs" }] },
					saved.content[1]!,
				],
			},
			null,
		);
		await mounted.save();
		expect(mounted.dirty).toBe(false);
		expect(editor.getText()).toContain("Theirs");
		const merged = test.persisted().richText!.content;
		expect(merged[0]!.content![0]!.text).toBe("Theirs");
		expect(merged[1]!.content![0]!.text).toBe("Mine: Keep formatting");
	});
	it("asks which version to keep only when both edited the same paragraph", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		editor.commands.insertContentAt(1, "Mine ");
		test.external("Theirs");
		await vi.waitFor(() => expect(root.textContent).toContain("Keep mine"));
		expect(root.textContent).not.toMatch(/revision/i);
		expect(editor.getText()).toContain("Mine Original");
		await mounted.save();
		expect(saves(test)).toBe(0);
		click(root, "Use theirs");
		await vi.waitFor(() => expect(editor.getText()).toBe("Theirs"));
		expect(statusText(root)).toBe("");
		expect(mounted.dirty).toBe(false);
	});
	it("keeps read-only users out of editing and reports oversized saves without dropping the draft", async () => {
		const readonly = fixture("use"),
			view = await readonly.mount();
		expect(view.editor.isEditable).toBe(false);
		expect(find(view.root, "Bold")).toBeUndefined();
		expect(view.root.textContent).toContain("Read only");
		expect(find(view.root, "Export as PDF")).toBeDefined();
		expect(
			readonly.calls.mock.calls.some(([method]) => method === "app.draft.read"),
		).toBe(false);
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		const answer = test.calls.getMockImplementation()!;
		let refusal: string | undefined = "too_large";
		test.calls.mockImplementation(async (method, args) => {
			if (method === "outputs.replace" && refusal)
				throw Object.assign(new Error(refusal), { code: refusal });
			return answer(method, args);
		});
		editor.commands.insertContentAt(1, "Large ");
		await mounted.save();
		expect(statusText(root)).toBe(
			"This file is over the 8 MB limit, so new changes are not saved. Remove or shrink large images.",
		);
		// Sending the same document again cannot work, so no retry is offered.
		expect(find(root, "Try again")).toBeUndefined();
		expect(mounted.dirty).toBe(true);
		expect(saves(test)).toBe(1);
		// A failure that may pass keeps its own words and the manual retry.
		refusal = "host_error";
		await mounted.save();
		expect(statusText(root)).toContain("Your changes are kept here.");
		expect(find(root, "Try again")).toBeDefined();
		refusal = undefined;
		await mounted.save();
		expect(mounted.dirty).toBe(false);
	});
	it("tries a passing save failure again by itself before saying anything", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		const answer = test.calls.getMockImplementation()!;
		let failing = true;
		test.calls.mockImplementation(async (method, args) => {
			if (method === "outputs.replace" && failing)
				throw Object.assign(new Error("Database temporarily unavailable"), {
					code: "host_error",
				});
			return answer(method, args);
		});
		fakeClock();
		editor.commands.insertContentAt(1, "Retry ");
		await vi.advanceTimersByTimeAsync(1600);
		expect(saves(test)).toBe(1);
		expect(statusText(root)).toBe("");
		expect(find(root, "Try again")).toBeUndefined();
		expect(mounted.dirty).toBe(true);
		failing = false;
		await vi.advanceTimersByTimeAsync(2100);
		expect(saves(test)).toBe(2);
		expect(mounted.dirty).toBe(false);
		expect(statusText(root)).toBe("");
	});

	it("saves rich content above the app-call argument limit through the fenced output capability", async () => {
		const test = fixture(),
			{ editor, mounted } = await test.mount();
		editor.commands.insertContentAt(1, "x".repeat(70_000));
		await mounted.save();
		expect(mounted.dirty).toBe(false);
		expect(test.calls).toHaveBeenCalledWith(
			"outputs.replace",
			expect.objectContaining({ slot: "document", expectedRevision: 4 }),
		);
		expect(JSON.stringify(test.persisted()).length).toBeGreaterThan(65_536);
	});
	it("saves pending edits first, then exports rich Word and PDF from the saved document", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		editor.commands.insertContentAt(1, "Late edit ");
		for (const [format, label] of [
			["docx", "Word"],
			["pdf", "PDF"],
		] as const) {
			click(root, `Export as ${label}`);
			await vi.waitFor(() =>
				expect(test.calls).toHaveBeenCalledWith("app.exportOutput", {
					slot: "document",
					format,
					expectedRevision: 5,
				}),
			);
			await vi.waitFor(() =>
				expect(statusText(root)).toBe(`Exported as ${label}.`),
			);
		}
		expect(mounted.dirty).toBe(false);
		expect(test.persisted().richText!.content[0]!.content![0]!.text).toBe(
			"Late edit Original",
		);
	});
	it("exports the saved semantic document through the host", async () => {
		const test = fixture(),
			{ root } = await test.mount();
		click(root, "Export as Markdown");
		await vi.waitFor(() =>
			expect(test.calls).toHaveBeenCalledWith(
				"app.download",
				expect.objectContaining({
					text: "Saved semantic content",
					mimeType: "text/markdown",
				}),
			),
		);
		await vi.waitFor(() =>
			expect(statusText(root)).toContain("Exported as Markdown."),
		);
	});
	it("executes the generated self-contained client artifact, without the native host editor", async () => {
		const test = fixture(),
			root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const previous = window.tedix;
		window.tedix = test.bridge;
		const listeners: [EventTarget, string, EventListener][] = [];
		for (const target of [window, document]) {
			const add = target.addEventListener.bind(target);
			vi.spyOn(target, "addEventListener").mockImplementation(
				(type: string, listener: unknown, options?: unknown) => {
					listeners.push([target, type, listener as EventListener]);
					add(type, listener as EventListener, options as boolean);
				},
			);
		}
		new Function(DOC_CLIENT_SOURCE)();
		await vi.waitFor(() =>
			expect(root.querySelector(".tiptap")?.textContent).toContain("Original"),
		);
		const editor = (
			root.querySelector(".tiptap") as HTMLElement & { editor: Editor }
		).editor;
		editor.chain().setTextSelection({ from: 1, to: 9 }).toggleBold().run();
		press(editor.view.dom, { key: "s", ctrlKey: true });
		await vi.waitFor(() => expect(statusText(root)).toBe("Saved"));
		expect(
			test.persisted().richText!.content[0]!.content![0]!.marks,
		).toContainEqual({ type: "bold" });
		cleanups.push(() => {
			editor.destroy();
			window.tedix = previous;
			for (const [target, type, listener] of listeners)
				target.removeEventListener(type, listener);
		});
	});
});
