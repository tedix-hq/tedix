import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SLIDES_CLIENT_SOURCE } from "@tedix/api-contract/assets/slides-blueprint";
import { applyPresentationPatch } from "@tedix/api-contract/utils/presentation-patch";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";

type Presentation = Extract<OsOutputContent, { kind: "presentation" }>;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const field = (id: string) =>
	document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
const button = (id: string) =>
	document.querySelector<HTMLButtonElement>(`#${id}`)!;
function input(id: string, value: string) {
	field(id).value = value;
	field(id).dispatchEvent(new Event("input"));
}

async function editor(role = "owner") {
	document.body.innerHTML = '<div id="app"></div>';
	let current = {
		output: { id: "slides-output", title: "Launch" },
		revision: {
			revision: 1,
			content: {
				kind: "presentation",
				slides: [
					{ title: "One", bullets: ["First"], notes: "Notes" },
					{ title: "Two", bullets: ["Second"] },
				],
			} as Presentation,
		},
	};
	const result = () => ({
		...structuredClone(current),
		outline: structuredClone(current.revision.content.slides),
	});
	const call = vi.fn(
		async (
			method: string,
			args?: {
				method?: string;
				args?: Array<{ expectedRevision: number; ops: unknown }>;
			},
		) => {
			if (method === "context")
				return { role, settings: { slot: "presentation" } };
			if (method === "app.download") return { downloaded: true };
			if (args?.method === "readPresentation") return result();
			if (args?.method === "exportOutline")
				return {
					title: "Launch",
					revision: current.revision.revision,
					mimeType: "text/markdown",
					text: current.revision.content.slides[0]!.title,
				};
			if (args?.method !== "editSlides") throw new Error("Unexpected method");
			const request = args.args![0]!;
			if (request.expectedRevision !== current.revision.revision)
				throw new Error("Revision conflict");
			current = {
				...current,
				revision: {
					revision: current.revision.revision + 1,
					content: applyPresentationPatch(
						current.revision.content,
						request.ops,
					),
				},
			};
			return result();
		},
	);
	const listeners: Array<
		[
			string,
			EventListenerOrEventListenerObject,
			AddEventListenerOptions | boolean | undefined,
		]
	> = [];
	const add = window.addEventListener.bind(window);
	vi.spyOn(window, "addEventListener").mockImplementation(
		(name, listener, options) => {
			listeners.push([name, listener, options]);
			add(name, listener, options);
		},
	);
	await new Function(
		"tedix",
		`return (async()=>{${SLIDES_CLIENT_SOURCE}\n})();`,
	)({ call });
	cleanups.push(() => {
		for (const [name, listener, options] of listeners)
			window.removeEventListener(name, listener, options);
	});
	return {
		call,
		current: () => current,
		change(
			revision: number,
			title: string,
			source: MessageEventSource | null = window.parent,
			slot = "presentation",
			outputId = "slides-output",
		) {
			current = {
				...current,
				revision: {
					revision,
					content: { kind: "presentation", slides: [{ title, bullets: [] }] },
				},
			};
			window.dispatchEvent(
				new MessageEvent("message", {
					source,
					data: {
						jsonrpc: "2.0",
						method: "tedix/outputs-changed",
						params: {
							outputs: [
								{ slot, outputId, revision, revisionId: `r${revision}` },
							],
						},
					},
				}),
			);
		},
	};
}

describe("Slides editor", () => {
	it("edits and saves canonical slide text with the loaded revision", async () => {
		const app = await editor();
		input("title", "Edited title");
		input("bullets", "Alpha\nBeta");
		input("notes", "New notes");
		button("save").click();
		await vi.waitFor(() =>
			expect(document.querySelector(".status")?.textContent).toBe(
				"Saved · revision 2",
			),
		);
		expect(app.current().revision.content.slides[0]).toEqual({
			title: "Edited title",
			bullets: ["Alpha", "Beta"],
			notes: "New notes",
		});
		expect(app.call).toHaveBeenCalledWith("app.call", {
			method: "editSlides",
			args: [
				{
					expectedRevision: 1,
					ops: [
						{
							op: "replace",
							index: 0,
							slide: {
								title: "Edited title",
								bullets: ["Alpha", "Beta"],
								notes: "New notes",
							},
						},
					],
				},
			],
		});
	});
	it("reorders and adds slides while retaining the existing slide content", async () => {
		const app = await editor();
		button("down").click();
		button("add").click();
		input("title", "Three");
		button("save").click();
		await vi.waitFor(() => expect(app.current().revision.revision).toBe(2));
		expect(
			app.current().revision.content.slides.map((slide) => slide.title),
		).toEqual(["Two", "One", "Three"]);
		expect(app.current().revision.content.slides[1]?.notes).toBe("Notes");
		await vi.waitFor(() => expect(button("save").disabled).toBe(true));
		button("remove").click();
		button("save").click();
		await vi.waitFor(() => expect(app.current().revision.revision).toBe(3));
		expect(
			app.current().revision.content.slides.map((slide) => slide.title),
		).toEqual(["Two", "One"]);
	});
	it("ignores unrelated notifications and refreshes a clean editor", async () => {
		const app = await editor();
		app.change(2, "Untrusted", null);
		app.change(2, "Wrong slot", window.parent, "other");
		app.change(2, "Wrong output", window.parent, "presentation", "other");
		expect(field("title").value).toBe("One");
		app.change(2, "Saved externally");
		await vi.waitFor(() =>
			expect(field("title").value).toBe("Saved externally"),
		);
		expect(document.querySelector(".status")?.textContent).toBe("Revision 2");
	});
	it("preserves dirty input on external changes and conflicts until explicit discard", async () => {
		const app = await editor();
		input("title", "My draft");
		const originalField = field("title");
		app.change(2, "New saved title");
		expect(field("title")).toBe(originalField);
		expect(field("title").value).toBe("My draft");
		expect(document.querySelector("#updates")?.textContent).toContain(
			"unsaved edits are preserved",
		);
		button("save").click();
		await vi.waitFor(() =>
			expect(document.querySelector(".status")?.textContent).toContain(
				"Revision conflict",
			),
		);
		expect(field("title").value).toBe("My draft");
		button("reload").click();
		expect(field("title").value).toBe("My draft");
		button("reload").click();
		await vi.waitFor(() =>
			expect(field("title").value).toBe("New saved title"),
		);
	});
	it("returns to the selected slide after presenting and downloads saved content through the host", async () => {
		const app = await editor();
		input("title", "Unsaved first title");
		button("present").click();
		expect(document.querySelector("#presenter .badge")?.textContent).toContain(
			"unsaved changes",
		);
		button("next").click();
		button("exit").click();
		expect(field("title").value).toBe("Two");
		button("outline").click();
		await vi.waitFor(() =>
			expect(app.call).toHaveBeenCalledWith("app.download", {
				filename: "Launch.md",
				mimeType: "text/markdown",
				text: "One",
			}),
		);
		expect(document.querySelector(".status")?.textContent).toContain(
			"Unsaved edits are not included",
		);
	});
	it("keeps the editor read-only for a read role", async () => {
		await editor("read");
		expect(field("title").disabled).toBe(true);
		expect(button("save").disabled).toBe(true);
		expect(button("add").disabled).toBe(true);
		expect(button("present").disabled).toBe(false);
	});
});
