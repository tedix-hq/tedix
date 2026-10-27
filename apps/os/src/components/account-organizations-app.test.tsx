import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	organizations: { listAllMine: vi.fn(), listOsMine: vi.fn(), get: vi.fn() },
	userSettings: { getContext: vi.fn() },
	directory: { listMyWorkspaces: vi.fn() },
	images: { requestUpload: vi.fn(), confirmUpload: vi.fn(), delete: vi.fn() },
}));
vi.mock("@/lib/api", () => ({ osApi: api }));
import { AccountOrganizationsApp } from "./account-organizations-app";
(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const org = (id: string, role: string) => ({
	organizationId: id,
	organizationName: id,
	organizationLogoUrl: null,
	member: { role, status: "active" },
});

async function render() {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const cache = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () => {
		root.render(
			<QueryClientProvider client={cache}>
				<AccountOrganizationsApp />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(container.textContent).toContain("Org B");
	return cache;
}

describe("account organization logos", () => {
	it("offers uploads for each target owner/admin and sends the selected org id", async () => {
		api.organizations.listAllMine.mockResolvedValue({
			data: [
				org("Org B", "owner"),
				org("Org C", "admin"),
				org("Org D", "member"),
			],
			pagination: { total: 3, offset: 0, limit: 50, hasMore: false },
		});
		api.images.requestUpload.mockResolvedValue({
			imageId: "image-b",
			uploadURL: "https://upload.example.test/b",
		});
		api.images.confirmUpload.mockResolvedValue({
			url: "https://images.example.test/b",
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
		const cache = await render();
		const invalidate = vi.spyOn(cache, "invalidateQueries");
		const inputs =
			container.querySelectorAll<HTMLInputElement>('input[type="file"]');
		expect(inputs).toHaveLength(2);
		expect(container.textContent).toContain(
			"An owner or admin can change this logo.",
		);
		Object.defineProperty(inputs[0], "files", {
			configurable: true,
			value: [new File(["logo"], "logo.png", { type: "image/png" })],
		});
		await act(async () => {
			inputs[0]!.dispatchEvent(new Event("change", { bubbles: true }));
		});
		await vi.waitFor(() =>
			expect(api.images.confirmUpload).toHaveBeenCalledWith({
				entityType: "organization",
				entityId: "Org B",
				imageId: "image-b",
			}),
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(invalidate).toHaveBeenCalled();
		expect(api.images.requestUpload).toHaveBeenCalledWith({
			entityType: "organization",
			entityId: "Org B",
		});
		expect(
			invalidate.mock.calls
				.map(([args]) => JSON.stringify(args?.queryKey))
				.some((key) => key.includes("directory")),
		).toBe(true);
	});
});
