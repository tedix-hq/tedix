import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	open: vi.fn(),
	access: vi.fn(),
	get: vi.fn(),
	restore: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		osCollaborators: { open: api.open, access: api.access },
		osWorkspaces: { workspaces: { get: api.get, restore: api.restore } },
		osAppRuntime: {},
	},
	osAppRuntimeCall: vi.fn(),
}));
vi.mock("@/lib/workspace-presence", () => ({
	useWorkspacePresence: () => [],
}));

import { SharedWorkspacePage } from "./shared-workspace-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOT_FOUND = { code: "NOT_FOUND", status: 404 };
const ARCHIVED = {
	id: WORKSPACE_ID,
	name: "Launch plan",
	status: "archived",
	updatedAt: "2026-11-12T09:30:00.000Z",
};

let root: Root | undefined;

async function renderPage() {
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	await act(async () => {
		root!.render(
			<QueryClientProvider client={client}>
				<SharedWorkspacePage workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		);
	});
	await act(() =>
		vi.waitFor(() =>
			expect(container.textContent).not.toContain("Opening workspace"),
		),
	);
	return container;
}

const restoreButton = (container: HTMLElement) =>
	[...container.querySelectorAll("button")].find(
		(button) => button.textContent === "Restore workspace",
	);

afterEach(() => {
	act(() => root?.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("a workspace address that does not open", () => {
	it("says an archived workspace is archived, when, and restores it", async () => {
		const assign = vi
			.spyOn(window.location, "assign")
			.mockImplementation(() => undefined);
		api.open.mockRejectedValue(NOT_FOUND);
		api.get.mockResolvedValue({ workspace: ARCHIVED, url: null });
		api.restore.mockResolvedValue({
			workspace: { ...ARCHIVED, status: "active" },
		});
		const container = await renderPage();

		expect(api.get).toHaveBeenCalledWith({ workspaceId: WORKSPACE_ID });
		const notice = container.querySelector("[data-workspace-archived]");
		expect(notice?.textContent).toContain("Launch plan is archived");
		expect(notice?.textContent).toContain(
			`Archived on ${new Date(ARCHIVED.updatedAt).toLocaleDateString()}`,
		);
		expect(container.textContent).not.toContain("doesn't exist");
		expect(
			[...container.querySelectorAll("a")].map((link) => [
				link.textContent,
				link.getAttribute("href"),
			]),
		).toEqual([["Workspaces → Archived", "/workspaces?view=archived"]]);

		await act(async () => restoreButton(container)!.click());
		await act(() =>
			vi.waitFor(() =>
				expect(assign).toHaveBeenCalledWith(`/workspace/${WORKSPACE_ID}`),
			),
		);
		expect(api.restore.mock.calls[0]?.[0]).toEqual({
			workspaceId: WORKSPACE_ID,
		});
	});

	it("shows why a restore was refused and stays on the page", async () => {
		const assign = vi
			.spyOn(window.location, "assign")
			.mockImplementation(() => undefined);
		api.open.mockRejectedValue(NOT_FOUND);
		api.get.mockResolvedValue({ workspace: ARCHIVED, url: null });
		api.restore.mockRejectedValue(new Error("Only the owner can restore it"));
		const container = await renderPage();

		await act(async () => restoreButton(container)!.click());
		await act(() =>
			vi.waitFor(() =>
				expect(container.textContent).toContain(
					"Could not restore the workspace",
				),
			),
		);
		expect(container.textContent).toContain("Only the owner can restore it");
		expect(assign).not.toHaveBeenCalled();
		expect(restoreButton(container)).toBeDefined();
	});

	it("keeps the missing message, with no Restore, for a workspace the person may not see", async () => {
		api.open.mockRejectedValue(NOT_FOUND);
		api.get.mockRejectedValue(NOT_FOUND);
		const container = await renderPage();

		expect(container.textContent).toContain("This workspace doesn't exist");
		expect(container.textContent).toContain("It may have been deleted.");
		expect(container.querySelector("[data-workspace-archived]")).toBeNull();
		expect(restoreButton(container)).toBeUndefined();
		expect(container.querySelector("a")).toBeNull();
	});

	it("does not look the workspace up when access is refused", async () => {
		api.open.mockRejectedValue({ code: "FORBIDDEN", status: 403 });
		const container = await renderPage();

		expect(container.textContent).toContain("You don't have access");
		expect(api.get).not.toHaveBeenCalled();
		expect(container.querySelector("[data-workspace-archived]")).toBeNull();
	});
});
