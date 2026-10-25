import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ list: vi.fn(), remove: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		osWorkspaces: {
			resources: { list: mocks.list, remove: mocks.remove },
		},
	},
}));
import { WorkspaceRunners } from "./workspace-runners";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

function row(id: string, resourceType: string, name: string, ref: string) {
	return {
		id,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		slot: null,
		providerId: resourceType === "repository" ? "github" : "tedix",
		connectionScope: "tenant",
		personalOwnerUserId: null,
		connectionInstanceId: null,
		providerAccess: null,
		requiredScopes: [],
		resourceType,
		providerResourceId: ref,
		name,
		metadata: {},
		status: "active",
		createdByKind: "user",
		createdById: "u-1",
		createdAt: "2026-10-25T00:00:00.000Z",
		updatedAt: "2026-10-25T00:00:00.000Z",
		removedAt: null,
		availability: null,
	};
}

beforeEach(() => {
	mocks.list.mockReset();
	mocks.remove.mockReset();
});

async function mount() {
	const node = document.createElement("div");
	document.body.appendChild(node);
	const root = createRoot(node);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceRunners workspaceId={WORKSPACE_ID} />
			</QueryClientProvider>,
		),
	);
	await act(async () => new Promise((done) => setTimeout(done, 10)));
	return {
		node,
		close: async () => {
			await act(async () => root.unmount());
			node.remove();
		},
	};
}

describe("tedis and connections in a workspace", () => {
	it("lists the tedis and connections, not skills or connected sources, and unlinks one", async () => {
		mocks.list.mockResolvedValue({
			items: [
				row("r-skill", "skill", "Daily research", "skill-1"),
				row("r-tedi", "tedi", "Research Tedi", "tedi-1"),
				row("r-conn", "connection", "Reddit", "reddit"),
				row("r-repo", "repository", "Product repository", "acme/app"),
			],
			truncated: false,
		});
		mocks.remove.mockResolvedValue({});
		const view = await mount();
		try {
			const rows = [
				...view.node.querySelectorAll("[data-workspace-runner]"),
			].map((el) => el.textContent);
			expect(rows).toEqual([
				expect.stringContaining("Research Tedi"),
				expect.stringContaining("Connection · reddit"),
			]);
			const unlink = view.node.querySelector<HTMLButtonElement>(
				'button[aria-label="Unlink Reddit from this workspace"]',
			);
			await act(async () => unlink!.click());
			expect(mocks.remove).toHaveBeenCalledWith({
				workspaceId: WORKSPACE_ID,
				resourceId: "r-conn",
				expectedUpdatedAt: "2026-10-25T00:00:00.000Z",
			});
		} finally {
			await view.close();
		}
	});

	it("shows nothing when the workspace has none", async () => {
		mocks.list.mockResolvedValue({ items: [], truncated: false });
		const view = await mount();
		try {
			expect(view.node.textContent).toBe("");
		} finally {
			await view.close();
		}
	});
});
