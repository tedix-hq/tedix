import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DocumentContent } from "@/lib/output-models";
import type { RemoteCursor } from "@/lib/document-remote-cursors";
import { type DocumentCollab, DocumentEditor } from "./output-editor-document";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const twoParagraphs = (first: string, second: string): DocumentContent => ({
	kind: "document",
	blocks: [
		{ type: "paragraph", text: first },
		{ type: "paragraph", text: second },
	],
});

async function mount(cursors: readonly RemoteCursor[] = []) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const onChange = vi.fn();
	let remote: ((next: DocumentContent) => void) | null = null;
	const publishSelection = vi.fn();
	const collab: DocumentCollab = {
		subscribe: (apply) => {
			remote = apply;
			return () => {
				remote = null;
			};
		},
		publishSelection,
	};
	const render = (next: readonly RemoteCursor[]) =>
		root.render(
			<DocumentEditor
				value={twoParagraphs("Mine", "Theirs")}
				onChange={onChange}
				collab={collab}
				remoteCursors={next}
			/>,
		);
	await act(async () => {
		render(cursors);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	const editor = (
		container.querySelector(".tiptap") as HTMLElement & { editor: Editor }
	).editor;
	return {
		container,
		editor,
		onChange,
		publishSelection,
		receive: (next: DocumentContent) => act(() => remote?.(next)),
		setCursors: (next: readonly RemoteCursor[]) => act(() => render(next)),
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

describe("DocumentEditor live co-editing", () => {
	it("applies a peer's change while focused without moving the caret, echoing it, or adding it to undo", async () => {
		const mounted = await mount();
		act(() => {
			mounted.editor.chain().focus().setTextSelection(5).run();
			mounted.editor.commands.insertContent("!");
		});
		expect(mounted.onChange).toHaveBeenCalledOnce();
		const caret = mounted.editor.state.selection.head;

		mounted.receive(twoParagraphs("Mine!", "Theirs typed"));

		expect(mounted.editor.getText({ blockSeparator: "|" })).toBe(
			"Mine!|Theirs typed",
		);
		expect(mounted.editor.state.selection.head).toBe(caret);
		expect(mounted.onChange).toHaveBeenCalledOnce();
		act(() => {
			mounted.editor.commands.undo();
		});
		expect(mounted.editor.getText({ blockSeparator: "|" })).toBe(
			"Mine|Theirs typed",
		);
		mounted.unmount();
	});

	it("publishes its selection in editor positions and withdraws it on unmount", async () => {
		const mounted = await mount();
		vi.useFakeTimers();
		try {
			act(() => {
				mounted.editor.commands.setTextSelection({ from: 2, to: 4 });
			});
			act(() => {
				vi.advanceTimersByTime(100);
			});
			expect(mounted.publishSelection).toHaveBeenLastCalledWith({
				anchor: 2,
				head: 4,
			});
			mounted.unmount();
			expect(mounted.publishSelection).toHaveBeenLastCalledWith(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it("renders a named caret for each collaborator", async () => {
		const mounted = await mount();
		await mounted.setCursors([
			{ key: "ada", name: "Ada", color: "#2563eb", anchor: 8, head: 10 },
		]);
		const caret = mounted.container.querySelector("[data-collab-caret]");
		expect(caret?.textContent).toBe("Ada");
		expect(mounted.container.querySelector(".collab-selection")).not.toBeNull();
		await mounted.setCursors([]);
		expect(mounted.container.querySelector("[data-collab-caret]")).toBeNull();
		mounted.unmount();
	});
});
