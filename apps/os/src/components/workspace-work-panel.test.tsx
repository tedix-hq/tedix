import type { WorkItem } from "@tedix/api-contract/schemas/work-items";
import type { Project } from "@tedix/api-contract/contracts/projects";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WorkspaceWorkPanel } from "./workspace-work-panel";
import {
	projectListQueryOptions,
	projectSprintsQueryOptions,
	projectMilestonesQueryOptions,
	projectActiveAttemptsQueryOptions,
	workGraphItemsQueryOptions,
	workspaceWorkProjectsQueryOptions,
} from "@/lib/os-query-options";

const baseItem: WorkItem = {
	id: "item",
	orgId: "22222222-2222-4222-8222-222222222222",
	title: "Verify the customer export",
	description: null,
	disposition: "accepted",
	workKind: "operations",
	riskLevel: "high",
	acceptanceContract: {
		version: 1,
		doneLooksLike: "Final provider state is verified",
	},
	requiredCapabilities: [],
	requiredAuthorities: [],
	priority: "high",
	objectiveId: null,
	workClass: "objective",
	purposeExceptionExpiresAt: null,
	projectId: null,
	parentWorkItemId: null,
	sourceSessionKey: null,
	sourceIntentId: null,
	accountableOwnerType: "user",
	accountableOwnerId: "owner-1",
	stewardType: "tedi",
	stewardId: "operator-1",
	reviewerType: "user",
	reviewerId: "reviewer-1",
	reviewerLeaseExpiresAt: "2026-08-21T00:00:00.000Z",
	dueDate: null,
	deadline: null,
	startAt: null,
	durationDays: null,
	provenance: {},
	metadata: {},
	admissionSpecRevision: "fixture-revision-1",
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: null,
	acceptedAt: "2026-08-20T00:01:00.000Z",
	completedAt: null,
	cancelledAt: null,
	version: 1,
};
const baseProject: Project = {
	id: "33333333-3333-4333-8333-333333333333",
	orgId: "22222222-2222-4222-8222-222222222222",
	key: "QUIET-OS",
	name: "Quiet command center",
	description: null,
	status: "active",
	leadTediId: null,
	ownerUserId: "owner-1",
	objectiveId: null,
	targetDate: "2026-09-01",
	metadata: null,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: null,
	archivedAt: null,
};
const linkFields = {
	organizationId: "org",
	workspaceId: "workspace",
	status: "active" as const,
	createdByKind: "user" as const,
	createdById: "owner",
	createdAt: "2026-09-21T00:00:00Z",
	updatedAt: "2026-09-21T00:00:00Z",
	removedAt: null,
};
const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});
async function renderPanel(terminal = false) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false } },
	});
	queryClient.setQueryData(
		workspaceWorkProjectsQueryOptions("workspace").queryKey,
		{
			truncated: false,
			items: [
				{ ...linkFields, id: "link-a", projectId: "finance" },
				{ ...linkFields, id: "link-b", projectId: "operations" },
			],
		},
	);
	queryClient.setQueryData(projectListQueryOptions(100).queryKey, {
		data: [
			{ ...baseProject, id: "finance", name: "Finance", key: "FIN" },
			{ ...baseProject, id: "operations", name: "Operations", key: "OPS" },
			{ ...baseProject, id: "unlinked", name: "Other project", key: "OTHER" },
		],
		pagination: { total: 3, limit: 100, offset: 0, hasMore: false },
	});
	for (const id of ["finance", "operations"]) {
		queryClient.setQueryData(
			workGraphItemsQueryOptions({ projectId: id }, 100).queryKey,
			{
				data: [
					{
						...baseItem,
						id: `${id}-item`,
						title: `${id} task`,
						projectId: id,
						disposition: terminal ? "completed" : "proposed",
						priority: "high",
						startAt: null,
						durationDays: null,
						version: 1,
					},
				],
				pagination: { total: 1, limit: 100, offset: 0, hasMore: false },
			},
		);
		queryClient.setQueryData(projectSprintsQueryOptions(id).queryKey, {
			data: [],
		});
		queryClient.setQueryData(projectMilestonesQueryOptions(id).queryKey, {
			data: [],
			nextCursor: null,
		});
		queryClient.setQueryData(projectActiveAttemptsQueryOptions(id).queryKey, {
			data: [],
			nextCursor: null,
			hasMore: false,
		});
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	cleanups.push(() => {
		act(() => root.unmount());
		host.remove();
		queryClient.clear();
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<WorkspaceWorkPanel workspaceId="workspace" />
			</QueryClientProvider>,
		),
	);
	return host;
}
const button = (text: string) =>
	Array.from(document.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	)!;

describe("Workspace work", () => {
	it("combines linked projects and keeps project setup out of the default work surface", async () => {
		const host = await renderPanel();
		expect(host.textContent).toContain("finance task");
		expect(host.textContent).toContain("operations task");
		expect(host.querySelectorAll('[aria-label="Proposed"] li')).toHaveLength(2);
		expect(host.textContent).not.toContain("Other project");
		await act(async () => button("Manage projects").click());
		expect(
			document.querySelector('[aria-label="Search projects"]'),
		).not.toBeNull();
		expect(
			document.querySelector('[aria-label="Link Other project"]'),
		).not.toBeNull();
		expect(
			document.querySelector('[aria-label="Remove Finance"]'),
		).not.toBeNull();
	});

	it("switches between board and timeline without hiding unscheduled work", async () => {
		const host = await renderPanel();
		await act(async () => button("Board").click());
		expect(button("Show empty groups")).toBeTruthy();
		expect(host.querySelector('[aria-label="Accepted"]')).toBeNull();
		await act(async () => button("Show empty groups").click());
		expect(host.querySelector('[aria-label="Accepted"]')).not.toBeNull();
		await act(async () => button("Timeline").click());
		expect(
			host.querySelectorAll('[aria-label="Unscheduled work"] li'),
		).toHaveLength(2);
		expect(
			host.querySelector('[aria-label="Schedule finance task"]'),
		).not.toBeNull();
	});

	it("keeps terminal work dates read-only across views", async () => {
		const host = await renderPanel(true);
		expect(
			host.querySelector('[aria-label="Schedule finance task"]'),
		).toBeNull();
		await act(async () => button("Board").click());
		expect(
			host.querySelector('[aria-label="Schedule finance task"]'),
		).toBeNull();
		await act(async () => button("Timeline").click());
		expect(
			host.querySelector('[aria-label="Schedule finance task"]'),
		).toBeNull();
	});

	it("offers a date editor directly from unscheduled work", async () => {
		await renderPanel();
		const schedule = document.querySelector<HTMLButtonElement>(
			'[aria-label="Schedule finance task"]',
		)!;
		await act(async () => schedule.click());
		expect(document.querySelector('input[type="date"]')).not.toBeNull();
		expect(
			document.querySelector('input[type="number"]')?.getAttribute("min"),
		).toBe("1");
		expect(button("Save dates")).toBeTruthy();
	});
});
