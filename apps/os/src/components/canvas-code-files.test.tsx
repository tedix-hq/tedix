import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CanvasCodeFiles } from "./canvas-code-files";

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

const files = [
	{ path: "README.md", hint: "About the app" },
	{ path: "client.js", hint: "What people see" },
];

function setup() {
	const onSelect = vi.fn();
	const host = document.createElement("div");
	document.body.append(host);
	act(() =>
		createRoot(host).render(
			<CanvasCodeFiles
				files={files}
				current="README.md"
				onSelect={onSelect}
				textFor={(path) => `text of ${path}`}
			/>,
		),
	);
	return { host, onSelect };
}

describe("CanvasCodeFiles", () => {
	it("lists each file with its own More button and marks the open one", () => {
		const { host, onSelect } = setup();
		const names = [
			...host.querySelectorAll<HTMLElement>(".canvas-code-file-button"),
		];
		expect(names.map((node) => node.textContent)).toEqual([
			"README.md",
			"client.js",
		]);
		expect(names[0]!.getAttribute("aria-current")).toBe("page");
		expect(names[1]!.getAttribute("aria-current")).toBeNull();
		expect(
			host.querySelector('[aria-label="More for client.js"]'),
		).not.toBeNull();
		act(() => names[1]!.click());
		expect(onSelect).toHaveBeenCalledWith("client.js");
	});

	it("downloads a file's current text under its name", async () => {
		const blobs: Blob[] = [];
		URL.createObjectURL = vi.fn((blob: Blob) => {
			blobs.push(blob);
			return "blob:file";
		});
		URL.revokeObjectURL = vi.fn();
		const saved: string[] = [];
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			saved.push(this.download);
		});
		const { host, onSelect } = setup();
		await act(async () =>
			host
				.querySelector<HTMLElement>('[aria-label="More for client.js"]')!
				.click(),
		);
		const entry = [
			...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
		].find((node) => node.textContent?.includes("Download"));
		expect(entry).toBeDefined();
		await act(async () => entry!.click());
		expect(saved).toEqual(["client.js"]);
		expect(await blobs[0]!.text()).toBe("text of client.js");
		// Opening the menu does not switch the open file.
		expect(onSelect).not.toHaveBeenCalled();
	});
});
