import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DocWritingEditor } from "./doc-writing-editor";
import { DocWritingDraftProvider } from "./doc-writing-drafts";
import type { DocumentContent } from "@/lib/output-models";
import type { AppRuntimeHostResult } from "@/lib/app-runtime-host";

vi.mock("@/components/output-content", () => ({
	FileOutputView: () => <div data-file-preview />,
}));

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const workspaceId = "11111111-1111-4111-8111-111111111111";
const outputId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const resourceId = "44444444-4444-4444-8444-444444444444";
const roots: Root[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) act(() => root.unmount());
	document.body.replaceChildren();
});

async function mount(role: "owner" | "use" = "owner") {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	let revision = 3,
		denied = false;
	let content: DocumentContent = {
		kind: "document",
		file: { workspaceId, resourceId },
		blocks: [
			{ type: "paragraph", text: "First" },
			{ type: "paragraph", text: "Second" },
		],
		richText: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					content: [{ type: "text", text: "First", marks: [{ type: "bold" }] }],
				},
				{ type: "paragraph", content: [{ type: "text", text: "Second" }] },
			],
		},
	};
	const result = () => {
		const base = {
			organizationId: "fixture-org",
			createdByKind: "user",
			createdById: "fixture-person",
			createdAt: "2026-11-08T12:00:00.000Z",
		};
		return {
			output: {
				...base,
				id: outputId,
				workspaceId,
				kind: "document",
				status: "active",
				title: "Meeting notes",
				currentRevisionId: revisionId,
				updatedAt: base.createdAt,
			},
			revision: {
				...base,
				id: revisionId,
				outputId,
				revision,
				content: structuredClone(content),
				note: null,
				producedBy: null,
				accessEnvelope: '{"version":1,"sources":[]}',
			},
		};
	};
	const onCall = vi.fn(
		async (_method: unknown, args: unknown): Promise<AppRuntimeHostResult> => {
			if (denied) throw new Error("Source access denied");
			if (_method === "app.download")
				return { ok: true, value: { downloaded: true } };
			const input = args as {
				method: string;
				args: [{ content: DocumentContent; expectedRevision: number }];
			};
			if (input.method === "exportMarkdown")
				return { ok: true, value: { text: "Saved document", revision } };
			if (input.method === "replaceDocument") {
				if (input.args[0].expectedRevision !== revision)
					throw new Error("Output revision changed");
				content = structuredClone(input.args[0].content);
				revision++;
			}
			return { ok: true, value: result() };
		},
	);
	const render = (
		savedRevision = 3,
		sourceUnavailable = false,
		visible = true,
	) =>
		act(() =>
			root.render(
				<DocWritingDraftProvider>
					{visible ? (
						<DocWritingEditor
							workspaceId={workspaceId}
							outputId={outputId}
							appVersion={2}
							role={role}
							onCall={onCall}
							savedRevision={savedRevision}
							sourceUnavailable={sourceUnavailable}
						/>
					) : (
						<div>Another tab</div>
					)}
				</DocWritingDraftProvider>,
			),
		);
	await render();
	await vi.waitFor(() => expect(host.querySelector(".tiptap")).not.toBeNull());
	const editor = () =>
		(host.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
	return {
		host,
		onCall,
		editor,
		render,
		saved: () => content,
		external: (value: string) => {
			revision++;
			content = {
				kind: "document",
				blocks: [{ type: "paragraph", text: value }],
			};
			return revision;
		},
		deny: () => {
			denied = true;
		},
	};
}

const click = async (host: HTMLElement, label: string) =>
	act(async () => {
		const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) =>
				node.textContent === label || node.getAttribute("aria-label") === label,
		);
		expect(button, label).toBeDefined();
		button!.click();
	});

