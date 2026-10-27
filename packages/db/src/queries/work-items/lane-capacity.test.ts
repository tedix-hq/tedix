import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { evaluateAndRecordWorkAdmission } from "./admissions";
import {
	startWorkItemAttempt,
	settleWorkItemAttempt,
	sweepElapsedWorkAttempts,
} from "./attempts";
import type { LaneExecutionPolicy } from "@tedix/api-contract/schemas/lane-execution";

const now = "2026-08-20T01:00:00.000Z";
// Build the full migrated template before timing admission, then clone it per test.
createMigratedSqlite().close();
function fixture() {
	const sqlite = createMigratedSqlite();
	sqlite.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Example','example');
		INSERT INTO tedis(id,organization_id,name,slug) VALUES('tedi','org','Executor','executor');
		INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES
		('shared','org','lanes','capacity',20,'${now}'),
		('makers','org','makers','capacity',18,'${now}'),
		('executor','org','executor','capacity',20,'${now}');
		INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('org-budget','org','organization','org',200,10,'USD','${now}');
	`);
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	const insertWork =
		sqlite.prepare(`INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,metadata,created_at)
		VALUES(?,'org',?,'accepted','hygiene','2026-09-01T00:00:00.000Z','revision',?,'2026-08-20T00:00:00.000Z')`);
	const insertRequirement = sqlite.prepare(
		`INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org',?,?,1,?,?)`,
	);
	const insertBudget = sqlite.prepare(
		`INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES(?,'org','work_item',?,100,10,'USD',?)`,
	);
	function seed(
		id: string,
		role: LaneExecutionPolicy["role"] = "maker",
		change: Partial<LaneExecutionPolicy> = {},
	) {
		const policy: LaneExecutionPolicy = {
			version: 1,
			role,
			sharedResourceKeys: ["lanes"],
			makerResourceKey: "makers",
			reservedSlots: 2,
			budgetEnvelopeIds: ["org-budget", `budget-${id}`],
			maxAttempts: 3,
			maxDelegationDepth: 2,
			delegationDepth: 0,
			executors: [
				{
					id: "worker",
					kind: "tedi",
					principalType: "tedi",
					principalId: "tedi",
					resourceKey: "executor",
					costMicros: 10,
					capabilities: [],
				},
			],
			...change,
		};
		insertWork.run(id, id, JSON.stringify({ laneExecution: policy }));
		for (const resource of [
			"lanes",
			"executor",
			...(role === "maker" ? ["makers"] : []),
		])
			insertRequirement.run(id, resource, now, now);
		insertBudget.run(`budget-${id}`, id, now);
		return policy;
	}
	async function admit(id: string, suffix = "") {
		return evaluateAndRecordWorkAdmission(db, {
			id: `admit-${id}${suffix}`,
			orgId: "org",
			workItemId: id,
			expectedWorkItemVersion: 1,
			expectedAdmissionSpecRevision: "revision",
			executorType: "tedi",
			executorId: "tedi",
			leaseTtlMs: 60_000,
			now,
		});
	}
	async function start(id: string) {
		const admission = await admit(id);
		return startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: id,
			admissionId: admission.id,
			executor: { type: "tedi", id: "tedi" },
			expiresAt: admission.expiresAt,
			startedAt: now,
		});
	}
	return { sqlite, db, seed, admit, start };
}

