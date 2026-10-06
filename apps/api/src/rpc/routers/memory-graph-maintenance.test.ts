import type { GraphProjectionMaintenanceRun } from "@tedix/db/schema/graph-projection";
import { describe, expect, it } from "vite-plus/test";
import {
	graphGdsTaskFromRun,
	graphGdsTaskId,
	requireGraphMaintenanceAuthority,
	validateGraphGdsMaintenanceRequest,
} from "./memory-graph/policy-operations";

function completedRun(
	result: GraphProjectionMaintenanceRun["result"],
): GraphProjectionMaintenanceRun {
	return {
		id: "graph-gds-1",
		runtimeEnvironment: "production",
		organizationId: "org-1",
		operation: "gds_refresh",
		idempotencyKey: "stable-key",
		requestFingerprint: "gds_refresh:v1",
		workflowId: "graph-gds-1",
		status: "completed",
		result,
		error: null,
		cancelReason: null,
		cancelRequestedAt: null,
		createdAt: "2026-07-28T00:00:00.000Z",
		startedAt: "2026-07-28T00:00:01.000Z",
		completedAt: "2026-07-28T00:01:00.000Z",
		updatedAt: "2026-07-28T00:01:00.000Z",
	};
}

describe("graph GDS maintenance task invariants", () => {
	it("requires reindex to be isolated and caller-idempotent", () => {
		expect(() =>
			validateGraphGdsMaintenanceRequest({
				operations: ["reindex", "stats"],
				idempotencyKey: "key-1",
			}),
		).toThrow("reindex must be requested alone");
		expect(() =>
			validateGraphGdsMaintenanceRequest({ operations: ["reindex"] }),
		).toThrow("caller-stable idempotencyKey");
		expect(() =>
			validateGraphGdsMaintenanceRequest({
				operations: ["reindex"],
				idempotencyKey: "key-1",
			}),
		).not.toThrow();
		expect(() =>
			validateGraphGdsMaintenanceRequest({ operations: ["stats"] }),
		).not.toThrow();
	});

	it("separates deterministic task ids by environment and organization", async () => {
		const production = await graphGdsTaskId(
			"production",
			"org-1",
			"stable-key",
		);
		await expect(
			graphGdsTaskId("production", "org-1", "stable-key"),
		).resolves.toBe(production);
		await expect(
			graphGdsTaskId("staging", "org-1", "stable-key"),
		).resolves.not.toBe(production);
		await expect(
			graphGdsTaskId("production", "org-2", "stable-key"),
		).resolves.not.toBe(production);
	});

	it("fails closed when a completed row lacks the atomic receipt", () => {
		expect(
			graphGdsTaskFromRun(
				completedRun({
					operation: "gds_refresh",
					organizationId: "org-1",
				}),
			),
		).toMatchObject({
			status: "failed",
			result: null,
			error: "GDS refresh completed without a valid atomic receipt",
		});
		expect(
			graphGdsTaskFromRun(
				completedRun({
					operation: "gds_refresh",
					organizationId: "org-2",
					watermark: 42,
					epoch: "epoch-1",
				}),
			),
		).toMatchObject({
			status: "failed",
			result: null,
			error: "GDS refresh completed without a valid atomic receipt",
		});
	});

	it("admits only replayable owner, API-key, or scoped tedi authority", () => {
		expect(() =>
			requireGraphMaintenanceAuthority({
				authType: "service-binding",
			} as never),
		).toThrow("owner/admin or mcp:memory.admin");
		expect(() =>
			requireGraphMaintenanceAuthority({
				authType: "tedi",
				tediId: "tedi-1",
				tediScopes: ["mcp:memory.admin"],
			} as never),
		).not.toThrow();
		expect(() =>
			requireGraphMaintenanceAuthority({
				authType: "apikey",
				apiKey: { scopes: ["mcp:memory.admin"] },
			} as never),
		).not.toThrow();
		expect(() =>
			requireGraphMaintenanceAuthority({
				authType: "service-binding",
				externalAgentPrincipalId: "agent-1",
			} as never),
		).toThrow("External agents");
	});
});
