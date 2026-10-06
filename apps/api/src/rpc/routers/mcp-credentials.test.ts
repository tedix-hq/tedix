import { describe, expect, it } from "vite-plus/test";
import {
	delegatedMcpScopes,
	matchesPersistedHomeDelegation,
} from "./mcp-credentials";

const tuple = { tediId: "tedi-cto", runId: "child-run", workItemId: "work-1" };

describe("delegated MCP credential issuer fence", () => {
	it("retains only Work read from an admin tedi profile", () => {
		const scopes = delegatedMcpScopes("org_admin");
		expect(scopes).toContain("mcp:work.read");
		expect(scopes).not.toContain("mcp:work.write");
		expect(scopes).not.toContain("mcp:work.admin");
		expect(scopes).not.toContain("platform:admin");
	});
	it("retains explicit platform authority only from the existing platform admin profile", () => {
		const scopes = delegatedMcpScopes("platform_admin");
		expect(scopes).toContain("platform:admin");
		expect(scopes).toContain("mcp:work.read");
		expect(scopes).not.toContain("mcp:work.write");
		expect(scopes).not.toContain("mcp:work.admin");
		expect(scopes).not.toContain("*");
		expect(scopes).not.toContain("mcp:*");
	});

	it.each(["standard", "org_admin", undefined, null, "unrecognized"])(
		"does not grant platform authority to profile %s",
		(profile) => {
			expect(delegatedMcpScopes(profile)).not.toContain("platform:admin");
		},
	);
	it("accepts an active direct Home dispatch only for its exact child and Work Item", () => {
		const row = {
			status: "running",
			delegatedTediId: tuple.tediId,
			childRunId: tuple.runId,
			metadata: { workItemId: tuple.workItemId },
		};
		expect(matchesPersistedHomeDelegation(row, tuple)).toBe(true);
		expect(
			matchesPersistedHomeDelegation(row, { ...tuple, workItemId: "other" }),
		).toBe(false);
		expect(
			matchesPersistedHomeDelegation({ ...row, status: "completed" }, tuple),
		).toBe(false);
	});

	it("accepts a planned assignment without requiring the child to own the Work Attempt", () => {
		const row = {
			status: "waiting",
			delegatedTediId: null,
			childRunId: null,
			metadata: {
				homePlan: {
					assignments: [
						{
							ownerTediId: tuple.tediId,
							childRunId: tuple.runId,
							workItemId: tuple.workItemId,
							status: "queued",
							dispatchedAt: "2026-09-23T12:00:00.000Z",
						},
					],
				},
			},
		};
		expect(matchesPersistedHomeDelegation(row, tuple)).toBe(true);
		const assignment = row.metadata.homePlan.assignments[0];
		const withCanceledSibling = {
			...row,
			metadata: {
				homePlan: {
					assignments: [
						assignment,
						{
							...assignment,
							childRunId: "canceled-child",
							workItemId: "canceled-work",
							status: "canceled",
						},
					],
				},
			},
		};
		expect(matchesPersistedHomeDelegation(withCanceledSibling, tuple)).toBe(
			true,
		);
		expect(
			matchesPersistedHomeDelegation(withCanceledSibling, {
				...tuple,
				runId: "canceled-child",
				workItemId: "canceled-work",
			}),
		).toBe(false);
		for (const status of [
			"proposed",
			"approved",
			"failed",
			"canceled",
			"completed",
		]) {
			expect(
				matchesPersistedHomeDelegation(
					{
						...row,
						metadata: {
							homePlan: { assignments: [{ ...assignment, status }] },
						},
					},
					tuple,
				),
			).toBe(false);
		}
		expect(
			matchesPersistedHomeDelegation(
				{
					...row,
					metadata: {
						homePlan: { assignments: [{ ...assignment, dispatchedAt: null }] },
					},
				},
				tuple,
			),
		).toBe(false);
		expect(
			matchesPersistedHomeDelegation(row, { ...tuple, tediId: "other" }),
		).toBe(false);
		expect(
			matchesPersistedHomeDelegation(
				{ ...row, metadata: { homePlan: { assignments: [] } } },
				tuple,
			),
		).toBe(false);
	});
});
