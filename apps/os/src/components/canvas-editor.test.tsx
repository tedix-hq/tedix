import { undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	applyCodeChange,
	type CodeChange,
	type CodeContent,
} from "@/collab/ot/code-change";
import type { OtEditSession } from "@/collab/ot/edit-session";
import { setThemePreference } from "@/lib/theme";
import {
	CanvasCodeEditor,
	type CanvasCodeEditorProps,
	specsFromTextChange,
} from "./canvas-editor";

const PATH = "content";

/**
 * A hand-written `OtEditSession`: stable identity (the editor's rebuild key), a local text buffer,
 * and recorders for what the editor pushed. No OT client, no socket — the seam is the whole point.
 */
class FakeSession implements OtEditSession {
	readonly localChanges: { change: CodeChange; newText: string }[] = [];
	block: ReturnType<OtEditSession["blocked"]> = null;
	#text: string;
	#listeners = new Set<(change: CodeChange) => void>();

	constructor(text: string) {
		this.#text = text;
	}

	text(): string {
		return this.#text;
	}

	applyLocal(change: CodeChange, _path: string, newText: string): void {
		this.localChanges.push({ change, newText });
		this.#text = newText;
	}

	onRemote(listener: (change: CodeChange) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	blocked() {
		return this.block;
	}

	/** Deliver a change as though it came from another replica. */
	emit(change: CodeChange): void {
		for (const listener of this.#listeners) listener(change);
	}

	/** How many remote listeners are still attached. An unmount must leave none. */
	get listenerCount(): number {
		return this.#listeners.size;
	}
}

function render(props: CanvasCodeEditorProps) {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	const draw = (next: CanvasCodeEditorProps) => {
		act(() => {
			root.render(createElement(CanvasCodeEditor, next));
		});
	};
	draw(props);
	const host = container.querySelector<HTMLElement>(
		'[data-testid="canvas-editor"]',
	);
	if (host === null) throw new Error("editor host did not render");
	const view = EditorView.findFromDOM(host);
	if (view === null) throw new Error("CodeMirror view did not mount");
	return {
		container,
		view,
		rerender: draw,
		unmount: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

/** Type at the end of the document, the way a keystroke would. */
function typeAtEnd(view: EditorView, insert: string) {
	act(() => {
		view.dispatch({
			changes: { from: view.state.doc.length, insert },
		});
	});
}

// This happy-dom setup exposes no bare `localStorage` global, which setThemePreference writes
// through.
beforeEach(() => {
	const store = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => store.get(key) ?? null,
		setItem: (key: string, value: string) => store.set(key, value),
		removeItem: (key: string) => store.delete(key),
	});
});

afterEach(() => {
	setThemePreference("system");
	vi.unstubAllGlobals();
});

describe("specsFromTextChange", () => {
	it("tiles the original text into position-based specs", () => {
		expect(specsFromTextChange([2, [2, "ok"], 3])).toEqual([
			{ from: 2, to: 4, insert: "ok" },
		]);
	});

	it("joins a multi-line insertion with \\n", () => {
		expect(specsFromTextChange([[0, "a", "b"]])).toEqual([
			{ from: 0, to: 0, insert: "a\nb" },
		]);
	});
});

describe("CanvasCodeEditor", () => {
	it("seeds the view from the session's text for the path", () => {
		const session = new FakeSession('{"a":1}');
		const rendered = render({ session, path: PATH });
		expect(rendered.view.state.doc.toString()).toBe('{"a":1}');
		rendered.unmount();
	});

	it("pushes a local edit as a CodeChange whose edit replays to the same text", () => {
		const before = '{"a":1}';
		const session = new FakeSession(before);
		const rendered = render({ session, path: PATH });
		typeAtEnd(rendered.view, "\n");

		expect(session.localChanges).toHaveLength(1);
		const pushed = session.localChanges[0]!;
		expect(pushed.newText).toBe(rendered.view.state.doc.toString());

		// The assumption this whole binding rests on: `update.changes.toJSON()` IS a TextChange, so
		// the OT module's own application of the pushed change reproduces the editor's document
		// exactly. `toJSON()` is typed `any`, so nothing but this test pins it.
		const content: CodeContent = new Map([[PATH, before]]);
		expect(applyCodeChange(content, pushed.change).get(PATH)).toBe(
			pushed.newText,
		);
		rendered.unmount();
	});

	it("splits lines on \\n only, so CRLF offsets survive the round trip", () => {
		const session = new FakeSession("a\r\nb");
		const rendered = render({ session, path: PATH });
		// The "\n"-only splitter breaks after the "\r" and KEEPS it, so the document is still the
		// exact 4 code units it was stored as. CodeMirror's default splitter treats "\r\n" as one
		// break and drops the "\r", leaving 3 — every OT offset past it off by one, forever. This
		// matches `code-change.ts`'s own `text.split("\n")`.
		expect(rendered.view.state.doc.length).toBe(4);
		expect(rendered.view.state.doc.toString()).toBe("a\r\nb");
		expect(rendered.view.state.doc.line(1).text).toBe("a\r");
		// Control: the same text through CodeMirror's default splitter loses a code unit.
		expect(EditorState.create({ doc: "a\r\nb" }).doc.length).toBe(3);

		typeAtEnd(rendered.view, "c");
		const pushed = session.localChanges[0]!;
		const content: CodeContent = new Map([[PATH, "a\r\nb"]]);
		expect(applyCodeChange(content, pushed.change).get(PATH)).toBe("a\r\nbc");
		rendered.unmount();
	});

	it("applies a remote edit without echoing it back as a local change", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		act(() => {
			session.emit([[PATH, { edit: [1, [0, "X"], 1] }]]);
		});
		expect(rendered.view.state.doc.toString()).toBe("aXb");
		expect(session.localChanges).toHaveLength(0);
		rendered.unmount();
	});

	it("keeps remote changes out of the undo history", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		typeAtEnd(rendered.view, "c");
		act(() => {
			session.emit([[PATH, { edit: [1, [0, "X"], 2] }]]);
		});
		expect(rendered.view.state.doc.toString()).toBe("aXbc");

		// One undo removes this user's own "c" and nothing else — the collaborator's "X" survives.
		act(() => {
			undo(rendered.view);
		});
		expect(rendered.view.state.doc.toString()).toBe("aXb");
		rendered.unmount();
	});

	it("applies a remote `set` and `remove` wholesale", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		act(() => {
			session.emit([[PATH, { set: "fresh" }]]);
		});
		expect(rendered.view.state.doc.toString()).toBe("fresh");
		act(() => {
			session.emit([[PATH, { remove: true }]]);
		});
		expect(rendered.view.state.doc.toString()).toBe("");
		expect(session.localChanges).toHaveLength(0);
		rendered.unmount();
	});

