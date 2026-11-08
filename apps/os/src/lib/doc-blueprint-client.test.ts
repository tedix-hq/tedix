import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DOC_LEGACY_CLIENT_SOURCE as DOC_CLIENT_SOURCE } from "@tedix/api-contract/assets/doc-blueprint";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

async function editor() {
	document.body.innerHTML = '<div id="app"></div>';
	let revision = 1,
		text = "Original";
	const call = vi.fn(async (method: string, args?: Record<string, unknown>) => {
		if (method === "context")
			return { role: "owner", settings: { slot: "document" } };
		if (method === "app.download") return { downloaded: true };
		if (args?.method === "exportMarkdown")
			return { title: "Doc", revision, text, mimeType: "text/markdown" };
		if (args?.method !== "readDocument") throw new Error("Unexpected write");
		return {
			output: { id: "output", title: "Doc" },
			revision: {
				revision,
				content: { kind: "document", blocks: [{ type: "paragraph", text }] },
			},
			blockEditingSupported: true,
		};
	});
	let onMessage: EventListener | undefined;
	const add = window.addEventListener.bind(window);
	vi.spyOn(window, "addEventListener").mockImplementation(
		(name, listener, options) => {
			if (name === "message") onMessage = listener as EventListener;
			add(name, listener, options);
		},
	);
	await new Function("tedix", `return (async()=>{${DOC_CLIENT_SOURCE}\n})();`)({
		call,
	});
	cleanups.push(() => {
		if (onMessage) window.removeEventListener("message", onMessage);
	});
	return {
		call,
		change(
			nextRevision: number,
			nextText: string,
			source: MessageEventSource | null = window.parent,
			slot = "document",
			outputId = "output",
		) {
			revision = nextRevision;
			text = nextText;
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

describe("Doc external revisions", () => {
	it("downloads saved Markdown through the host instead of a sandbox Blob navigation", async () => {
		const app = await editor();
		document.querySelector<HTMLButtonElement>("#export")!.click();
		await vi.waitFor(() =>
			expect(app.call).toHaveBeenCalledWith("app.download", {
				filename: "Doc.md",
				mimeType: "text/markdown",
				text: "Original",
			}),
		);
		expect(document.querySelector(".status")?.textContent).toBe(
			"Exported saved revision 1",
		);
	});

	it("refreshes clean content through the canonical read and ignores unrelated senders and slots", async () => {
		const app = await editor();
		expect(document.querySelector("textarea")?.value).toBe("Original");
		app.change(2, "Untrusted", null);
		app.change(2, "Other slot", window.parent, "other");
		app.change(2, "Other document", window.parent, "document", "other-output");
		expect(app.call).toHaveBeenCalledTimes(2);
		app.change(2, "Agent update");
		await vi.waitFor(() =>
			expect(document.querySelector("textarea")?.value).toBe("Agent update"),
		);
		expect(document.querySelector(".status")?.textContent).toBe("Revision 2");
	});
	it("keeps a dirty draft and requires explicit discard before loading the newer document", async () => {
		const app = await editor();
		const field = document.querySelector("textarea")!;
		field.value = "My unsaved draft";
		field.dispatchEvent(new Event("input"));
		app.change(2, "Agent update");
		expect(document.querySelector("textarea")).toBe(field);
		expect(field.value).toBe("My unsaved draft");
		expect(document.querySelector("#updates")?.textContent).toContain(
			"Revision 2 is available. Your unsaved edits are preserved",
		);
		expect(app.call).toHaveBeenCalledTimes(2);
		document.querySelector<HTMLButtonElement>("#reload")!.click();
		expect(field.value).toBe("My unsaved draft");
		expect(app.call).toHaveBeenCalledTimes(2);
		document.querySelector<HTMLButtonElement>("#reload")!.click();
		await vi.waitFor(() =>
			expect(document.querySelector("textarea")?.value).toBe("Agent update"),
		);
		expect(document.querySelector("#updates")?.textContent).toBe("");
	});
});
