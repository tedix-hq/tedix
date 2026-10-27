import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PresentationContent } from "@/lib/output-models";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { isSlideImageResource } from "./slide-media-picker";

const resources = vi.hoisted(() => ({
	list: vi.fn(),
	getFile: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: { osWorkspaces: { resources } },
}));
import { SlidesEditor } from "./output-editor-slides";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const FILE_ID = "22222222-2222-4222-8222-222222222222";

const fileResource = (overrides: Record<string, unknown> = {}) => ({
	id: FILE_ID,
	organizationId: "org",
	workspaceId: WORKSPACE_ID,
	slot: null,
	providerId: "tedix",
	connectionScope: "tenant",
	personalOwnerUserId: null,
	connectionInstanceId: null,
	providerAccess: null,
	requiredScopes: [],
	resourceType: "file",
	providerResourceId: FILE_ID,
	name: "Icon.svg",
	metadata: { mimeType: "image/svg+xml", size: 6 },
	status: "active",
	createdByKind: "user",
	createdById: "user-1",
	createdAt: "2026-01-01T00:00:00Z",
	updatedAt: "2026-01-01T00:00:00Z",
	removedAt: null,
	...overrides,
});

function mountEditor(withWorkspace = true) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const root = createRoot(container);
	const emitted: PresentationContent[] = [];
	function Harness() {
		const [value, setValue] = useState<PresentationContent>({
			kind: "presentation",
			slides: [{ title: "Launch", bullets: [] }],
		});
		return (
			<SlidesEditor
				value={value}
				workspaceId={withWorkspace ? WORKSPACE_ID : undefined}
				onChange={(next) => {
					emitted.push(next);
					setValue(next);
				}}
			/>
		);
	}
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<Harness />
			</QueryClientProvider>,
		),
	);
	return {
		container,
		emitted,
		elements: () => emitted.at(-1)?.deck?.slides[0]?.elements ?? [],
		cleanup: () => {
			act(() => root.unmount());
			client.clear();
			container.remove();
		},
	};
}

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 8; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function until(check: () => boolean) {
	for (let attempt = 0; attempt < 100 && !check(); attempt += 1) await flush();
}

async function openImagePicker(container: HTMLElement) {
	await act(async () => {
		container
			.querySelector<HTMLButtonElement>('[aria-label="Insert slide element"]')!
			.click();
	});
	await until(() => document.querySelector('[data-slide-component="image"]') !== null);
	await act(async () => {
		document
			.querySelector<HTMLButtonElement>('[data-slide-component="image"]')!
			.click();
	});
	await until(() => document.querySelector('[aria-label="Choose slide image"]') !== null);
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("isSlideImageResource", () => {
	it("keeps tedix file resources whose mime type a slide can embed", () => {
		expect(isSlideImageResource(fileResource())).toBe(true);
		expect(
			isSlideImageResource(
				fileResource({ metadata: { mimeType: "application/pdf" } }),
			),
		).toBe(false);
		expect(
			isSlideImageResource(fileResource({ resourceType: "calendar" })),
		).toBe(false);
		expect(
			isSlideImageResource(fileResource({ providerId: "google" })),
		).toBe(false);
	});
});

describe("slide media picker", () => {
	it("embeds a workspace image file as a new slide element", async () => {
		resources.list.mockResolvedValue({
			items: [
				fileResource(),
				fileResource({
					id: "33333333-3333-4333-8333-333333333333",
					name: "notes.pdf",
					metadata: { mimeType: "application/pdf", size: 10 },
				}),
			],
			truncated: false,
		});
		resources.getFile.mockResolvedValue({
			filename: "Icon.svg",
			mimeType: "image/svg+xml",
			size: 6,
			url: "/api/workspace-files/icon.svg",
			expiresAt: "2026-01-01T01:00:00Z",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response("<svg/>")),
		);
		const mounted = mountEditor();
		await openImagePicker(mounted.container);
		expect(resources.list).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			status: "active",
			limit: 100,
		});
		await until(
			() =>
				document.querySelector('[aria-label="Use workspace image Icon.svg"]') !==
				null,
		);
		expect(
			document.querySelector('[aria-label^="Use workspace image notes.pdf"]'),
		).toBeNull();
		await act(async () => {
			document
				.querySelector<HTMLButtonElement>(
					'[aria-label="Use workspace image Icon.svg"]',
				)!
				.click();
		});
		await until(() =>
			mounted.elements().some((element) => element.type === "svg"),
		);
		expect(resources.getFile).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			resourceId: FILE_ID,
		});
		expect(
			mounted.elements().find((element) => element.type === "svg")?.src,
		).toBe("data:image/svg+xml;base64,PHN2Zy8+");
		mounted.cleanup();
	});

	it("inserts an image by URL and hides the workspace list without a workspace", async () => {
		const mounted = mountEditor(false);
		await openImagePicker(mounted.container);
		expect(
			document.querySelector('[aria-label="Workspace images"]'),
		).toBeNull();
		const input = document.querySelector<HTMLInputElement>(
			'[aria-label="Slide image URL"]',
		)!;
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		act(() => {
			setValue.call(input, "https://example.org/hero.png");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const useLink = [...document.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "Use link",
		)!;
		expect(useLink.disabled).toBe(false);
		act(() => useLink.click());
		await until(() =>
			mounted.elements().some((element) => element.type === "image"),
		);
		expect(
			mounted.elements().find((element) => element.type === "image")?.src,
		).toBe("https://example.org/hero.png");
		expect(resources.list).not.toHaveBeenCalled();
		mounted.cleanup();
	});
});
