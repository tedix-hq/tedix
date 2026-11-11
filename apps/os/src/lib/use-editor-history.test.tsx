import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { applyPatches, diffValues } from "@/lib/editor-patches";
import {
	type EditorHistoryOptions,
	HISTORY_COALESCE_MS,
	useEditorHistory,
} from "@/lib/use-editor-history";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

interface Element {
	id: string;
	text: string;
	x: number;
}
interface Doc {
	title: string;
	elements: Element[];
	rows: (string | null)[][];
}

const doc = (): Doc => ({
	title: "Deck",
	elements: [
		{ id: "e1", text: "One", x: 0 },
		{ id: "e2", text: "Two", x: 0 },
	],
	rows: [
		["a", "b"],
		["c", null],
	],
});

type History = ReturnType<typeof useEditorHistory<Doc>>;

/** Two editors over one shared value: the collab room, reduced to a state. */
function mountRoom(options: EditorHistoryOptions<Doc> = {}) {
	const container = document.createElement("div");
	const root = createRoot(container);
	let clock = 0;
	const users: Record<"a" | "b", History> = {} as never;
	let shared = doc();
	function User({
		name,
		value,
		setValue,
	}: {
		name: "a" | "b";
		value: Doc;
		setValue: (next: Doc) => void;
	}) {
		users[name] = useEditorHistory(value, setValue, {
			...options,
			now: () => clock,
		});
		return null;
	}
	function Room() {
		const [value, setValue] = useState(shared);
		shared = value;
		return (
			<>
				<User name="a" value={value} setValue={setValue} />
				<User name="b" value={value} setValue={setValue} />
			</>
		);
	}
	act(() => root.render(<Room />));
	const run = (fn: () => void) => act(fn);
	return {
		users,
		value: () => shared,
		/** User `name` edits the current shared value. */
		edit: (name: "a" | "b", change: (value: Doc) => Doc) =>
			run(() => users[name].commit(change(shared))),
		undo: (name: "a" | "b") => run(() => users[name].undo()),
		redo: (name: "a" | "b") => run(() => users[name].redo()),
		tick: (ms = HISTORY_COALESCE_MS + 1) => {
			clock += ms;
		},
		cleanup: () => act(() => root.unmount()),
	};
}

const setText = (id: string, text: string) => (value: Doc) => ({
	...value,
	elements: value.elements.map((e) => (e.id === id ? { ...e, text } : e)),
});

describe("useEditorHistory", () => {
	it("undoes only this user's edit and keeps a colleague's", () => {
		const room = mountRoom();
		room.edit("a", setText("e1", "A wrote this"));
		room.tick();
		room.edit("b", setText("e2", "B wrote this"));
		room.undo("a");
		expect(room.value().elements.map((e) => e.text)).toEqual([
			"One",
			"B wrote this",
		]);
		expect(room.users.a.notice).toBeNull();
		room.redo("a");
		expect(room.value().elements[0]!.text).toBe("A wrote this");
		expect(room.value().elements[1]!.text).toBe("B wrote this");
		room.cleanup();
	});

	it("coalesces typing into one field until a pause or seal", () => {
		const room = mountRoom();
		for (const text of ["H", "He", "Hel", "Hello"]) {
			room.tick(200);
			room.edit("a", setText("e1", text));
		}
		room.tick();
		room.edit("a", setText("e1", "Hello again"));
		room.undo("a");
		expect(room.value().elements[0]!.text).toBe("Hello");
		room.undo("a");
		expect(room.value().elements[0]!.text).toBe("One");
		expect(room.users.a.canUndo).toBe(false);

		// Another field starts its own step even without a pause, and seal()
		// (blur) ends a step for the same field.
		room.edit("a", setText("e1", "X"));
		room.edit("a", setText("e2", "Y"));
		act(() => room.users.a.seal());
		room.edit("a", setText("e2", "YZ"));
		room.undo("a");
		expect(room.value().elements.map((e) => e.text)).toEqual(["X", "Y"]);
		room.undo("a");
		expect(room.value().elements.map((e) => e.text)).toEqual(["X", "Two"]);
		room.cleanup();
	});

	it("skips and announces a path a colleague changed since", () => {
		const room = mountRoom();
		room.edit("a", (value) => ({
			...setText("e1", "A")(value),
			title: "A title",
		}));
		room.edit("b", setText("e1", "B"));
		room.undo("a");
		expect(room.value().elements[0]!.text).toBe("B");
		expect(room.value().title).toBe("Deck");
		expect(room.users.a.notice).toMatch(/Undo skipped 1 change/);
		room.cleanup();
	});

	it("removes only the element this user added, and restores a deleted one in place", () => {
		const room = mountRoom();
		room.edit("a", (value) => ({
			...value,
			elements: [...value.elements, { id: "e3", text: "New", x: 0 }],
		}));
		room.tick();
		room.edit("b", (value) => ({
			...value,
			elements: [{ id: "b1", text: "B's", x: 1 }, ...value.elements],
		}));
		room.undo("a");
		expect(room.value().elements.map((e) => e.id)).toEqual(["b1", "e1", "e2"]);

		room.edit("a", (value) => ({
			...value,
			elements: value.elements.filter((e) => e.id !== "e1"),
		}));
		room.tick();
		room.edit("b", setText("e2", "B edit"));
		room.undo("a");
		expect(room.value().elements.map((e) => [e.id, e.text])).toEqual([
			["b1", "B's"],
			["e1", "One"],
			["e2", "B edit"],
		]);
		room.cleanup();
	});

	it("ignores derived paths and rebuilds them after undo", () => {
		const room = mountRoom({
			ignore: (path) => path[0] === "title",
			project: (value) => ({
				...value,
				title: value.elements.map((e) => e.text).join("+"),
			}),
		});
		room.edit("a", (value) => ({
			...setText("e1", "A")(value),
			title: "A+Two",
		}));
		room.edit("b", (value) => ({ ...value, title: "B's projection" }));
		room.undo("a");
		expect(room.value().elements[0]!.text).toBe("One");
		expect(room.value().title).toBe("One+Two");
		expect(room.users.a.notice).toBeNull();
		room.cleanup();
	});
});

describe("editor patches", () => {
	it("addresses positional cells by index and leaves other cells alone", () => {
		const before = doc();
		const after = { ...before, rows: [["a", "A"], before.rows[1]!] };
		const patches = diffValues(before, after);
		expect(patches).toEqual([
			{ kind: "set", path: ["rows", 0, 1], before: "b", after: "A" },
		]);
		const colleague = { ...after, rows: [after.rows[0]!, ["c", "B"]] };
		const undone = applyPatches(colleague, patches, "undo");
		expect(undone.value.rows).toEqual([
			["a", "b"],
			["c", "B"],
		]);
		expect(undone.conflicts).toEqual([]);
	});

	it("reports a missing element as a conflict instead of recreating it", () => {
		const before = doc();
		const after = setText("e1", "A")(before);
		const patches = diffValues(before, after);
		const deleted = {
			...after,
			elements: after.elements.filter((e) => e.id !== "e1"),
		};
		const result = applyPatches(deleted, patches, "undo");
		expect(result.applied).toBe(0);
		expect(result.conflicts).toHaveLength(1);
		expect(result.value).toBe(deleted);
	});

	it("restores order only when no one reordered since", () => {
		const before = doc();
		const after = { ...before, elements: [...before.elements].reverse() };
		const patches = diffValues(before, after);
		expect(applyPatches(after, patches, "undo").value.elements[0]!.id).toBe(
			"e1",
		);
	});
});