	it("ignores a remote change addressed to another file", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		act(() => {
			session.emit([["other", { set: "nope" }]]);
		});
		expect(rendered.view.state.doc.toString()).toBe("ab");
		rendered.unmount();
	});

	it("throws rather than clipping when a remote edit disagrees with the document", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		// An edit built against a 20-unit text. Position-based specs make this a visible failure;
		// ChangeSet.fromJSON would have clipped it into a silently divergent replica.
		expect(() => {
			session.emit([[PATH, { edit: [10, [5, "boom"], 5] }]]);
		}).toThrow();
		rendered.unmount();
	});

	it("blocks editing and explains why while the session reports a block", () => {
		const session = new FakeSession("ab");
		session.block = { code: "capacity", message: "Room is at capacity." };
		const rendered = render({ session, path: PATH });
		act(() => {
			session.emit([]);
		});
		expect(rendered.view.state.readOnly).toBe(true);
		expect(
			rendered.container.querySelector('[data-testid="canvas-editor-blocked"]')
				?.textContent,
		).toContain("Room is at capacity.");

		session.block = null;
		act(() => {
			session.emit([]);
		});
		expect(rendered.view.state.readOnly).toBe(false);
		expect(
			rendered.container.querySelector('[data-testid="canvas-editor-blocked"]'),
		).toBeNull();
		rendered.unmount();
	});

	it("honours the readOnly prop and flips it in place", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH, readOnly: true });
		expect(rendered.view.state.readOnly).toBe(true);
		rendered.rerender({ session, path: PATH, readOnly: false });
		expect(rendered.view.state.readOnly).toBe(false);
		// Reconfiguration, not a rebuild: the same view instance survives.
		expect(EditorView.findFromDOM(rendered.container)).toBe(rendered.view);
		rendered.unmount();
	});

	it("destroys the view and drops its remote subscription on unmount", () => {
		const session = new FakeSession("hello");
		const rendered = render({ session, path: PATH });
		expect(session.listenerCount).toBe(1);
		const { view } = rendered;

		rendered.unmount();

		// The session OUTLIVES the editor -- a reconnect swaps the client underneath it -- so an
		// editor that left its listener attached would keep applying remote changes to a destroyed
		// view for the life of the room, and hold the whole CodeMirror state alive with it.
		expect(session.listenerCount).toBe(0);
		expect(view.dom.isConnected).toBe(false);
		expect(() =>
			session.emit([[PATH, { set: "after unmount" }]]),
		).not.toThrow();
	});

	it("follows the OS theme mode without rebuilding the view", () => {
		const session = new FakeSession("ab");
		const rendered = render({ session, path: PATH });
		expect(rendered.view.state.facet(EditorView.darkTheme)).toBe(false);
		act(() => setThemePreference("dark"));
		expect(rendered.view.state.facet(EditorView.darkTheme)).toBe(true);
		expect(EditorView.findFromDOM(rendered.container)).toBe(rendered.view);
		rendered.unmount();
	});
});
