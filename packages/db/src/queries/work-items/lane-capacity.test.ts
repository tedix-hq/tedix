import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	evaluateAndRecordWorkAdmission,
	previewWorkAdmission,
	type PreviewWorkAdmissionParams,
} from "./admissions";
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
	function link(child: string, parent: string) {
		sqlite
			.prepare("UPDATE work_items SET parent_work_item_id=? WHERE id=?")
			.run(parent, child);
	}
	function setPolicy(id: string, policy: LaneExecutionPolicy | undefined) {
		sqlite
			.prepare("UPDATE work_items SET metadata=? WHERE id=?")
			.run(JSON.stringify(policy ? { laneExecution: policy } : {}), id);
	}
	function preview(
		id: string,
		change: Partial<PreviewWorkAdmissionParams> = {},
	) {
		return previewWorkAdmission(db, {
			orgId: "org",
			workItemId: id,
			expectedWorkItemVersion: 1,
			expectedAdmissionSpecRevision: "revision",
			executorType: "tedi",
			executorId: "tedi",
			now,
			...change,
		});
	}
	return { sqlite, db, seed, admit, start, link, setPolicy, preview };
}

describe("shared lane admission on migrated D1", () => {
	it.each(["ready", "budget", "resources", "depth"])(
		"previews %s without recording admission, reservations or an Attempt",
		async (mode) => {
			const f = fixture();
			const policy = f.seed("one");
			if (mode === "budget")
				f.sqlite.exec(
					"UPDATE work_budget_envelopes SET limit_micros=10,version=version+1 WHERE id='org-budget'",
				);
			if (mode === "resources")
				f.sqlite.exec(
					"UPDATE work_resource_pools SET capacity=1,version=version+1 WHERE id='executor'",
				);
			if (mode === "budget" || mode === "resources") {
				f.seed("competing");
				expect((await f.admit("competing")).decision).toBe("admitted");
			}
			if (mode === "depth") {
				policy.delegationDepth = 1;
				f.setPolicy("one", policy);
			}
			const tables = [
				"work_admissions",
				"work_resource_reservations",
				"work_budget_reservations",
				"work_attempts",
			];
			const counts = () =>
				tables.map((table) =>
					f.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
				);
			const before = counts();
			const result = await f.preview("one");
			expect(result.rejection?.code).toBe(
				mode === "ready"
					? undefined
					: mode === "depth"
						? "evaluation_required"
						: mode === "budget"
							? "budget_blocked"
							: "resource_blocked",
			);
			expect(counts()).toEqual(before);
			if (mode === "ready") {
				f.sqlite.exec(
					"UPDATE work_budget_envelopes SET limit_micros=10,version=version+1 WHERE id='org-budget'",
				);
				f.seed("competing");
				expect((await f.admit("competing")).decision).toBe("admitted");
				expect((await f.admit("one")).rejectionCode).toBe("budget_blocked");
			}
		},
	);

	it("requires an active exact external principal and session for previews", async () => {
		const f = fixture();
		f.seed("one");
		f.setPolicy("one", undefined);
		f.sqlite
			.exec(`INSERT INTO external_agent_principals(id,organization_id,key,display_name,status,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES('agent','org','agent','Agent','active','owner_user','owner','user','owner');
		INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,status,started_at,last_seen_at) VALUES('session','org','agent','codex:session','codex','fixture','fixture','fixture','fixture','explicit','active','${now}','${now}');`);
		const actor = {
			executorType: "external_agent" as const,
			executorId: "agent",
			executorSessionId: "session",
			externalSessionKey: "codex:session",
		};
		expect((await f.preview("one", actor)).rejection).toBeUndefined();
		await expect(
			f.preview("one", { ...actor, externalSessionKey: "other" }),
		).rejects.toThrow("session fence");
		await expect(
			f.preview("one", { ...actor, executorSessionId: undefined }),
		).rejects.toThrow("exact session key");
		f.sqlite.exec(
			`UPDATE external_agent_sessions SET status='ended',ended_at='${now}' WHERE id='session'`,
		);
		await expect(f.preview("one", actor)).rejects.toThrow("session fence");
		f.sqlite.exec(
			"UPDATE external_agent_principals SET status='suspended' WHERE id='agent'",
		);
		await expect(f.preview("one", actor)).rejects.toThrow("not active");
	});

	it.each([
		"omitted",
		"invalid",
		"reset_depth",
		"raised_depth",
		"raised_attempts",
		"shared_resource",
		"maker_resource",
		"reserved_slots",
		"budget",
	])("rejects a governed child that weakens %s", async (mode) => {
		const f = fixture();
		f.seed("parent", "closure", { budgetEnvelopeIds: ["org-budget"] });
		const child = f.seed("child", "verification", { delegationDepth: 1 });
		f.link("child", "parent");
		if (mode === "reset_depth") child.delegationDepth = 0;
		if (mode === "raised_depth") child.maxDelegationDepth = 3;
		if (mode === "raised_attempts") child.maxAttempts = 4;
		if (mode === "shared_resource") child.sharedResourceKeys = ["replacement"];
		if (mode === "maker_resource") child.makerResourceKey = "replacement";
		if (mode === "reserved_slots") child.reservedSlots = 1;
		if (mode === "budget") child.budgetEnvelopeIds = ["budget-child"];
		f.setPolicy("child", mode === "omitted" ? undefined : child);
		if (mode === "invalid")
			f.sqlite.exec(
				"UPDATE work_items SET metadata='{\"laneExecution\":{}}' WHERE id='child'",
			);
		const result = await f.admit("child");
		expect(result.decision).toBe("rejected");
		expect(result.rejectionCode).toBe("evaluation_required");
		expect(
			f.sqlite
				.prepare("SELECT COUNT(*) AS count FROM work_budget_reservations")
				.get(),
		).toEqual({ count: 0 });
	});

	it("keeps verification eligible under the same case budget and enforces its shared ceiling", async () => {
		const f = fixture();
		f.sqlite
			.exec(`INSERT INTO work_cases(id,org_id,title,kind,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES('case','org','Task','delivery','tedi','tedi','${now}','${now}');
		INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('task-budget','org','case','case',20,10,'USD','${now}');`);
		f.seed("parent", "closure", { budgetEnvelopeIds: ["task-budget"] });
		for (const [id, role] of [
			["implement", "maker"],
			["verify", "verification"],
			["overflow", "verification"],
		] as const) {
			f.seed(id, role, {
				delegationDepth: 1,
				maxAttempts: 2,
				budgetEnvelopeIds: ["task-budget"],
			});
			f.link(id, "parent");
		}
		for (const id of ["parent", "implement", "verify", "overflow"])
			f.sqlite
				.prepare(
					"INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES(?,'org','case',?,?)",
				)
				.run(`case-${id}`, id, now);
		expect((await f.admit("implement")).decision).toBe("admitted");
		expect((await f.admit("verify")).decision).toBe("admitted");
		expect((await f.admit("overflow")).decision).toBe("rejected");
		expect(
			f.sqlite
				.prepare(
					"SELECT SUM(amount_micros) AS reserved FROM work_budget_reservations WHERE envelope_id='task-budget'",
				)
				.get(),
		).toEqual({ reserved: 20 });
	});

	it.each(["missing", "cross_org", "cycle", "over_cap"])(
		"fails closed for %s ancestry even without a leaf policy",
		async (mode) => {
			const f = fixture();
			f.seed("child");
			f.setPolicy("child", undefined);
			if (mode === "missing") f.link("child", "missing");
			if (mode === "cross_org") {
				f.sqlite.exec(
					`INSERT INTO organizations(id,name,slug) VALUES('other','Other','other'); INSERT INTO work_items(id,org_id,title,admission_spec_revision,created_at) VALUES('foreign','other','Foreign','foreign-revision','${now}')`,
				);
				f.link("child", "foreign");
			}
			if (mode === "cycle") {
				f.seed("parent");
				f.setPolicy("parent", undefined);
				f.link("child", "parent");
				f.link("parent", "child");
			}
			if (mode === "over_cap") {
				let child = "child";
				for (let i = 0; i < 11; i++) {
					const parent = `ancestor-${i}`;
					f.seed(parent);
					f.setPolicy(parent, undefined);
					f.link(child, parent);
					child = parent;
				}
			}
			expect((await f.admit("child")).rejectionCode).toBe(
				"evaluation_required",
			);
		},
	);

	it("cannot restart a policy below an ungoverned intermediate Work", async () => {
		const f = fixture();
		f.seed("parent", "closure", { budgetEnvelopeIds: ["org-budget"] });
		f.seed("middle");
		f.setPolicy("middle", undefined);
		f.seed("child");
		f.link("middle", "parent");
		f.link("child", "middle");
		expect((await f.admit("child")).rejectionReason).toContain("retain");
	});

	it("starts a governed delivery at depth zero below an ordinary parent", async () => {
		const f = fixture();
		f.seed("ordinary");
		f.setPolicy("ordinary", undefined);
		f.seed("delivery");
		f.link("delivery", "ordinary");
		expect((await f.admit("delivery")).decision).toBe("admitted");
	});

	it("does not impose lane policy on unrelated shallow Work", async () => {
		const f = fixture();
		for (const id of ["parent", "child"]) {
			f.seed(id);
			f.setPolicy(id, undefined);
		}
		f.link("child", "parent");
		expect((await f.admit("child")).decision).toBe("admitted");
	});

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
