import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { createD1Facade } from "../test/d1-facade";
import { createDbQueryClient } from "../query-client";
import {
	acquireCalendarCoordinatorLease,
	createCalendarCoordinator,
	disableCalendarCoordinator,
	getCalendarCoordinator,
	putCalendarCoordinatorMutation,
	renewCalendarCoordinatorLease,
	updateCalendarCoordinator,
} from "./calendar-coordinator";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		`CREATE TABLE calendar_coordinator_configurations (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,owner_user_id TEXT NOT NULL,revision INTEGER NOT NULL,mode TEXT NOT NULL,configuration TEXT NOT NULL,ownership_seed TEXT NOT NULL,lease_id TEXT,lease_until INTEGER NOT NULL DEFAULT 0,fence INTEGER NOT NULL DEFAULT 0,last_receipt TEXT,last_successful_reconcile_at TEXT,updated_at TEXT NOT NULL);CREATE TABLE calendar_coordinator_mutations(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,configuration_id TEXT NOT NULL,plan_id TEXT NOT NULL,action_id TEXT NOT NULL,state TEXT NOT NULL,mutation TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(configuration_id,action_id));`,
	);
	return createDbQueryClient(createD1Facade(sqlite));
}
const row = {
	id: "config",
	organizationId: "org",
	workspaceId: "workspace",
	ownerUserId: "owner",
	revision: 1,
	mode: "active" as const,
	configuration: "{}",
	ownershipSeed: "seed",
	updatedAt: "now",
};
describe("D1 calendar execution lease", () => {
	it("isolates organizations and admits only one exact configuration revision", async () => {
		const db = fixture();
		await createCalendarCoordinator(db, row);
		const scope = { organizationId: "org", configurationId: "config" };
		expect(
			await getCalendarCoordinator(db, { ...scope, organizationId: "other" }),
		).toBeUndefined();
		expect(
			await acquireCalendarCoordinatorLease(db, scope, 2, "bad", 1000),
		).toBeUndefined();
		const lease = await acquireCalendarCoordinatorLease(
			db,
			scope,
			1,
			"lease",
			1000,
		);
		expect(lease!.fence).toBe(1);
		expect(
			await acquireCalendarCoordinatorLease(db, scope, 1, "other", 1001),
		).toBeUndefined();
		expect(
			await updateCalendarCoordinator(
				db,
				scope,
				1,
				{ mode: "preview", configuration: "{}" },
				1001,
			),
		).toBeUndefined();
	});
	it("revocation invalidates both renewal and ledger writes, including old fence", async () => {
		const db = fixture();
		await createCalendarCoordinator(db, row);
		const scope = { organizationId: "org", configurationId: "config" };
		const lease = await acquireCalendarCoordinatorLease(
			db,
			scope,
			1,
			"lease",
			1000,
		);
		const mutation = {
			id: "m",
			organizationId: "org",
			configurationId: "config",
			planId: "p",
			actionId: "m",
			state: "intent" as const,
			mutation: "{}",
			updatedAt: "now",
		};
		expect(
			await putCalendarCoordinatorMutation(
				db,
				scope,
				"lease",
				lease!.fence,
				mutation,
				1001,
			),
		).toHaveLength(1);
		await disableCalendarCoordinator(db, scope, 1, "{}");
		expect(
			await renewCalendarCoordinatorLease(
				db,
				scope,
				1,
				"lease",
				lease!.fence,
				1002,
			),
		).toBeUndefined();
		expect(
			await putCalendarCoordinatorMutation(
				db,
				scope,
				"lease",
				lease!.fence,
				mutation,
				1002,
			),
		).toHaveLength(0);
	});
	it("expired leases cannot write even when their identifiers still match", async () => {
		const db = fixture();
		await createCalendarCoordinator(db, row);
		const scope = { organizationId: "org", configurationId: "config" };
		const lease = await acquireCalendarCoordinatorLease(
			db,
			scope,
			1,
			"lease",
			1000,
		);
		expect(
			await putCalendarCoordinatorMutation(
				db,
				scope,
				"lease",
				lease!.fence,
				{
					id: "m",
					organizationId: "org",
					configurationId: "config",
					planId: "p",
					actionId: "m",
					state: "intent",
					mutation: "{}",
					updatedAt: "now",
				},
				121001,
			),
		).toHaveLength(0);
	});
});