describe("Doc writing editor", () => {
	it("uses the native rich editor and saves marks and file references through pinned app RPC with the loaded revision", async () => {
		const test = await mount();
		expect(test.host.textContent).toContain(
			"Document revision 3 · Doc app version 2",
		);
		expect(test.host.querySelector(".tiptap strong")?.textContent).toBe(
			"First",
		);
		act(() =>
			test
				.editor()
				.chain()
				.setTextSelection({ from: 1, to: 6 })
				.toggleItalic()
				.run(),
		);
		await click(test.host, "Save document");
		expect(test.onCall).toHaveBeenLastCalledWith("app.call", {
			method: "replaceDocument",
			args: [
				{
					content: expect.objectContaining({
						file: { workspaceId, resourceId },
						richText: expect.any(Object),
					}),
					expectedRevision: 3,
				},
			],
		});
		expect(test.saved().richText?.content[0]?.content?.[0]?.marks).toEqual(
			expect.arrayContaining([{ type: "bold" }, { type: "italic" }]),
		);
		expect(test.host.textContent).toContain(
			"Document revision 4 · Doc app version 2",
		);
	});

	it("moves a complete rich block and keeps the movement in native undo history", async () => {
		const test = await mount();
		act(() => test.editor().commands.setTextSelection(2));
		await click(test.host, "Move block down");
		expect([
			test.editor().state.doc.child(0).textContent,
			test.editor().state.doc.child(1).textContent,
		]).toEqual(["Second", "First"]);
		expect(test.editor().getJSON().content?.[1]?.content?.[0]?.marks).toEqual([
			{ type: "bold" },
		]);
		act(() => test.editor().commands.undo());
		expect(test.editor().state.doc.child(0).textContent).toBe("First");
	});

	it("keeps a dirty rich draft across newer saved revisions and conflicts, then requires explicit discard", async () => {
		const test = await mount();
		act(() => test.editor().commands.insertContentAt(1, "My draft "));
		await test.render(test.external("Another author"));
		expect(test.editor().getText()).toContain("My draft");
		expect(test.host.textContent).toContain(
			"A newer document revision is available",
		);
		await click(test.host, "Save document");
		expect(test.host.textContent).toContain(
			"Output revision changed. Your draft is preserved",
		);
		expect(test.editor().getText()).toContain("My draft");
		await click(test.host, "Reload saved document");
		expect(test.editor().getText()).toContain("My draft");
		await click(document.body, "Discard draft and reload");
		await vi.waitFor(() =>
			expect(test.editor().getText()).toBe("Another author"),
		);
	});

	it("refreshes clean documents through the canonical read and fails closed when source access is lost", async () => {
		const test = await mount();
		await test.render(test.external("Agent saved revision"));
		await vi.waitFor(() =>
			expect(test.editor().getText()).toBe("Agent saved revision"),
		);
		test.deny();
		await click(test.host, "Reload saved document");
		expect(test.host.textContent).toContain("Source access denied");
		expect(test.host.querySelector(".tiptap")).toBeNull();
		const calls = test.onCall.mock.calls.length;
		await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
		expect(test.onCall).toHaveBeenCalledTimes(calls);
	});

	it("exports the saved semantic document through the host and names omitted draft changes", async () => {
		const test = await mount();
		act(() => test.editor().commands.insertContentAt(1, "Unsaved "));
		await click(test.host, "Export Markdown");
		expect(test.onCall).toHaveBeenLastCalledWith("app.download", {
			filename: "Meeting notes.md",
			mimeType: "text/markdown",
			text: "Saved document",
		});
		expect(test.host.textContent).toContain(
			"Rich formatting and unsaved edits are not included",
		);
		expect(test.editor().getText()).toContain("Unsaved");
	});

	it("restores a tab's draft only after an authorized read and keeps its original CAS basis", async () => {
		const test = await mount();
		act(() => test.editor().commands.insertContentAt(1, "Retained draft "));
		await test.render(3, false, false);
		expect(test.host.querySelector(".tiptap")).toBeNull();
		await test.render(test.external("Newer saved text"));
		await vi.waitFor(() =>
			expect(test.host.querySelector(".tiptap")).not.toBeNull(),
		);
		expect(test.editor().getText()).toContain("Retained draft");
		expect(test.host.textContent).toContain("based on document revision 3");
		await click(test.host, "Save document");
		expect(test.host.textContent).toContain("Output revision changed");
	});

	it("clears the retained draft on source permission loss", async () => {
		const test = await mount();
		act(() => test.editor().commands.insertContentAt(1, "Private draft "));
		await test.render(3, true);
		expect(test.host.querySelector(".tiptap")).toBeNull();
		await test.render(3, true, false);
		await test.render(3);
		await vi.waitFor(() =>
			expect(test.host.querySelector(".tiptap")).not.toBeNull(),
		);
		expect(test.editor().getText()).not.toContain("Private draft");
	});

	it("previews an attached file and disables writing for read-only collaborators", async () => {
		const test = await mount("use");
		expect(test.editor().isEditable).toBe(false);
		expect(test.host.querySelector("[data-file-preview]")).not.toBeNull();
		expect(test.host.textContent).not.toContain("native editor");
		expect(test.onCall).toHaveBeenCalledTimes(1);
	});
});
