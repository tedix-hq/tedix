import { describe, expect, it } from "vite-plus/test";
import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { buildHomeChildRunTree } from "./child-run-delegated-result";

function homeRun(input: {
	id: string;
	status: HomeRun["status"];
	metadata?: Record<string, unknown>;
	delegatedTediId?: string | null;
	childRunId?: string | null;
}): HomeRun {
	return {
		id: input.id,
		organizationId: "org-1",
		conversationId: "home:test",
		status: input.status,
		delegatedTediId: input.delegatedTediId ?? "tedi-cto",
		childRunId: input.childRunId ?? `tedi-cto:mcp:${input.id}_auto_tedi-cto`,
		runtime: { backend: "cloudflare-agents", metadata: {} },
		startedAt: "2026-11-01T11:35:21.730Z",
		completedAt: null,
		timeoutAt: null,
		createdAt: "2026-11-01T11:31:55.389Z",
		updatedAt: "2026-11-01T11:38:21.846Z",
		progress: { current: 100, total: 100, label: "Failed" },
		metadata: input.metadata ?? {},
	} as unknown as HomeRun;
}

function tree(runs: HomeRun[]) {
	return buildHomeChildRunTree({
		organizationId: "org-1",
		conversationId: "home:test",
		runs,
	});
}

describe("buildHomeChildRunTree", () => {
	// Replay of live rows 6d2934f1 / 63387b00 (2026-11-01): the Home row failed
	// with a dispatch timeout and a `run.failed` event, yet the tree kept
	// showing an active "queued" node because the last child observation
	// (normalized from the dispatch failure's `unknown`) came first.
	it("projects a failed Home row as failed even when its last child status is queued", () => {
		const { nodes, activeNodeId } = tree([
			homeRun({
				id: "6d2934f1",
				status: "failed",
				metadata: { childRunStatus: "queued" },
			}),
		]);
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ status: "failed", active: false });
		expect(activeNodeId).toBeNull();
	});

	it("keeps a live child status while the Home row is still running", () => {
		const { nodes } = tree([
			homeRun({
				id: "live",
				status: "running",
				metadata: { childRunStatus: "streaming" },
			}),
		]);
		expect(nodes[0]).toMatchObject({ status: "streaming", active: true });
	});

	it("lets a terminal child outcome through on a canceled Home row", () => {
		const { nodes } = tree([
			homeRun({
				id: "partial",
				status: "canceled",
				metadata: { childRunStatus: "partial" },
			}),
		]);
		expect(nodes[0]).toMatchObject({ status: "partial", active: false });
	});

	it("settles plan branches once the plan run has settled", () => {
		const { nodes } = tree([
			homeRun({
				id: "plan",
				status: "failed",
				delegatedTediId: null,
				childRunId: null,
				metadata: {
					homePlan: {
						assignments: [
							{
								id: "a-1",
								ownerTediId: "tedi-cto",
								ownerLabel: "CTO",
								status: "queued",
								childRunId: "tedi-cto:mcp:plan_auto_tedi-cto",
							},
							{
								id: "a-2",
								ownerTediId: "tedi-ops",
								ownerLabel: "Ops",
								status: "proposed",
								childRunId: null,
							},
						],
					},
				},
			}),
		]);
		expect(nodes[0]?.children.map((child) => child.status)).toEqual([
			"failed",
			"canceled",
		]);
		expect(nodes[0]?.active).toBe(false);
	});
});