describe("shared lane admission on migrated D1", () => {
	it("admits only 18 racing makers while preserving verification and closure slots", async () => {
		const f = fixture();
		const makers = Array.from({ length: 19 }, (_, index) => `maker-${index}`);
		makers.forEach((id) => f.seed(id));
		const results = await Promise.allSettled(makers.map((id) => f.admit(id)));
		expect(
			results.filter(
				(r) => r.status === "fulfilled" && r.value.decision === "admitted",
			),
		).toHaveLength(18);
		expect(
			f.sqlite
				.prepare(
					"SELECT SUM(quantity) AS count FROM work_resource_reservations WHERE pool_id='makers' AND state='active'",
				)
				.get(),
		).toEqual({ count: 18 });
		expect(
			f.sqlite
				.prepare(
					"SELECT SUM(amount_micros) AS reserved FROM work_budget_reservations WHERE envelope_id='org-budget' AND state='active'",
				)
				.get(),
		).toEqual({ reserved: 180 });
		f.seed("verify", "verification");
		f.seed("close", "closure");
		expect((await f.admit("verify")).decision).toBe("admitted");
		expect((await f.admit("close")).decision).toBe("admitted");
		f.seed("overflow", "closure");
		expect((await f.admit("overflow")).decision).toBe("rejected");
		expect(
			f.sqlite
				.prepare(
					"SELECT SUM(quantity) AS count FROM work_resource_reservations WHERE pool_id='shared' AND state='active'",
				)
				.get(),
		).toEqual({ count: 20 });
	});

	it.each(["failed", "cancelled", "succeeded"] as const)(
		"releases only the %s Attempt's slots and preserves terminal replay",
		async (outcome) => {
			const f = fixture();
			f.seed("one");
			f.seed("other");
			const one = await f.start("one");
			await f.start("other");
			const settle = () =>
				settleWorkItemAttempt(f.db, {
					orgId: "org",
					workItemId: "one",
					attemptId: one.attempt.id,
					executor: { type: "tedi", id: "tedi" },
					outcome,
					costMicros: 4,
					settledAt: "2026-08-20T01:00:10.000Z",
				});
			await settle();
			const read = () =>
				f.sqlite
					.prepare(
						"SELECT admission_id,state,quantity,version FROM work_resource_reservations ORDER BY id",
					)
					.all();
			const before = read();
			await settle().catch(() => undefined);
			expect(read()).toEqual(before);
			expect(
				f.sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM work_resource_reservations WHERE admission_id=? AND state='active'",
					)
					.get(one.attempt.admissionId),
			).toEqual({ count: 0 });
			expect(
				f.sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM work_resource_reservations WHERE work_item_id='other' AND state='active'",
					)
					.get(),
			).toEqual({ count: 3 });
			expect(
				f.sqlite
					.prepare(
						"SELECT state,consumed_micros FROM work_budget_reservations WHERE work_item_id='one'",
					)
					.get(),
			).toEqual({ state: "consumed", consumed_micros: 4 });
		},
	);

	it("expiry releases the original reservation exactly once", async () => {
		const f = fixture();
		f.seed("one");
		await f.start("one");
		await sweepElapsedWorkAttempts(f.db, { now: "2026-08-20T01:02:00.000Z" });
		const read = () =>
			f.sqlite
				.prepare(
					"SELECT state,version FROM work_resource_reservations ORDER BY id",
				)
				.all();
		const before = read();
		expect(before).toHaveLength(3);
		expect(before.every((r) => r.state === "expired")).toBe(true);
		await sweepElapsedWorkAttempts(f.db, { now: "2026-08-20T01:03:00.000Z" });
		expect(read()).toEqual(before);
	});

	it.each([
		"missing_resource",
		"unknown_price",
		"missing_budget",
		"depth",
		"retries",
	])("fails closed for %s", async (mode) => {
		const f = fixture();
		const policy = f.seed("one");
		if (mode === "missing_resource")
			f.sqlite.exec(
				"DELETE FROM work_resource_requirements WHERE resource_key='makers'",
			);
		if (mode === "unknown_price") policy.executors[0]!.costMicros = null;
		if (mode === "missing_budget")
			policy.budgetEnvelopeIds = ["unavailable-budget"];
		if (mode === "depth") policy.delegationDepth = 3;
		if (mode === "retries") {
			const first = await f.start("one");
			await settleWorkItemAttempt(f.db, {
				orgId: "org",
				workItemId: "one",
				attemptId: first.attempt.id,
				executor: { type: "tedi", id: "tedi" },
				outcome: "failed",
				settledAt: "2026-08-20T01:00:10.000Z",
			});
			policy.maxAttempts = 1;
		}
		f.sqlite
			.prepare("UPDATE work_items SET metadata=? WHERE id='one'")
			.run(JSON.stringify({ laneExecution: policy }));
		expect((await f.admit("one", "-retry")).decision).toBe("rejected");
		expect(
			f.sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_resource_reservations WHERE state='active'",
				)
				.get(),
		).toEqual({ count: 0 });
	});
});
