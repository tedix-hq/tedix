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

function renderButtons(kind: OsOutputKind = "document"): HTMLElement {
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
					compact
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
	it("offers one menu and downloads Word through the session proxy", async () => {
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
		act(() => menuItem("Word (.docx)").click());
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
	it("offers applicable formats and visible failures", async () => {
		const container = renderButtons("sheet");
		exportsApi.export.mockRejectedValue(new Error("Try again"));
		await openMenu(container);
		expect(document.body.textContent).not.toContain("Word (.docx)");
		act(() => menuItem("Excel (.xlsx)").click());
		await flush();
		expect(container.querySelector('[role="alert"]')!.textContent).toContain(
			"Try again",
		);
		expect(exportsApi.get).not.toHaveBeenCalled();
	});
});
