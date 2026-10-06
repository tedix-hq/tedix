/**
 * A failed FGA query must be distinguishable from "no relations".
 *
 * `queryTediRelations` used to `return []` when the Descope SDK replied
 * `ok: false`. Its only caller, `getDescopeAihDriftReport`, sets its
 * `fgaQueryError` channel exclusively from a `catch` — so an FGA outage
 * produced zero relations, no `fga_relation_audit_unavailable` warning, and
 * therefore zero `fga_relation_missing_d1_app` issues. The audit reported a
 * clean bill of health off a query that never succeeded.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import {
	deleteAppRelation,
	getAppRoleStateForMutation,
	getAppObservers,
	getAppOperators,
	getAssignedAppRoles,
	getOperableApps,
	queryAppRelations,
	queryTediRelations,
} from "./fga";

type Resp = { ok: boolean; data?: unknown; error?: unknown };

function clientReturning(resp: Resp) {
	return {
		management: {
			authz: { targetsRelations: async () => resp },
		},
	} as never;
}

function resourceClientReturning(resp: Resp) {
	return {
		management: {
			authz: { resourceRelations: async () => resp },
		},
	} as never;
}

function checkClientReturning(resp: Resp) {
	return {
		management: {
			fga: { check: async () => resp },
		},
	} as never;
}

describe("app assignment checks", () => {
	it("reads both exact relations before a role mutation", async () => {
		const client = checkClientReturning({
			ok: true,
			data: [
				{
					allowed: true,
					tuple: { resource: "app-1", target: "user-1", relation: "operator" },
				},
				{
					allowed: false,
					tuple: { resource: "app-1", target: "user-1", relation: "observer" },
				},
			],
		});
		await expect(
			getAppRoleStateForMutation(client, "user-1", "app-1"),
		).resolves.toEqual({ operator: true, observer: false });
	});

	it("rejects unavailable or incomplete mutation checks", async () => {
		await expect(
			getAppRoleStateForMutation(
				checkClientReturning({ ok: false }),
				"user-1",
				"app-1",
			),
		).rejects.toThrow("Unable to verify");
		await expect(
			getAppRoleStateForMutation(
				checkClientReturning({
					ok: true,
					data: [
						{
							allowed: true,
							tuple: {
								resource: "app-1",
								target: "user-1",
								relation: "operator",
							},
						},
					],
				}),
				"user-1",
				"app-1",
			),
		).rejects.toThrow("Incomplete app FGA relation check");
	});

	it("denies a failed provider check and logs an operator signal without identities", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const client = checkClientReturning({
				ok: false,
				error: {
					errorCode: "E429",
					errorDescription: "private provider detail",
				},
			});
			await expect(
				getOperableApps(client, "private-user", ["private-app"]),
			).resolves.toEqual([]);
			await expect(
				getAssignedAppRoles(client, "private-user", ["private-app"]),
			).resolves.toEqual({});
			await expect(
				getAppOperators(client, "private-app", ["private-user"]),
			).resolves.toEqual([]);
			await expect(
				getAppObservers(client, "private-app", ["private-user"]),
			).resolves.toEqual([]);
			expect(log).toHaveBeenCalledTimes(4);
			for (const [index, operation] of [
				"getOperableApps",
				"getAssignedAppRoles",
				"getAppOperators",
				"getAppObservers",
			].entries()) {
				expect(log.mock.calls[index]).toEqual([
					"[FGA] App assignment check unavailable",
					{ operation, reason: "provider_failure", providerCode: "E429" },
				]);
			}
			expect(JSON.stringify(log.mock.calls)).not.toMatch(
				/private-user|private-app|private provider detail/,
			);
		} finally {
			log.mockRestore();
		}
	});

	it("distinguishes absent provider data from a valid empty answer", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			await expect(
				getOperableApps(checkClientReturning({ ok: true }), "u", ["a"]),
			).resolves.toEqual([]);
			expect(log).toHaveBeenCalledWith(
				"[FGA] App assignment check unavailable",
				{
					operation: "getOperableApps",
					reason: "missing_data",
					providerCode: null,
				},
			);
			log.mockClear();
			await expect(
				getOperableApps(checkClientReturning({ ok: true, data: [] }), "u", [
					"a",
				]),
			).resolves.toEqual([]);
			expect(log).not.toHaveBeenCalled();
		} finally {
			log.mockRestore();
		}
	});
});

describe("queryTediRelations", () => {
	it("throws when the query fails instead of reporting no relations", async () => {
		await expect(
			queryTediRelations(clientReturning({ ok: false }), ["u1"]),
		).rejects.toThrow(/FGA targetsRelations query failed/);
	});

	it("surfaces the provider's reason so the audit can report it", async () => {
		await expect(
			queryTediRelations(
				clientReturning({
					ok: false,
					error: { errorDescription: "rate limited" },
				}),
				["u1"],
			),
		).rejects.toThrow(/rate limited/);
	});

	it("throws when the call succeeds but carries no data", async () => {
		// `ok: true` with absent data is still an answer we cannot audit from.
		await expect(
			queryTediRelations(clientReturning({ ok: true }), ["u1"]),
		).rejects.toThrow(/FGA targetsRelations query failed/);
	});

	it("returns relations on success", async () => {
		const relations = [
			{
				target: "u1",
				relationDefinition: "operator",
				namespace: "app",
				resource: "app-1",
			},
		];
		await expect(
			queryTediRelations(clientReturning({ ok: true, data: relations }), [
				"u1",
			]),
		).resolves.toEqual(relations);
	});

	it("still short-circuits an empty target list without calling the provider", async () => {
		// A genuinely empty question has a genuinely empty answer — that is not
		// the same as a failed query, and must not throw.
		let called = false;
		const client = {
			management: {
				authz: {
					targetsRelations: async () => {
						called = true;
						return { ok: true, data: [] };
					},
				},
			},
		} as never;
		await expect(queryTediRelations(client, [])).resolves.toEqual([]);
		expect(called).toBe(false);
	});
});

/**
 * The resource-side read carries the same property for the same reason: it is
 * the query behind "who can operate this app?", and `[]` from a failed call
 * asserts "nobody" — the strongest possible answer — off no evidence.
 */
