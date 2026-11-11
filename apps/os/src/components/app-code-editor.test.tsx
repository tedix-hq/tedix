import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import AppCodeEditor, { appCodeLanguage } from "./app-code-editor";

afterEach(() => {
	document.body.replaceChildren();
});

function mount(props: Parameters<typeof AppCodeEditor>[0]) {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	const render = (next: Parameters<typeof AppCodeEditor>[0]) =>
		act(() => root.render(<AppCodeEditor {...next} />));
	render(props);
	const view = () =>
		EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
	return { host, render, view };
}

describe("AppCodeEditor", () => {
	it("picks the syntax from the file's extension", async () => {
		for (const path of ["client.js", "manifest.json", "README.md", "a.ts"])
			expect(await appCodeLanguage(path), path).not.toEqual([]);
		expect(await appCodeLanguage("notes.txt")).toEqual([]);
		expect(await appCodeLanguage("LICENSE")).toEqual([]);
	});

	it("shows the file with line numbers and reports edits", () => {
		const onChange = vi.fn();
		const { host, view } = mount({
			path: "client.js",
			value: "const a = 1;\n",
			onChange,
		});
		expect(host.querySelector(".cm-lineNumbers")).not.toBeNull();
		expect(host.querySelector(".cm-foldGutter")).not.toBeNull();
		expect(host.querySelector(".cm-content")!.getAttribute("aria-label")).toBe(
			"Edit client.js",
		);
		act(() => view().dispatch({ changes: { from: 0, insert: "// hi\n" } }));
		expect(onChange).toHaveBeenCalledWith("// hi\nconst a = 1;\n");
	});

	it("takes replaced text without reporting it as an edit", () => {
		const onChange = vi.fn();
		const { render, view } = mount({ path: "a.json", value: "{}", onChange });
		render({ path: "a.json", value: '{"a":1}', onChange });
		expect(view().state.doc.toString()).toBe('{"a":1}');
		expect(onChange).not.toHaveBeenCalled();
	});

	it("does not accept typing when read-only", () => {
		const { host, view } = mount({
			path: "server.js",
			value: "x",
			readOnly: true,
		});
		expect(view().state.readOnly).toBe(true);
		expect(host.querySelector(".cm-content")!.getAttribute("aria-label")).toBe(
			"Contents of server.js",
		);
	});
});
