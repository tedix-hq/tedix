import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OsWorkspace } from "@tedix/api-contract/schemas/os-workspaces";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const api = vi.hoisted(() => ({
	collaborators: { list: vi.fn() },
	outputs: { list: vi.fn() },
	workspaces: { activity: vi.fn() },
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		osCollaborators: api.collaborators,
		osWorkspaces: { outputs: api.outputs, workspaces: api.workspaces },
	},
}));

import { absoluteTime } from "@/lib/time";
import { WorkspaceInfoDialog } from "./workspace-info-dialog";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function workspace(overrides: Partial<OsWorkspace> = {}): OsWorkspace {
	return {
		id: WORKSPACE_ID,
		organizationId: "org-1",
		name: "Revenue Ops",
		description: "Weekly revenue reporting",
		status: "active",
		sourceBlueprintId: null,
		sourceBlueprintRevisionId: null,
		sourceBlueprintRevisionNumber: null,
		instantiationPreflight: null,
		rollbackReference: null,
		blueprintDecision: null,
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-01T10:00:00.000Z",
		updatedAt: "2026-08-12T10:00:00.000Z",
		visibility: "org",
		ownerUserId: null,
		summary: {
			revision: 4,
			usage: { conversationCount: 3, messageCount: 20, runCount: 10 },
			runStatus: { activeRunCount: 0, latestRun: null },
			workLinks: [],
			publishedAt: "2026-08-12T10:00:00.000Z",
			appliedAt: "2026-08-12T10:00:01.000Z",
		},
		...overrides,
	};
}

async function renderDialog(current: OsWorkspace) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onOpenChange = vi.fn();
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceInfoDialog workspace={current} onOpenChange={onOpenChange} />
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
	return { root, onOpenChange };
}

/** The value shown next to a label in the dialog. */
function fact(label: string): string | undefined {
	const term = [...document.querySelectorAll("dt")].find(
		(node) => node.textContent === label,
	);
	return term?.nextElementSibling?.textContent ?? undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	api.collaborators.list.mockResolvedValue({
		role: "owner",
		isOwner: true,
		ownerName: "Ada Lovelace",
		collaborators: [],
		links: [],
	});
	api.outputs.list.mockResolvedValue({
		items: [{ id: "one" }, { id: "two" }],
		truncated: false,
	});
	api.workspaces.activity.mockResolvedValue({
		items: [{ id: "change-1", occurredAt: "2026-08-15T09:30:00.000Z" }],
		coverage: "recorded_only",
		next: null,
	});
});

afterEach(() => {
	document.body.replaceChildren();
});

describe("WorkspaceInfoDialog", () => {
	it("shows who owns a workspace, its dates and what is in it", async () => {
		const { root } = await renderDialog(workspace());
		expect(document.body.textContent).toContain("About Revenue Ops");
		expect(document.body.textContent).toContain("Weekly revenue reporting");
		expect(fact("Owner")).toBe("Ada Lovelace");
		expect(fact("Who can see it")).toBe("Everyone in the organization");
		expect(fact("Created")).toBe(absoluteTime("2026-08-01T10:00:00.000Z"));
		expect(fact("Files")).toBe("2 files");
		expect(fact("Conversations")).toBe("3 conversations");
		// The newest recorded change, not the workspace's own last edit.
		expect(
			document.querySelector(
				`[title="${absoluteTime("2026-08-15T09:30:00.000Z")}"]`,
			),
		).not.toBeNull();
		expect(api.workspaces.activity.mock.calls[0]?.[0]).toEqual({
			workspaceId: WORKSPACE_ID,
			limit: 1,
		});
		expect(api.outputs.list.mock.calls[0]?.[0]).toMatchObject({
			workspaceId: WORKSPACE_ID,
		});
		// Model cost is not offered here: no reading of it exists outside an
		// open workspace chat.
		expect(document.body.textContent).not.toMatch(/cost|\$/i);
		act(() => root.unmount());
	});

	it("falls back to the workspace's last edit when no change is recorded", async () => {
		api.workspaces.activity.mockResolvedValue({
			items: [],
			coverage: "recorded_only",
			next: null,
		});
		const { root } = await renderDialog(workspace());
		expect(
			document.querySelector(
				`[title="${absoluteTime("2026-08-12T10:00:00.000Z")}"]`,
			),
		).not.toBeNull();
		act(() => root.unmount());
	});

	it("says so instead of guessing when a number is not known", async () => {
		api.collaborators.list.mockRejectedValue(new Error("unavailable"));
		api.outputs.list.mockResolvedValue({
			items: Array.from({ length: 100 }, (_, index) => ({ id: `${index}` })),
			truncated: true,
		});
		const { root } = await renderDialog(
			workspace({ visibility: "private", summary: null, description: null }),
		);
		expect(fact("Owner")).toBe("Not available");
		expect(fact("Who can see it")).toBe(
			"Only the owner and people it is shared with",
		);
		expect(fact("Files")).toBe("More than 100 files");
		expect(fact("Conversations")).toBe("Not counted yet");
		act(() => root.unmount());
	});

	it("counts one of each in the singular and closes", async () => {
		api.outputs.list.mockResolvedValue({
			items: [{ id: "one" }],
			truncated: false,
		});
		const current = workspace();
		current.summary!.usage.conversationCount = 1;
		const { root, onOpenChange } = await renderDialog(current);
		expect(fact("Files")).toBe("1 file");
		expect(fact("Conversations")).toBe("1 conversation");
		const close = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Close",
		);
		act(() => close!.click());
		expect(onOpenChange).toHaveBeenCalledWith(false);
		act(() => root.unmount());
	});
});
