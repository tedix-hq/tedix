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
});

function fixture(role = "owner") {
	let revision = 4,
		denied = false;
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
				args?: { content: DocumentContent; expectedRevision: number }[];
				revision: number;
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
			if (input.method === "replaceDocument") {
				if (input.args?.[0]?.expectedRevision !== revision)
					throw new Error("Output revision changed");
				content = structuredClone(input.args[0].content);
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
		content: (next: DocumentContent) => {
			content = next;
		},
		external(text: string, source: MessageEventSource | null = window.parent) {
			revision++;
			richText = {
				type: "doc",
				content: [{ type: "paragraph", content: [{ type: "text", text }] }],
			};
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
const click = (root: HTMLElement, label: string) => {
	const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(node) =>
			node.getAttribute("aria-label") === label || node.textContent === label,
	);
	expect(button, label).toBeDefined();
	button!.click();
};

describe("portable rich Doc client", () => {
	it("owns typing and inline formatting, then saves the same rich JSON and file through app CAS", async () => {
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		expect(root.textContent).toContain(
			"Document revision 4 · Doc app version 3",
		);
		expect(mounted.dirty).toBe(false);
		const untouched = test.persisted().richText!.content[1];
		editor
			.chain()
			.setTextSelection({ from: 1, to: 9 })
			.toggleBold()
			.toggleItalic()
			.run();
		expect(test.retained()?.revision).toBe(4);
		await mounted.save();
		expect(test.calls).toHaveBeenCalledWith("app.call", {
			method: "replaceDocument",
			args: [
				{ expectedRevision: 4, content: expect.objectContaining({ file }) },
			],
		});
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
		expect(root.textContent).toContain("Saved · document revision 5");
		expect(test.retained()).toBeNull();
	});
	it("moves complete blocks with native undo and keeps table, tasks, details and embedded images", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		editor.commands.setTextSelection(2);
		click(root, "Move block down");
		expect(editor.state.doc.child(0).textContent).toBe("Keep formatting");
		click(root, "Undo");
		expect(editor.state.doc.child(0).textContent).toBe("Original");
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		click(root, "Insert table");
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
	it("restores a tab draft after an authorized read and preserves its original CAS basis across conflicts", async () => {
		const test = fixture(),
			first = await test.mount();
		first.editor.commands.insertContentAt(1, "My draft ");
		first.mounted.destroy();
		first.root.remove();
		test.external("Newer saved version");
		const second = await test.mount();
		expect(second.editor.getText()).toContain("My draft");
		expect(second.root.textContent).toContain("based on document revision 4");
		await second.mounted.save();
		expect(second.root.textContent).toContain("Output revision changed");
		expect(second.editor.getText()).toContain("My draft");
		click(second.root, "Reload saved document");
		expect(second.editor.getText()).toContain("My draft");
		click(second.root, "Discard draft & reload");
		await vi.waitFor(() =>
			expect(second.editor.getText()).toBe("Newer saved version"),
		);
	});
	it("refreshes clean documents only from the parent and fails closed on lost source access", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		test.external("Untrusted", null);
		expect(editor.getText()).toContain("Original");
		test.external("Agent edited");
		await vi.waitFor(() => expect(editor.getText()).toBe("Agent edited"));
		test.deny();
		test.external("No longer readable");
		await vi.waitFor(() => expect(root.textContent).toContain("Source denied"));
		expect(root.querySelector<HTMLElement>(".doc-page")!.hidden).toBe(true);
		expect(editor.isEditable).toBe(false);
	});
	it("keeps read-only users out of editing and reports oversized saves without dropping the draft", async () => {
		const readonly = fixture("use"),
			view = await readonly.mount();
		expect(view.editor.isEditable).toBe(false);
		expect(
			readonly.calls.mock.calls.some(([method]) => method === "app.draft.read"),
		).toBe(false);
		const test = fixture(),
			{ root, editor, mounted } = await test.mount();
		editor.commands.insertContentAt(1, "x".repeat(70_000));
		await mounted.save();
		expect(root.textContent).toContain("64 KiB save limit");
		expect(mounted.dirty).toBe(true);
		expect(
			test.calls.mock.calls.some(
				([, args]) =>
					(args as { method?: string })?.method === "replaceDocument",
			),
		).toBe(false);
	});
	it("exports only the saved semantic revision through the host", async () => {
		const test = fixture(),
			{ root, editor } = await test.mount();
		editor.commands.insertContentAt(1, "Draft ");
		click(root, "Export Markdown");
		await vi.waitFor(() =>
			expect(test.calls).toHaveBeenCalledWith(
				"app.download",
				expect.objectContaining({
					text: "Saved semantic content",
					mimeType: "text/markdown",
				}),
			),
		);
		expect(root.textContent).toContain("unsaved edits are not included");
	});
	it("executes the generated self-contained client artifact, without the native host editor", async () => {
		const test = fixture(),
			root = document.createElement("div");
		root.id = "app";
		document.body.append(root);
		const previous = window.tedix;
		window.tedix = test.bridge;
		const listeners: [string, EventListener][] = [],
			add = window.addEventListener.bind(window);
		vi.spyOn(window, "addEventListener").mockImplementation(
			(type, listener, options) => {
				if (type === "message" || type === "beforeunload")
					listeners.push([type, listener as EventListener]);
				add(type, listener, options);
			},
		);
		new Function(DOC_CLIENT_SOURCE)();
		await vi.waitFor(() =>
			expect(root.querySelector(".tiptap")?.textContent).toContain("Original"),
		);
		const editor = (
			root.querySelector(".tiptap") as HTMLElement & { editor: Editor }
		).editor;
		editor.chain().setTextSelection({ from: 1, to: 9 }).toggleBold().run();
		click(root, "Save document");
		await vi.waitFor(() =>
			expect(root.textContent).toContain("Saved · document revision 5"),
		);
		expect(
			test.persisted().richText!.content[0]!.content![0]!.marks,
		).toContainEqual({ type: "bold" });
		cleanups.push(() => {
			editor.destroy();
			window.tedix = previous;
			for (const [type, listener] of listeners)
				window.removeEventListener(type, listener);
		});
	});
});
