import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const exportsApi = vi.hoisted(() => ({ export: vi.fn(), get: vi.fn() }));

vi.mock("@/lib/api", () => ({
	OS_API_URL: "http://localhost:3030/api",
	osApi: { osWorkspaces: { outputs: exportsApi } },
}));

import type { OsOutputKind } from "@tedix/api-contract/schemas/os-workspaces";
import { OutputExportButtons } from "./output-export-buttons";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

function renderButtons(
	kind: OsOutputKind = "document",
	compact = true,
): HTMLElement {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<OutputExportButtons
					outputId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
					kind={kind}
					compact={compact}
				/>
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

async function openMenu(container: HTMLElement) {
	act(() =>
		container
			.querySelector<HTMLButtonElement>('[aria-label="Export"]')!
			.click(),
	);
	await flush();
}
function menuItem(label: string): HTMLElement {
	const item = [
		...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
	].find((el) => el.textContent === label);
	if (!item) throw new Error(`Missing export ${label}`);
	return item;
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	exportsApi.export.mockReset();
	exportsApi.get.mockReset();
	while (cleanups.length > 0) cleanups.pop()?.();
});

describe("OutputExportButtons", () => {
	it.each([
		["document", "Markdown (.md)", "markdown", "md"],
		["document", "HTML (.html)", "html", "html"],
		["sheet", "CSV (all sheets)", "csv", "zip"],
	] as const)(
		"downloads %s through %s",
		async (kind, label, format, extension) => {
			let downloaded = "";
			vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
				function (this: HTMLAnchorElement) {
					downloaded = this.href;
				},
			);
			exportsApi.export.mockResolvedValue({
				url: `https://api.example.test/os-exports/example/rev-2.${extension}`,
			});
			const container = renderButtons(kind);
			await openMenu(container);
			act(() => menuItem(label).click());
			await flush();
			expect(exportsApi.export).toHaveBeenCalledWith({
				outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				format,
			});
			expect(downloaded).toBe(
				`http://localhost:3030/api/os-exports/example/rev-2.${extension}`,
			);
		},
	);
	it("offers one menu and downloads a document through the session proxy", async () => {
		let downloadedUrl: string | undefined;
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement,
		) {
			downloadedUrl = this.href;
		});
		exportsApi.export.mockResolvedValue({
			url: "http://localhost:8790/os-exports/example/rev-2.docx",
		});
		const container = renderButtons();
		expect(container.querySelectorAll("button")).toHaveLength(1);
		await openMenu(container);
		expect(menuItem("PDF")).toBeTruthy();
		expect(menuItem("PNG")).toBeTruthy();
		act(() => menuItem("Document (.docx)").click());
		await flush();
		expect(exportsApi.export).toHaveBeenCalledWith({
			outputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			format: "docx",
		});
		expect(downloadedUrl).toBe(
			"http://localhost:3030/api/os-exports/example/rev-2.docx",
		);
	});
	it("names active export and prevents concurrent requests", async () => {
		let resolveExport!: (value: { url: string }) => void;
		exportsApi.export.mockReturnValue(
			new Promise((resolve) => {
				resolveExport = resolve;
			}),
		);
		const container = renderButtons();
		await openMenu(container);
		act(() => menuItem("PDF").click());
		await flush();
		expect(
			container.querySelector<HTMLButtonElement>(
				'[aria-label="Exporting PDF"]',
			)!.disabled,
		).toBe(true);
		expect(container.querySelector('[role="status"]')!.textContent).toBe(
			"Exporting PDF",
		);
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		await act(async () =>
			resolveExport({ url: "http://localhost:8790/os-exports/rev-2.pdf" }),
		);
		await flush();
	});
	it.each([false, true])(
		"keeps complete diagnostics and retries explicitly (compact=%s)",
		async (compact) => {
			const message = `Source image is unavailable. Choose Export again to retry. diagnostic_${"abcdef0123456789".repeat(16)}`;
			exportsApi.export.mockRejectedValueOnce(new Error(message));
			const download = vi
				.spyOn(HTMLAnchorElement.prototype, "click")
				.mockImplementation(() => {});
			const container = renderButtons("document", compact);
			await openMenu(container);
			act(() => menuItem("PDF").click());
			await flush();
			expect(container.querySelector('[role="alert"]')!.textContent).toBe(
				`Export failed: ${message}`,
			);
			expect(exportsApi.export).toHaveBeenCalledTimes(1);
			expect(download).not.toHaveBeenCalled();
			exportsApi.export.mockResolvedValueOnce({
				url: "https://api.example.test/os-exports/rev-2.pdf?fixture=1",
			});
			await openMenu(container);
			act(() => menuItem("PDF").click());
			await flush();
			expect(exportsApi.export).toHaveBeenCalledTimes(2);
			expect(container.querySelector('[role="alert"]')).toBeNull();
			expect(download).toHaveBeenCalledTimes(1);
			const anchor = download.mock.instances[0] as HTMLAnchorElement;
			expect(anchor.href).toBe(
				"http://localhost:3030/api/os-exports/rev-2.pdf?fixture=1",
			);
			expect(anchor.download).toBe("rev-2.pdf");
		},
	);
	it("offers applicable formats and visible failures", async () => {
		const container = renderButtons("sheet");
		exportsApi.export.mockRejectedValue(new Error("Try again"));
		await openMenu(container);
		expect(document.body.textContent).not.toContain("Document (.docx)");
		act(() => menuItem("Workbook (.xlsx)").click());
		await flush();
		expect(container.querySelector('[role="alert"]')!.textContent).toContain(
			"Try again",
		);
		expect(exportsApi.get).not.toHaveBeenCalled();
	});
});