describe("queryAppRelations", () => {
	it("throws when the query fails instead of reporting no relations", async () => {
		await expect(
			queryAppRelations(resourceClientReturning({ ok: false }), "app-1"),
		).rejects.toThrow(/FGA resourceRelations query failed/);
	});

	it("surfaces the provider's reason", async () => {
		await expect(
			queryAppRelations(
				resourceClientReturning({
					ok: false,
					error: { errorDescription: "rate limited" },
				}),
				"app-1",
			),
		).rejects.toThrow(/rate limited/);
	});

	it("throws when the call succeeds but carries no data", async () => {
		await expect(
			queryAppRelations(resourceClientReturning({ ok: true }), "app-1"),
		).rejects.toThrow(/FGA resourceRelations query failed/);
	});

	it("returns an empty list only when the provider genuinely reported none", async () => {
		await expect(
			queryAppRelations(
				resourceClientReturning({ ok: true, data: [] }),
				"app-1",
			),
		).resolves.toEqual([]);
	});

	it("returns relations on success", async () => {
		const relations = [
			{
				target: "u1",
				relationDefinition: "operator",
				namespace: "app",
				resource: "app-1",
			},
		];
		await expect(
			queryAppRelations(
				resourceClientReturning({ ok: true, data: relations }),
				"app-1",
			),
		).resolves.toEqual(relations);
	});
});

describe("deleteAppRelation", () => {
	it("deletes only the exact relation requested", async () => {
		let received: unknown;
		const client = {
			management: {
				fga: {
					deleteRelations: async (relations: unknown) => {
						received = relations;
						return { ok: true };
					},
				},
			},
		} as never;

		await deleteAppRelation(client, "user-1", "app-1", "operator");
		expect(received).toEqual([
			{
				resource: "app-1",
				resourceType: "app",
				relation: "operator",
				target: "user-1",
				targetType: "user",
			},
		]);
	});

	it("fails loudly when Descope rejects the deletion", async () => {
		const client = {
			management: {
				fga: {
					deleteRelations: async () => ({
						ok: false,
						error: { errorDescription: "denied" },
					}),
				},
			},
		} as never;

		await expect(
			deleteAppRelation(client, "user-1", "app-1", "observer"),
		).rejects.toThrow(/Failed to delete app relation/);
	});
});
