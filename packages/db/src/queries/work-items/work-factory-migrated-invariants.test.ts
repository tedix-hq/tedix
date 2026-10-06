import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
	WorkBudgetEnvelopeSchema,
	WorkResourcePoolSchema,
} from "@tedix/api-contract/schemas/work-items";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import {
	evaluateAndRecordWorkAdmission,
	replaceWorkAdmissionSpecification,
	WORK_ADMISSION_BUDGET_ENVELOPE_CAP,
	WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP,
} from "./admissions";
import {
	evaluateWorkAdmissionApprovals,
	requiredWorkAdmissionAuthorities,
	WORK_ADMISSION_APPROVAL_ACTION,
} from "./admission-approval-policy";
import { proposeWorkApproval } from "./approvals";
import {
	heartbeatWorkItemAttempt,
	startWorkItemAttempt,
	sweepElapsedWorkAttempts,
} from "./attempts";
import {
	createWorkBudgetEnvelope,
	listWorkBudgetEnvelopes,
	updateWorkBudgetEnvelope,
} from "./budgets";
import { boundSchedulerFactChunks, listReadyWork } from "./scheduler";
import { listWorkMilestoneViews, updateWorkMilestone } from "./milestones";

const migrationRoot = new URL("../../../drizzle/", import.meta.url);
const migrations = readdirSync(migrationRoot)
	.sort()
	.map((name) => ({
		name,
		sql: readFileSync(new URL(`${name}/migration.sql`, migrationRoot), "utf8"),
	}));
const factoryStart = migrations.findIndex((row) =>
	row.name.startsWith("20260821015311_"),
);
function migrated(stop = migrations.length) {
	const db = new DatabaseSync(":memory:");
	db.exec("PRAGMA foreign_keys=ON");
	for (const row of migrations.slice(0, stop)) db.exec(row.sql);
	return db;
}
function expectAbort(run: () => unknown, pattern: RegExp) {
	expect(run).toThrow(pattern);
}
/**
 * A live, bounded operational purpose exception for fixture work items.
 * Undeclared purpose (`work_class IS NULL`) is not schedulable or admissible,
 * so every fixture row that must reach the candidate set or authoritative
 * admission carries a real purpose. These fixtures exercise scheduler and
 * admission mechanics rather than objective delivery, so an operational
 * `hygiene` class with a live exception is the honest declaration. Chosen to
 * outlive every `now` used in this file while staying inside the 30-day
 * exception ceiling measured from the fixture `created_at` (2026-08-20).
 */
const LIVE_PURPOSE_EXCEPTION = "2026-09-01T00:00:00.000Z";

function seedCore(db: DatabaseSync) {
	db.exec(`
		INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
		INSERT INTO users(id,email) VALUES('user','user@example.com');
		INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES('member','org','user','user','user@example.com','active');
		INSERT INTO projects(id,org_id,key,name,created_at) VALUES('project','org','project','Project','2026-08-20T00:00:00.000Z');
		INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work','org','Work','completed','hygiene','${LIVE_PURPOSE_EXCEPTION}','revision-1','2026-08-20T00:00:00.000Z');
	`);
}
function seedTedi(db: DatabaseSync) {
	db.exec(
		"INSERT INTO tedis(id,organization_id,name,slug) VALUES('tedi','org','Tedi','tedi')",
	);
}
function admitWithCapacity(
	db: DatabaseSync,
	{
		work = "work",
		admission = "admission",
		pool = "pool",
		envelope = "envelope",
	} = {},
) {
	db.exec(
		`UPDATE work_items SET disposition='accepted' WHERE id='${work}'; INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('${pool}','org','browser','exclusive',1,'2026-08-20T00:00:00.000Z'); INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','${work}','browser',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('${envelope}','org','work_item','${work}',100,60,'USD','2026-08-20T00:00:00.000Z'); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT '${admission}','org',id,version,admission_spec_revision,'tedi','tedi','admitted','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='${work}'; INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('rr-${admission}','org','${admission}','${work}','${pool}',1,'browser',1,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z'); INSERT INTO work_budget_reservations(id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at) VALUES('br-${admission}','org','${admission}','${work}','${envelope}',1,60,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')`,
	);
}

function seedAdmissionFacts(
	db: DatabaseSync,
	{ resources = 0, budgets = 0 }: { resources?: number; budgets?: number },
) {
	const insertPool = db.prepare(
		"INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES(?,'org',?,'capacity',1,'2026-08-20T00:00:00.000Z')",
	);
	const insertRequirement = db.prepare(
		"INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','work',?,1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
	);
	for (let index = 0; index < resources; index++) {
		const key = `resource-${index.toString().padStart(4, "0")}`;
		insertPool.run(`pool-${key}`, key);
		insertRequirement.run(key);
	}
	const insertCase = db.prepare(
		"INSERT INTO work_cases(id,org_id,project_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES(?,'org','project',?,'incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
	);
	const insertCaseItem = db.prepare(
		"INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES(?,'org',?,'work','2026-08-20T00:00:00.000Z')",
	);
	const insertEnvelope = db.prepare(
		"INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES(?,'org','case',?,10,1,'USD','2026-08-20T00:00:00.000Z')",
	);
	for (let index = 0; index < budgets; index++) {
		const caseId = `budget-case-${index.toString().padStart(4, "0")}`;
		insertCase.run(caseId, caseId);
		insertCaseItem.run(`link-${caseId}`, caseId);
		insertEnvelope.run(`budget-${index.toString().padStart(4, "0")}`, caseId);
	}
}

describe("migrated Work factory raw-D1 invariants", () => {
	it("derives canonical admission authorities without duplicates", () => {
		expect(
			requiredWorkAdmissionAuthorities({
				requiredAuthorities: ["deploy", "risk:high", "deploy"],
				riskLevel: "high",
			}),
		).toEqual(["deploy", "risk:high"]);
		expect(WORK_ADMISSION_APPROVAL_ACTION).toBe("admission");
	});

	it("fails admission approval evaluation closed for stale or malformed receipts", () => {
		const item = {
			id: "work",
			version: 2,
			requiredAuthorities: ["deploy"],
			riskLevel: "high" as const,
		};
		const invalidReceipts = [
			{
				workItemId: "work",
				workItemVersion: 1,
				authorityKey: "deploy",
				action: "admission",
			},
			{
				workItemId: "other",
				workItemVersion: 2,
				authorityKey: "risk:high",
				action: "admission",
			},
			{
				workItemId: "work",
				workItemVersion: 2,
				authorityKey: "deploy",
				action: "evaluate_repair",
			},
		];
		expect(evaluateWorkAdmissionApprovals(item, invalidReceipts)).toEqual({
			requiredAuthorities: ["deploy", "risk:high"],
			satisfiedAuthorities: [],
			missingAuthorities: ["deploy", "risk:high"],
			satisfied: false,
		});
		expect(
			evaluateWorkAdmissionApprovals(item, [
				{
					workItemId: "work",
					workItemVersion: 2,
					authorityKey: "deploy",
					action: "admission",
				},
				{
					workItemId: "work",
					workItemVersion: 2,
					authorityKey: "risk:high",
					action: "admission",
				},
			]),
		).toMatchObject({
			satisfiedAuthorities: ["deploy", "risk:high"],
			missingAuthorities: [],
			satisfied: true,
		});
	});

	it("backfills legacy resource and budget specifications before dropping their columns", () => {
		const db = migrated(factoryStart);
		db.exec(
			`INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'); INSERT INTO work_items(id,org_id,title,disposition,resource_scopes,budget_limit_micros,created_at) VALUES('work','org','Work','accepted','["browser","browser","gpu"]',9000,'2026-08-20T00:00:00.000Z')`,
		);
		for (const row of migrations.slice(factoryStart)) db.exec(row.sql);
		expect(
			db
				.prepare(
					"SELECT resource_key,quantity FROM work_resource_requirements WHERE work_item_id='work' ORDER BY resource_key",
				)
				.all(),
		).toEqual([
			{ resource_key: "browser", quantity: 1 },
			{ resource_key: "gpu", quantity: 1 },
		]);
		expect(
			db
				.prepare(
					"SELECT scope_type,scope_id,limit_micros,reservation_micros,currency FROM work_budget_envelopes WHERE scope_id='work'",
				)
				.get(),
		).toEqual({
			scope_type: "work_item",
			scope_id: "work",
			limit_micros: 9000,
			reservation_micros: 9000,
			currency: "USD",
		});
		const columns = new Set(
			(
				db.prepare("PRAGMA table_info(work_items)").all() as Array<{
					name: string;
				}>
			).map((row) => row.name),
		);
		expect(columns.has("resource_scopes")).toBe(false);
		expect(columns.has("budget_limit_micros")).toBe(false);
		expect(
			(
				db
					.prepare(
						"SELECT admission_spec_revision AS revision FROM work_items WHERE id='work'",
					)
					.get() as { revision: string }
			).revision,
		).not.toBe("legacy");
	});

	it("expires active cutover attempts with a nullable admission or expiry", () => {
		const db = migrated(factoryStart);
		db.exec(
			`INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'); INSERT INTO work_items(id,org_id,title,disposition,created_at) VALUES('work','org','Work','accepted','2026-08-20T00:00:00.000Z')`,
		);
		for (const row of migrations.slice(factoryStart, factoryStart + 2))
			db.exec(row.sql);
		db.exec(
			`INSERT INTO tedis(id,organization_id,name,slug) VALUES('tedi','org','Tedi','tedi'); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'admission','org',id,version,admission_spec_revision,'tedi','tedi','admitted','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='work'; INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('attempt','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z',NULL)`,
		);
		for (const row of migrations.slice(factoryStart + 2)) db.exec(row.sql);
		const attempt = db
			.prepare(
				"SELECT runtime_state,outcome,finished_at FROM work_attempts WHERE id='attempt' OR json_extract(metadata,'$.migratedCompositeAttemptId')='attempt'",
			)
			.get() as { runtime_state: string; outcome: string; finished_at: string };
		expect(attempt).toMatchObject({
			runtime_state: "expired",
			outcome: "expired",
		});
		expect(attempt.finished_at).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
	});

	it("backfills legacy resource and budget rows that parse against public timestamp and UUID schemas", () => {
		const db = migrated(factoryStart),
			orgId = "11111111-1111-4111-8111-111111111111",
			workItemId = "22222222-2222-4222-8222-222222222222";
		db.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES(?,'Org','org')",
		).run(orgId);
		db.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,resource_scopes,budget_limit_micros,created_at) VALUES(?,?,'Work','accepted','[\"browser\"]',9000,'2026-08-20T00:00:00.000Z')",
		).run(workItemId, orgId);
		for (const row of migrations.slice(factoryStart)) db.exec(row.sql);
		const pool = db
				.prepare(
					"SELECT id,org_id,resource_key,allocation_mode,capacity,owner_ref,created_at,updated_at,version FROM work_resource_pools WHERE org_id=?",
				)
				.get(orgId) as Record<string, unknown>,
			budget = db
				.prepare(
					"SELECT id,org_id,scope_type,scope_id,currency,limit_micros,reservation_micros,created_at,updated_at,version FROM work_budget_envelopes WHERE org_id=?",
				)
				.get(orgId) as Record<string, unknown>;
		expect(
			WorkResourcePoolSchema.safeParse({
				id: pool.id,
				orgId: pool.org_id,
				resourceKey: pool.resource_key,
				allocationMode: pool.allocation_mode,
				capacity: pool.capacity,
				ownerRef: pool.owner_ref,
				createdAt: pool.created_at,
				updatedAt: pool.updated_at,
				version: pool.version,
			}).success,
		).toBe(true);
		expect(
			WorkBudgetEnvelopeSchema.safeParse({
				id: budget.id,
				orgId: budget.org_id,
				scopeType: budget.scope_type,
				scopeId: budget.scope_id,
				currency: budget.currency,
				limitMicros: budget.limit_micros,
				reservationMicros: budget.reservation_micros,
				createdAt: budget.created_at,
				updatedAt: budget.updated_at,
				version: budget.version,
			}).success,
		).toBe(true);
	});

	it("does not count same-day expired ISO reservations as active capacity", () => {
		const db = migrated();
		seedCore(db);
		seedTedi(db);
		db.exec(
			`UPDATE work_items SET disposition='accepted' WHERE id='work'; INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('pool','org','browser','capacity',2,strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours')); INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','work','browser',2,strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours')); INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('envelope','org','organization','org',200,60,'USD',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours')); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'admission-1','org',id,version,admission_spec_revision,'tedi','tedi','admitted',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') FROM work_items WHERE id='work'; INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'admission-2','org',id,version,admission_spec_revision,'tedi','tedi','admitted',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') FROM work_items WHERE id='work'; INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('resource','org','admission-1','work','pool',1,'browser',2,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')); INSERT INTO work_budget_reservations(id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at) VALUES('budget-1','org','admission-1','work','envelope',1,60,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')),('budget-2','org','admission-2','work','envelope',1,60,'active',strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour')); UPDATE work_resource_pools SET capacity=1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=2 WHERE id='pool'; UPDATE work_budget_envelopes SET limit_micros=60,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=2 WHERE id='envelope'`,
		);
		expect(
			db
				.prepare("SELECT capacity FROM work_resource_pools WHERE id='pool'")
				.get(),
		).toEqual({ capacity: 1 });
		expect(
			db
				.prepare(
					"SELECT limit_micros FROM work_budget_envelopes WHERE id='envelope'",
				)
				.get(),
		).toEqual({ limit_micros: 60 });
	});

	it("rejects graph attachment to terminal cases and milestones", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`INSERT INTO work_cases(id,org_id,project_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES('case','org','project','Case','incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); UPDATE work_cases SET stage='closed',closed_at='2026-08-20T01:00:00.000Z',updated_at='2026-08-20T01:00:00.000Z',version=2 WHERE id='case'; INSERT INTO work_milestones(id,org_id,project_id,title,status,accountable_owner_type,accountable_owner_id,created_at) VALUES('milestone','org','project','Milestone','active','system','tedix','2026-08-20T00:00:00.000Z'); UPDATE work_milestones SET status='cancelled',cancelled_at='2026-08-20T01:00:00.000Z',updated_at='2026-08-20T01:00:00.000Z',version=2 WHERE id='milestone'`,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES('link','org','case','work','2026-08-20T00:00:00.000Z')",
				),
			/closed case cannot accept work/,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES('org','milestone','work','2026-08-20T00:00:00.000Z')",
				),
			/terminal milestone cannot accept work/,
		);
	});

	it("enforces milestone project domains, initial state, and terminal graph retention", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`INSERT INTO projects(id,org_id,key,name,created_at) VALUES('other-project','org','other','Other','2026-08-20T00:00:00.000Z'); INSERT INTO work_items(id,org_id,project_id,title,disposition,admission_spec_revision,created_at) VALUES('project-work','org','project','Project work','completed','project-revision','2026-08-20T00:00:00.000Z'),('other-work','org','other-project','Other work','completed','other-revision','2026-08-20T00:00:00.000Z'); INSERT INTO work_milestones(id,org_id,project_id,title,status,accountable_owner_type,accountable_owner_id,created_at) VALUES('milestone','org','project','Milestone','active','system','tedix','2026-08-20T00:00:00.000Z'),('peer-milestone','org','project','Peer','active','system','tedix','2026-08-20T00:00:00.000Z'),('other-milestone','org','other-project','Other','active','system','tedix','2026-08-20T00:00:00.000Z')`,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_milestones(id,org_id,project_id,title,status,accountable_owner_type,accountable_owner_id,proof_ref,done_at,created_at) VALUES('forged','org','project','Forged','done','system','tedix','proof','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
				),
			/initial state/,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES('org','milestone','other-work','2026-08-20T00:00:00.000Z')",
				),
			/share project/,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_milestone_dependencies(id,org_id,prerequisite_milestone_id,dependent_milestone_id,created_at) VALUES('cross','org','milestone','other-milestone','2026-08-20T00:00:00.000Z')",
				),
			/share project/,
		);
		db.exec(
			"INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES('org','milestone','project-work','2026-08-20T00:00:00.000Z'); INSERT INTO work_milestone_dependencies(id,org_id,prerequisite_milestone_id,dependent_milestone_id,created_at) VALUES('dependency','org','peer-milestone','milestone','2026-08-20T00:00:00.000Z'); UPDATE work_milestones SET status='cancelled',cancelled_at='2026-08-20T01:00:00.000Z',updated_at='2026-08-20T01:00:00.000Z',version=2 WHERE id='milestone'",
		);
		expectAbort(
			() =>
				db.exec(
					"DELETE FROM work_milestone_items WHERE milestone_id='milestone'",
				),
			/retained/,
		);
		expectAbort(
			() =>
				db.exec(
					"DELETE FROM work_milestone_dependencies WHERE id='dependency'",
				),
			/retained/,
		);
	});

	it("retains terminal case work links and dependencies", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`INSERT INTO work_cases(id,org_id,project_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES('case','org','project','Case','incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'),('peer-case','org','project','Peer','incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES('case-link','org','case','work','2026-08-20T00:00:00.000Z'); INSERT INTO work_case_dependencies(id,org_id,prerequisite_case_id,dependent_case_id,created_at) VALUES('case-dependency','org','peer-case','case','2026-08-20T00:00:00.000Z'); UPDATE work_cases SET stage='closed',closed_at='2026-08-20T01:00:00.000Z',updated_at='2026-08-20T01:00:00.000Z',version=2 WHERE id='case'`,
		);
		expectAbort(
			() => db.exec("DELETE FROM work_case_items WHERE id='case-link'"),
			/retained/,
		);
		expectAbort(
			() =>
				db.exec(
					"DELETE FROM work_case_dependencies WHERE id='case-dependency'",
				),
			/retained/,
		);
	});

	it("linearizes approval decisions, forbids self approval, and retains immutable judgments", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`UPDATE work_items SET disposition='accepted' WHERE id='work'; INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at) VALUES('proposal','org','work',1,'deploy','admission','{}','system','tedix','user','user','Need approval','2026-08-21T00:00:00.000Z','2026-08-20T00:00:00.000Z')`,
		);
		db.exec(
			`INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','proposal',2,'approved','user','user','Approved','2026-08-20T01:00:00.000Z')`,
		);
		expect(
			db
				.prepare(
					"SELECT status,version FROM work_approval_proposals WHERE id='proposal'",
				)
				.get(),
		).toEqual({ status: "approved", version: 2 });
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('loser','proposal',2,'rejected','user','user','No','2026-08-20T01:00:00.000Z')`,
				),
			/resolution race/,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_approval_decisions SET rationale='changed' WHERE id='decision'",
				),
			/immutable/,
		);
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at) VALUES('self','org','work',1,'other','admission','{}','user','user','user','user','Self','2026-08-21T00:00:00.000Z','2026-08-20T00:00:00.000Z')`,
				),
			/self approval/,
		);
		db.exec(
			`INSERT INTO work_project_health_judgments(id,org_id,project_id,status,summary,actor_type,actor_id,observed_at) VALUES('health','org','project','on_track','Healthy','user','user','2026-08-20T00:00:00.000Z')`,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_project_health_judgments SET summary='forged' WHERE id='health'",
				),
			/immutable/,
		);
		expectAbort(
			() =>
				db.exec("DELETE FROM work_project_health_judgments WHERE id='health'"),
			/immutable/,
		);
	});

	it("fences same-version interaction responders and makes responses immutable", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('request','org','work','question','Question','Answer?','system','tedix','user','user','2026-08-20T00:00:00.000Z')`,
		);
		db.exec(
			`INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES('response','org','request',2,'fence-1','user','user','Answer','answer',1,'2026-08-20T01:00:00.000Z')`,
		);
		expect(
			db
				.prepare(
					"SELECT status,version,resolution_fence FROM work_interactions WHERE id='request'",
				)
				.get(),
		).toEqual({ status: "resolved", version: 2, resolution_fence: "fence-1" });
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES('loser','org','request',2,'fence-2','user','user','Other','answer',1,'2026-08-20T01:00:00.000Z')`,
				),
			/resolution race|stale/,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_interaction_responses SET body='forged' WHERE id='response'",
				),
			/immutable/,
		);
	});

	it("freezes interaction content and permits only exact lifecycle transitions", () => {
		const db = migrated();
		seedCore(db);
		db.exec(
			`INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,created_at,expires_at) VALUES('request','org','work','question','Question','Answer?','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')`,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_interactions SET subject='forged',status='cancelled',cancelled_at='2026-08-20T01:00:00.000Z',resolution_fence='fence',version=2 WHERE id='request'",
				),
			/immutable fields/,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_interactions SET status='resolved',resolution_fence='fence',version=2 WHERE id='request'",
				),
			/transition/,
		);
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at) VALUES('wrong-kind','org','request',2,'fence','user','user','Update','coordination_update',1,'2026-08-20T01:00:00.000Z')`,
				),
			/kind does not match/,
		);
		db.exec(
			"UPDATE work_interactions SET status='cancelled',cancelled_at='2026-08-20T01:00:00.000Z',resolution_fence='fence',version=2 WHERE id='request'",
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_interactions SET status='open',version=3 WHERE id='request'",
				),
			/transition/,
		);
	});

	it("CAS-replaces admission specifications on both item version and revision", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		sqlite.exec(
			"INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('pool','org','browser','exclusive',1,'2026-08-20T00:00:00.000Z')",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const before = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const current = await replaceWorkAdmissionSpecification(db, {
			orgId: "org",
			workItemId: "work",
			expectedWorkItemVersion: before.version,
			expectedAdmissionSpecRevision: before.revision,
			specification: {
				resources: [{ resourceKey: "browser", quantity: 1 }],
				budget: { limitMicros: 100, reservationMicros: 20 },
			},
			now: "2026-08-20T01:00:00.000Z",
		});
		expect(current.workItemVersion).toBe(before.version + 1);
		expect(current.admissionSpecRevision).not.toBe(before.revision);
		await expect(
			replaceWorkAdmissionSpecification(db, {
				orgId: "org",
				workItemId: "work",
				expectedWorkItemVersion: before.version,
				expectedAdmissionSpecRevision: before.revision,
				specification: { resources: [], budget: null },
				now: "2026-08-20T01:00:01.000Z",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it.each(["missing", "disabled", "foreign-org"])(
		"rolls back the whole replacement for a %s pool",
		async (unavailable) => {
			const sqlite = migrated();
			seedCore(sqlite);
			seedAdmissionFacts(sqlite, { resources: 1 });
			sqlite.exec(`
				INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at)
				VALUES('old-budget','org','work_item','work',100,20,'USD','2026-08-20T00:00:00.000Z');
				INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at)
				VALUES('new-pool','org','new-valid','exclusive',1,'2026-08-20T00:00:00.000Z');
			`);
			if (unavailable === "disabled")
				sqlite.exec(
					`INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,enabled,created_at) VALUES('bad','org','unavailable','exclusive',1,0,'2026-08-20T00:00:00.000Z')`,
				);
			if (unavailable === "foreign-org")
				sqlite.exec(
					`INSERT INTO organizations(id,name,slug) VALUES('other','Other','other'); INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('bad','other','unavailable','exclusive',1,'2026-08-20T00:00:00.000Z')`,
				);
			const snapshot = () => ({
				item: sqlite.prepare("SELECT * FROM work_items WHERE id='work'").get(),
				resources: sqlite
					.prepare(
						"SELECT * FROM work_resource_requirements WHERE work_item_id='work' ORDER BY resource_key",
					)
					.all(),
				budget: sqlite
					.prepare("SELECT * FROM work_budget_envelopes WHERE scope_id='work'")
					.all(),
			});
			const before = snapshot();
			const facade = createD1Facade(sqlite);
			const prepared = vi.spyOn(facade, "prepare");
			await expect(
				replaceWorkAdmissionSpecification(createDbQueryClient(facade), {
					orgId: "org",
					workItemId: "work",
					expectedWorkItemVersion: before.item!.version as number,
					expectedAdmissionSpecRevision: before.item!
						.admission_spec_revision as string,
					specification: {
						resources: [
							{ resourceKey: "new-valid", quantity: 1 },
							{ resourceKey: "unavailable", quantity: 1 },
						],
						budget: { limitMicros: 200, reservationMicros: 40 },
					},
					now: "2026-08-20T01:00:00.000Z",
				}),
			).rejects.toMatchObject({
				name: "WorkAdmissionSpecificationError",
				code: "NOT_ELIGIBLE",
				missingResourceKeys: ["unavailable"],
			});
			expect(snapshot()).toEqual(before);
			// The typed rejection is decided before the replacement batch, so no
			// requirement row is even attempted; the NULL-key batch rollback stays
			// only as the fence for a pool that disappears between check and write.
			expect(
				prepared.mock.calls
					.map(([query]) => query)
					.filter((query) =>
						query.startsWith('insert into "work_resource_requirements"'),
					),
			).toHaveLength(0);
		},
	);

	it("enforces exact reservation tuples, capacity, CAS floors, and lifecycle coupling", () => {
		const db = migrated();
		seedCore(db);
		seedTedi(db);
		admitWithCapacity(db);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('released-at-birth','org','admission','work','pool',1,'browser',1,'released','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/initial state/,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_budget_reservations(id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at) VALUES('consumed-at-birth','org','admission','work','envelope',1,60,'consumed','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/initial state/,
		);
		expectAbort(
			() =>
				db.exec("UPDATE work_resource_pools SET capacity=1 WHERE id='pool'"),
			/scope\/version/,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_resource_pools SET capacity=0,version=2 WHERE id='pool'",
				),
			/capacity/,
		);
		expectAbort(
			() =>
				db.exec(
					"UPDATE work_budget_envelopes SET limit_micros=50,version=2 WHERE id='envelope'",
				),
			/budget below commitments|CHECK constraint/,
		);
		db.exec(
			"INSERT INTO work_items(id,org_id,title,disposition,admission_spec_revision,created_at) VALUES('work2','org','Work 2','accepted','revision-2','2026-08-20T00:00:00.000Z'); INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','work2','browser',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) VALUES('admission2','org','work2',1,'revision-2','tedi','tedi','admitted','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T00:00:00.000Z')",
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('rr2','org','admission2','work2','pool',1,'browser',1,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/capacity exhausted/,
		);
		expectAbort(
			() =>
				db.exec(
					"INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('forged','org','admission','work2','pool',1,'browser',1,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/does not match/,
		);
		db.exec(
			"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('attempt','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:30:00.000Z','2026-08-20T00:30:00.000Z','2026-08-20T02:00:00.000Z'); UPDATE work_attempts SET heartbeat_at='2026-08-20T01:00:00.000Z',expires_at='2026-08-20T03:00:00.000Z',version=2 WHERE id='attempt'; UPDATE work_resource_reservations SET expires_at='2026-08-20T03:00:00.000Z',version=2 WHERE admission_id='admission'; UPDATE work_budget_reservations SET expires_at='2026-08-20T03:00:00.000Z',version=2 WHERE admission_id='admission'; UPDATE work_attempts SET runtime_state='finished',outcome='succeeded',finished_at='2026-08-20T01:30:00.000Z',version=3 WHERE id='attempt'; UPDATE work_resource_reservations SET state='released',settled_at='2026-08-20T01:30:00.000Z',version=3 WHERE admission_id='admission'; UPDATE work_budget_reservations SET state='consumed',consumed_micros=60,settled_at='2026-08-20T01:30:00.000Z',version=3 WHERE admission_id='admission'",
		);
		expect(
			db
				.prepare(
					"SELECT state FROM work_resource_reservations WHERE admission_id='admission'",
				)
				.get(),
		).toEqual({ state: "released" });
		expect(
			db
				.prepare(
					"SELECT state,consumed_micros FROM work_budget_reservations WHERE admission_id='admission'",
				)
				.get(),
		).toEqual({ state: "consumed", consumed_micros: 60 });
		expectAbort(
			() =>
				db.exec(
					"DELETE FROM work_budget_reservations WHERE admission_id='admission'",
				),
			/retained/,
		);
	});

	it("requires active executor/session receipts and time-windowed rejection keys", () => {
		const db = migrated();
		seedCore(db);
		seedTedi(db);
		db.exec(
			`UPDATE work_items SET disposition='accepted' WHERE id='work'; INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id) VALUES('agent','org','agent','Agent','api_key','binding','system','tedix'); INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at) VALUES('session','org','agent','session-key','codex','1','openai','gpt','1','verified','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,executor_session_id,external_session_key,decision,decided_at,expires_at,created_at) SELECT 'external-admission','org',id,version,admission_spec_revision,'external_agent','agent','session','session-key','admitted','2026-08-20T00:00:00.000Z','2026-08-20T01:00:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='work'; UPDATE external_agent_sessions SET status='ended',ended_at='2026-08-20T00:10:00.000Z' WHERE id='session'`,
		);
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,executor_session_id,external_session_key,decision,decided_at,expires_at,created_at) SELECT 'inactive','org',id,version,admission_spec_revision,'external_agent','agent','session','session-key','admitted','2026-08-20T00:20:00.000Z','2026-08-20T01:00:00.000Z','2026-08-20T00:20:00.000Z' FROM work_items WHERE id='work'`,
				),
			/inactive external/,
		);
		db.exec(
			`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,rejection_code,rejection_reason,rejection_key,decided_at,expires_at,created_at) SELECT 'reject-1','org',id,version,admission_spec_revision,'tedi','tedi','rejected','budget_blocked','No budget','window-1','2026-08-20T00:00:00.000Z','2026-08-20T00:01:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='work'`,
		);
		expectAbort(
			() =>
				db.exec(
					`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,rejection_code,rejection_reason,rejection_key,decided_at,expires_at,created_at) SELECT 'reject-duplicate','org',id,version,admission_spec_revision,'tedi','tedi','rejected','budget_blocked','No budget','window-1','2026-08-20T00:00:30.000Z','2026-08-20T00:01:00.000Z','2026-08-20T00:00:30.000Z' FROM work_items WHERE id='work'`,
				),
			/UNIQUE/,
		);
		db.exec(
			`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,rejection_code,rejection_reason,rejection_key,decided_at,expires_at,created_at) SELECT 'reject-2','org',id,version,admission_spec_revision,'tedi','tedi','rejected','budget_blocked','No budget','window-2','2026-08-20T00:01:00.000Z','2026-08-20T00:02:00.000Z','2026-08-20T00:01:00.000Z' FROM work_items WHERE id='work'`,
		);
	});

	it("bounds scheduler candidates and rejects ended external sessions", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec(
			`UPDATE work_items SET disposition='accepted' WHERE id='work'; INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('work2','org','Work 2','accepted','hygiene','${LIVE_PURPOSE_EXCEPTION}','revision-2','2026-08-20T00:00:00.000Z')`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const page = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 1,
			limit: 1,
		});
		expect(page.evaluatedCandidates).toBe(1);
		expect(page.boundedCandidateLimit).toBe(1);
		for (let i = 0; i < 101; i++)
			sqlite
				.prepare(
					`INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES(?,'org',?,'accepted','hygiene','${LIVE_PURPOSE_EXCEPTION}',?,'2026-08-20T00:00:00.000Z')`,
				)
				.run(
					`bulk-${i.toString().padStart(3, "0")}`,
					`Bulk ${i}`,
					`bulk-revision-${i}`,
				);
		const bulk = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 150,
			limit: 150,
		});
		expect(bulk.evaluatedCandidates).toBe(103);
		expect(bulk.data).toHaveLength(103);
		sqlite.exec(
			`INSERT INTO external_agent_principals(id,organization_id,key,display_name,credential_binding_type,credential_binding_id,created_by_type,created_by_id,status) VALUES('agent','org','agent','Agent','api_key','binding','system','tedix','active'); INSERT INTO external_agent_sessions(id,organization_id,principal_id,external_session_key,harness,harness_version,model_provider,model_id,model_version,identity_source,started_at,last_seen_at,status,ended_at) VALUES('session','org','agent','session-key','codex','1','openai','gpt','1','verified','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z','ended','2026-08-20T00:01:00.000Z')`,
		);
		await expect(
			listReadyWork(db, {
				orgId: "org",
				executorType: "external_agent",
				executorId: "agent",
				executorSessionId: "session",
				externalSessionKey: "session-key",
				now: "2026-08-20T00:02:00.000Z",
			}),
		).rejects.toMatchObject({ code: "INVALID_PRINCIPAL" });
	});

	it("detects scheduler hard-fact truncation within chunks and across chunks", () => {
		expect(boundSchedulerFactChunks([[1, 2, 3], [4]], 2)).toEqual({
			rows: [1, 2],
			truncated: true,
		});
		expect(boundSchedulerFactChunks([[1, 2], [3]], 2)).toEqual({
			rows: [1, 2],
			truncated: true,
		});
		expect(boundSchedulerFactChunks([[1], [2]], 2)).toEqual({
			rows: [1, 2],
			truncated: false,
		});
	});

	it("fails scheduler eligibility closed when dependency facts truncate", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec("UPDATE work_items SET disposition='accepted' WHERE id='work'");
		const insertItem = sqlite.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,admission_spec_revision,created_at) VALUES(?,'org',?,'proposed',?,'2026-08-20T00:00:00.000Z')",
		);
		const insertBlocker = sqlite.prepare(
			"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES(?,'org',?,'work','blocks','2026-08-20T00:00:00.000Z')",
		);
		for (let index = 0; index < 11; index++) {
			const id = `blocker-${index.toString().padStart(2, "0")}`;
			insertItem.run(id, id, `revision-${index}`);
			insertBlocker.run(`relation-${index}`, id);
		}
		const result = await listReadyWork(
			createDbQueryClient(createD1Facade(sqlite)),
			{
				orgId: "org",
				executorType: "tedi",
				executorId: "tedi",
				now: "2026-08-20T01:00:00.000Z",
				candidateLimit: 1,
			},
		);
		expect(result.data).toEqual([]);
		expect(result.factsTruncated).toBe(true);
		expect(result.truncatedFacts).toEqual(["dependencies"]);
		expect(result.ineligibleByReason.dependencies_blocked).toBe(1);
		expect(result.graphTruncated).toBe(false);
	});

	it("prefilters expired operational purpose before the bounded scheduler queue", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec(
			"UPDATE work_items SET disposition='accepted',work_class='hygiene',purpose_exception_expires_at='2026-08-20T00:30:00.000Z' WHERE id='work'",
		);
		const result = await listReadyWork(
			createDbQueryClient(createD1Facade(sqlite)),
			{
				orgId: "org",
				executorType: "tedi",
				executorId: "tedi",
				now: "2026-08-20T01:00:00.000Z",
				candidateLimit: 1,
			},
		);
		expect(result.data).toEqual([]);
		expect(result.evaluatedCandidates).toBe(0);
	});

	it("keeps milestone timeline pages canonical and under D1's parameter budget", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		const insert = sqlite.prepare(
			"INSERT INTO work_milestones(id,org_id,project_id,title,status,accountable_owner_type,accountable_owner_id,sort_order,target_at,created_at) VALUES(?,'org','project',?,'active','system','tedix',?,?,'2026-08-20T00:00:00.000Z')",
		);
		insert.run("m-early", "Early", 0, "2026-08-20T01:00:00.000Z");
		insert.run("m-late", "Late", 0, "2026-08-20T02:00:00.000Z");
		insert.run("m-null-a", "Null A", 0, null);
		insert.run("m-null-b", "Null B", 0, null);
		for (let i = 0; i < 201; i++)
			insert.run(
				`m-bulk-${i.toString().padStart(3, "0")}`,
				`Bulk ${i}`,
				i + 1,
				null,
			);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const first = await listWorkMilestoneViews(db, {
			orgId: "org",
			projectId: "project",
			limit: 2,
		});
		expect(first.data.map((row) => row.milestone.id)).toEqual([
			"m-early",
			"m-late",
		]);
		const second = await listWorkMilestoneViews(db, {
			orgId: "org",
			projectId: "project",
			limit: 2,
			cursor: first.nextCursor!,
		});
		expect(second.data.map((row) => row.milestone.id)).toEqual([
			"m-null-a",
			"m-null-b",
		]);
		await expect(
			listWorkMilestoneViews(db, {
				orgId: "org",
				projectId: "project",
				cursor: "missing",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		const defaultPage = await listWorkMilestoneViews(db, {
			orgId: "org",
			projectId: "project",
		});
		expect(defaultPage.data).toHaveLength(50);
		expect(defaultPage.nextCursor).not.toBeNull();
		const maxPage = await listWorkMilestoneViews(db, {
			orgId: "org",
			projectId: "project",
			limit: 200,
		});
		expect(maxPage.data).toHaveLength(200);
		expect(maxPage.nextCursor).not.toBeNull();
	});

	it("requires done prerequisites and returns a typed milestone transition failure", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		sqlite.exec(
			`UPDATE work_items SET project_id='project',admission_spec_revision='project-revision',updated_at='2026-08-20T00:00:00.000Z',version=2 WHERE id='work'; INSERT INTO work_milestones(id,org_id,project_id,title,status,accountable_owner_type,accountable_owner_id,created_at) VALUES('prerequisite','org','project','Prerequisite','active','system','tedix','2026-08-20T00:00:00.000Z'),('dependent','org','project','Dependent','active','system','tedix','2026-08-20T00:00:00.000Z'); INSERT INTO work_milestone_dependencies(id,org_id,prerequisite_milestone_id,dependent_milestone_id,created_at) VALUES('dependency','org','prerequisite','dependent','2026-08-20T00:00:00.000Z'); INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES('org','dependent','work','2026-08-20T00:00:00.000Z'); UPDATE work_milestones SET status='cancelled',cancelled_at='2026-08-20T00:30:00.000Z',updated_at='2026-08-20T00:30:00.000Z',version=2 WHERE id='prerequisite'`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await expect(
			updateWorkMilestone(db, {
				orgId: "org",
				milestoneId: "dependent",
				expectedVersion: 1,
				status: "done",
				proofRef: "artifact://proof",
				now: "2026-08-20T01:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
	});

	it("evaluates admissions across more than one hundred attached cases without oversized bindings", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec("UPDATE work_items SET disposition='accepted' WHERE id='work'");
		const insertCase = sqlite.prepare(
				"INSERT INTO work_cases(id,org_id,project_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES(?,'org','project',?,'incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
			),
			link = sqlite.prepare(
				"INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES(?,'org',?,'work','2026-08-20T00:00:00.000Z')",
			);
		for (let i = 0; i < 101; i++) {
			const id = `case-${i.toString().padStart(3, "0")}`;
			insertCase.run(id, id);
			link.run(`link-${i}`, id);
		}
		sqlite.exec(
			"INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('case-budget','org','case','case-100',100,10,'USD','2026-08-20T00:00:00.000Z')",
		);
		const item = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const db = createDbQueryClient(createD1Facade(sqlite));
		const admission = await evaluateAndRecordWorkAdmission(db, {
			id: "many-cases-admission",
			orgId: "org",
			workItemId: "work",
			expectedWorkItemVersion: item.version,
			expectedAdmissionSpecRevision: item.revision,
			executorType: "tedi",
			executorId: "tedi",
			leaseTtlMs: 60000,
			now: "2026-08-20T01:00:00.000Z",
		});
		expect(admission.decision).toBe("admitted");
		expect(
			sqlite
				.prepare(
					"SELECT envelope_id FROM work_budget_reservations WHERE admission_id='many-cases-admission'",
				)
				.get(),
		).toEqual({ envelope_id: "case-budget" });
	});

	it("rejects authoritative admission after an operational purpose expires", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec(
			"UPDATE work_items SET disposition='accepted',work_class='hygiene',purpose_exception_expires_at='2026-08-20T00:30:00.000Z' WHERE id='work'",
		);
		const item = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const admission = await evaluateAndRecordWorkAdmission(
			createDbQueryClient(createD1Facade(sqlite)),
			{
				id: "expired-purpose-admission",
				orgId: "org",
				workItemId: "work",
				expectedWorkItemVersion: item.version,
				expectedAdmissionSpecRevision: item.revision,
				executorType: "tedi",
				executorId: "tedi",
				leaseTtlMs: 60_000,
				now: "2026-08-20T01:00:00.000Z",
			},
		);
		expect(admission).toMatchObject({
			decision: "rejected",
			rejectionCode: "purpose_blocked",
		});
	});

	it("admits at the exact authoritative resource and budget fact caps", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec("UPDATE work_items SET disposition='accepted' WHERE id='work'");
		seedAdmissionFacts(sqlite, {
			resources: WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP,
			budgets: WORK_ADMISSION_BUDGET_ENVELOPE_CAP,
		});
		const item = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const db = createDbQueryClient(createD1Facade(sqlite));
		const admission = await evaluateAndRecordWorkAdmission(db, {
			id: "bounded-admission",
			orgId: "org",
			workItemId: "work",
			expectedWorkItemVersion: item.version,
			expectedAdmissionSpecRevision: item.revision,
			executorType: "tedi",
			executorId: "tedi",
			leaseTtlMs: 60000,
			now: "2026-08-20T01:00:00.000Z",
		});

		expect(admission.decision).toBe("admitted");
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_resource_reservations WHERE admission_id='bounded-admission'",
				)
				.get(),
		).toEqual({ count: WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP });
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM work_budget_reservations WHERE admission_id='bounded-admission'",
				)
				.get(),
		).toEqual({ count: WORK_ADMISSION_BUDGET_ENVELOPE_CAP });
	});

	it("counts a consumed reservation against the envelope and a released one not at all", async () => {
		// A retired lease: capacity is back, but the budget row still records
		// what the previous attempt spent. Drizzle strips table qualification
		// from column refs inside a single-table select, so a correlated
		// `r.envelope_id = ${envelopes.id}` silently compared `r.envelope_id`
		// with `r.id` and every envelope reported zero committed spend.
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		admitWithCapacity(sqlite);
		sqlite.exec(
			"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('spent','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		// The run reports its spend, then its lease elapses without settlement.
		await heartbeatWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			attemptId: "spent",
			executor: { type: "tedi", id: "tedi" },
			heartbeatAt: "2026-08-20T00:30:00.000Z",
			leaseTtlMs: 3_600_000,
			costMicros: 60,
		});
		expect(
			await sweepElapsedWorkAttempts(db, { now: "2026-08-20T02:00:00.000Z" }),
		).toMatchObject({ expired: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT state, consumed_micros FROM work_budget_reservations WHERE id='br-admission'",
				)
				.get(),
		).toEqual({ state: "consumed", consumed_micros: 60 });
		const item = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		// limit 100: consumed 60 + a new 60 reservation does not fit.
		expect(
			await evaluateAndRecordWorkAdmission(db, {
				id: "blocked",
				orgId: "org",
				workItemId: "work",
				expectedWorkItemVersion: item.version,
				expectedAdmissionSpecRevision: item.revision,
				executorType: "tedi",
				executorId: "tedi",
				leaseTtlMs: 60000,
				now: "2026-08-20T02:00:00.000Z",
			}),
		).toMatchObject({ decision: "rejected", rejectionCode: "budget_blocked" });
		const [envelope] = (
			await listWorkBudgetEnvelopes(db, {
				orgId: "org",
				scopeType: "work_item",
				scopeId: "work",
				at: "2026-08-20T02:00:00.000Z",
			})
		).data;
		expect(envelope?.committedMicros).toBe(60);
	});

	it("gives the budget back when a lease expires with nothing committed, under the real triggers", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		admitWithCapacity(sqlite);
		sqlite.exec(
			"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('attempt','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const item = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const evaluate = (id: string, now: string) =>
			evaluateAndRecordWorkAdmission(db, {
				id,
				orgId: "org",
				workItemId: "work",
				expectedWorkItemVersion: item.version,
				expectedAdmissionSpecRevision: item.revision,
				executorType: "tedi",
				executorId: "tedi",
				leaseTtlMs: 60000,
				now,
			});
		expect(await evaluate("held", "2026-08-20T01:00:00.000Z")).toMatchObject({
			decision: "rejected",
			rejectionCode: "already_running",
		});

		// Lease elapsed at 02:00 with no cost ever reported.
		expect(
			await sweepElapsedWorkAttempts(db, { now: "2026-08-20T03:00:00.000Z" }),
		).toMatchObject({ expired: 1 });
		expect(
			sqlite
				.prepare(
					"SELECT state, consumed_micros FROM work_budget_reservations WHERE id='br-admission'",
				)
				.get(),
		).toEqual({ state: "released", consumed_micros: null });
		// limit 100, reservation 60: the item is admissible again.
		expect(await evaluate("again", "2026-08-20T03:00:00.000Z")).toMatchObject({
			decision: "admitted",
		});
	});

	it.each([
		{
			label: "resource requirements",
			resources: WORK_ADMISSION_RESOURCE_REQUIREMENT_CAP + 1,
			budgets: 0,
			triggerError: /resource requirement facts exceed admission cap/,
		},
		{
			label: "budget envelopes",
			resources: 0,
			budgets: WORK_ADMISSION_BUDGET_ENVELOPE_CAP + 1,
			triggerError: /budget envelope facts exceed admission cap/,
		},
	])(
		"fails admission closed when $label exceed the authoritative cap",
		async ({ resources, budgets, triggerError }) => {
			const sqlite = migrated();
			seedCore(sqlite);
			seedTedi(sqlite);
			sqlite.exec(
				"UPDATE work_items SET disposition='accepted' WHERE id='work'",
			);
			seedAdmissionFacts(sqlite, { resources, budgets });
			const item = sqlite
				.prepare(
					"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
				)
				.get() as { version: number; revision: string };
			const db = createDbQueryClient(createD1Facade(sqlite));
			const rejection = await evaluateAndRecordWorkAdmission(db, {
				id: "truncated-admission",
				orgId: "org",
				workItemId: "work",
				expectedWorkItemVersion: item.version,
				expectedAdmissionSpecRevision: item.revision,
				executorType: "tedi",
				executorId: "tedi",
				leaseTtlMs: 60000,
				now: "2026-08-20T01:00:00.000Z",
			});

			expect(rejection).toMatchObject({
				decision: "rejected",
				rejectionCode: "evaluation_required",
			});
			expect(
				sqlite
					.prepare(
						"SELECT COUNT(*) AS count FROM work_admissions WHERE decision='admitted'",
					)
					.get(),
			).toEqual({ count: 0 });
			expect(
				sqlite
					.prepare(
						"SELECT (SELECT COUNT(*) FROM work_resource_reservations) + (SELECT COUNT(*) FROM work_budget_reservations) AS count",
					)
					.get(),
			).toEqual({ count: 0 });
			expectAbort(
				() =>
					sqlite.exec(
						`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'direct-admission','org',id,version,admission_spec_revision,'tedi','tedi','admitted','2026-08-20T01:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T01:00:00.000Z' FROM work_items WHERE id='work'`,
					),
				triggerError,
			);
		},
	);

	it("orders scheduler candidates by deadline and numeric priority, bounds edges, and scores actual cost", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec(
			`UPDATE work_items SET disposition='accepted',priority='critical' WHERE id='work'; INSERT INTO work_items(id,org_id,title,disposition,priority,deadline,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES('dated','org','Dated','accepted','low','2026-08-21T00:00:00.000Z','hygiene','${LIVE_PURPOSE_EXCEPTION}','dated-revision','2026-08-20T00:00:00.000Z'),('high','org','High','accepted','high',NULL,'hygiene','${LIVE_PURPOSE_EXCEPTION}','high-revision','2026-08-20T00:00:00.000Z'); INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('cheap','org','work_item','work',2000000,1000000,'USD','2026-08-20T00:00:00.000Z'),('expensive','org','work_item','high',3000000,2000000,'USD','2026-08-20T00:00:00.000Z')`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const bounded = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 1,
			limit: 1,
		});
		expect(bounded.data[0]?.workItem.id).toBe("dated");
		sqlite.exec("UPDATE work_items SET deadline=NULL WHERE id='dated'");
		const ranked = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 3,
			limit: 3,
		});
		expect(ranked.data.map((row) => row.workItem.id)).toEqual([
			"work",
			"high",
			"dated",
		]);
		expect(
			ranked.data.find((row) => row.workItem.id === "work")?.factors.cost,
		).toBe(-1);
		expect(
			ranked.data.find((row) => row.workItem.id === "high")?.factors.cost,
		).toBe(-2);
		const capped = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 3,
			maxCostMicros: 1500000,
		});
		expect(capped.ineligibleByReason.cost_blocked).toBe(1);
		expect(capped.data.some((row) => row.workItem.id === "high")).toBe(false);
		sqlite.exec(
			"UPDATE work_items SET disposition='completed',completed_at='2026-08-20T01:00:00.000Z' WHERE id IN ('work','dated','high')",
		);
		for (let i = 0; i < 12; i++)
			sqlite
				.prepare(
					`INSERT INTO work_items(id,org_id,title,disposition,work_class,purpose_exception_expires_at,admission_spec_revision,created_at) VALUES(?,'org',?,'accepted','hygiene','${LIVE_PURPOSE_EXCEPTION}',?,'2026-08-20T00:00:00.000Z')`,
				)
				.run(
					`node-${i.toString().padStart(2, "0")}`,
					`Node ${i}`,
					`revision-${i}`,
				);
		for (let i = 0; i < 12; i++)
			for (let j = 0; j < 12; j++)
				if (i !== j)
					sqlite
						.prepare(
							"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES(?,'org',?,?,'blocks','2026-08-20T00:00:00.000Z')",
						)
						.run(
							`edge-${i}-${j}`,
							`node-${i.toString().padStart(2, "0")}`,
							`node-${j.toString().padStart(2, "0")}`,
						);
		const graph = await listReadyWork(db, {
			orgId: "org",
			executorType: "tedi",
			executorId: "tedi",
			now: "2026-08-20T00:00:00.000Z",
			candidateLimit: 12,
		});
		expect(graph.graphTruncated).toBe(true);
	});

	it("fails scheduler eligibility closed when bounded budget facts are truncated", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec("UPDATE work_items SET disposition='accepted' WHERE id='work'");
		const insertCase = sqlite.prepare(
				"INSERT INTO work_cases(id,org_id,project_id,title,kind,stage,accountable_owner_type,accountable_owner_id,opened_at,created_at) VALUES(?,'org','project',?,'incident','investigating','system','tedix','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z')",
			),
			insertLink = sqlite.prepare(
				"INSERT INTO work_case_items(id,org_id,case_id,work_item_id,discovered_at) VALUES(?,'org',?,'work','2026-08-20T00:00:00.000Z')",
			),
			insertEnvelope = sqlite.prepare(
				"INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES(?,'org','case',?,?,?, 'USD','2026-08-20T00:00:00.000Z')",
			);
		for (let index = 0; index < 5001; index++) {
			const id = `bounded-${index.toString().padStart(4, "0")}`;
			insertCase.run(id, id);
			insertLink.run(`link-${id}`, id);
			insertEnvelope.run(`envelope-${id}`, id, 10, 1);
		}
		const result = await listReadyWork(
			createDbQueryClient(createD1Facade(sqlite)),
			{
				orgId: "org",
				executorType: "tedi",
				executorId: "tedi",
				now: "2026-08-20T01:00:00.000Z",
				candidateLimit: 1,
			},
		);
		expect(result.factsTruncated).toBe(true);
		expect(result.truncatedFacts).toEqual(["budgets", "cases"]);
		expect(result.data).toEqual([]);
		expect(result.ineligibleByReason.evaluation_required).toBe(1);
	});

	it("expires stale pending approval atomically before allowing reproposal", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		sqlite.exec(
			`UPDATE work_items SET required_authorities='["deploy"]', admission_spec_revision='revision-2', updated_at='2026-08-20T00:00:00.000Z', version=2 WHERE id='work'`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		await proposeWorkApproval(db, {
			id: "old",
			orgId: "org",
			workItemId: "work",
			workItemVersion: 2,
			authorityKey: "deploy",
			proposal: { revision: 1 },
			requesterType: "system",
			requesterId: "tedix",
			approverType: "user",
			approverId: "user",
			rationale: "Old",
			expiresAt: "2026-08-20T01:00:00.000Z",
			now: "2026-08-20T00:00:00.000Z",
		});
		const next = await proposeWorkApproval(db, {
			id: "new",
			orgId: "org",
			workItemId: "work",
			workItemVersion: 2,
			authorityKey: "deploy",
			proposal: { revision: 2 },
			requesterType: "system",
			requesterId: "tedix",
			approverType: "user",
			approverId: "user",
			rationale: "New",
			expiresAt: "2026-08-20T03:00:00.000Z",
			now: "2026-08-20T02:00:00.000Z",
		});
		expect(next.id).toBe("new");
		expect(
			sqlite
				.prepare(
					"SELECT status,resolved_at IS NOT NULL AS resolved,resolution_fence IS NOT NULL AS fenced FROM work_approval_proposals WHERE id='old'",
				)
				.get(),
		).toEqual({ status: "expired", resolved: 1, fenced: 1 });
	});

	it("stores only canonical admission approvals and rejects malformed authorities", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		sqlite.exec(
			`UPDATE work_items SET risk_level='high', admission_spec_revision='revision-2', updated_at='2026-08-20T00:00:00.000Z', version=2 WHERE id='work'`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const base = {
			orgId: "org",
			workItemId: "work",
			workItemVersion: 2,
			proposal: { revision: 2 },
			requesterType: "system" as const,
			requesterId: "tedix",
			approverType: "user" as const,
			approverId: "user",
			rationale: "Review elevated-risk admission",
			expiresAt: "2026-08-20T03:00:00.000Z",
			now: "2026-08-20T00:00:00.000Z",
		};
		await expect(
			proposeWorkApproval(db, {
				...base,
				id: "malformed",
				authorityKey: "risk.high",
			}),
		).rejects.toMatchObject({ code: "NOT_ELIGIBLE" });
		const proposal = await proposeWorkApproval(db, {
			...base,
			id: "canonical",
			authorityKey: "risk:high",
		});
		expect(proposal).toMatchObject({
			action: "admission",
			authorityKey: "risk:high",
		});
	});

	it("atomically couples work-item budget envelope CAS to admission-spec revision", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const before = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		const created = await createWorkBudgetEnvelope(db, {
			id: "budget",
			orgId: "org",
			scopeType: "work_item",
			scopeId: "work",
			limitMicros: 100,
			reservationMicros: 10,
			now: "2026-08-20T01:00:00.000Z",
		});
		const afterCreate = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		expect(afterCreate.version).toBe(before.version + 1);
		expect(afterCreate.revision).not.toBe(before.revision);
		const updated = await updateWorkBudgetEnvelope(db, {
			orgId: "org",
			envelopeId: created.id,
			expectedVersion: created.version,
			limitMicros: 120,
			now: "2026-08-20T02:00:00.000Z",
		});
		expect(updated.version).toBe(2);
		const afterUpdate = sqlite
			.prepare(
				"SELECT version,admission_spec_revision AS revision FROM work_items WHERE id='work'",
			)
			.get() as { version: number; revision: string };
		expect(afterUpdate.version).toBe(afterCreate.version + 1);
		expect(afterUpdate.revision).not.toBe(afterCreate.revision);
		sqlite.exec(
			"CREATE TRIGGER reject_budget_spec_bump BEFORE UPDATE ON work_items BEGIN SELECT RAISE(ABORT,'reject bump'); END",
		);
		await expect(
			updateWorkBudgetEnvelope(db, {
				orgId: "org",
				envelopeId: created.id,
				expectedVersion: 2,
				limitMicros: 130,
				now: "2026-08-20T03:00:00.000Z",
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			sqlite
				.prepare(
					"SELECT limit_micros,version FROM work_budget_envelopes WHERE id='budget'",
				)
				.get(),
		).toEqual({ limit_micros: 120, version: 2 });
	});

	it("revalidates expiry, resource pool, capabilities, and approvals at attempt start", async () => {
		const poolDb = migrated();
		seedCore(poolDb);
		seedTedi(poolDb);
		admitWithCapacity(poolDb);
		expectAbort(
			() =>
				poolDb.exec(
					"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('null-expiry','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:30:00.000Z','2026-08-20T00:30:00.000Z',NULL)",
				),
			/active admission/,
		);
		poolDb.exec(
			"UPDATE work_resource_pools SET enabled=0,updated_at='2026-08-20T00:20:00.000Z',version=2 WHERE id='pool'",
		);
		expectAbort(
			() =>
				poolDb.exec(
					"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('revoked-pool','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:30:00.000Z','2026-08-20T00:30:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/pool revoked/,
		);
		const capDb = migrated();
		seedCore(capDb);
		seedTedi(capDb);
		capDb.exec(
			`UPDATE work_items SET required_capabilities='["browser"]',admission_spec_revision='cap-revision',updated_at='2026-08-20T00:00:00.000Z',version=2 WHERE id='work'; INSERT INTO org_capabilities(id,organization_id,name,slug,pace_layer,status,created_at) VALUES('cap','org','Browser','browser','record','active','2026-08-20T00:00:00.000Z'); INSERT INTO capability_links(id,capability_id,organization_id,entity_kind,entity_id,created_at) VALUES('link','cap','org','tedi','tedi','2026-08-20T00:00:00.000Z')`,
		);
		admitWithCapacity(capDb);
		capDb.exec(
			"UPDATE org_capabilities SET status='archived',archived_at='2026-08-20T00:20:00.000Z' WHERE id='cap'",
		);
		expectAbort(
			() =>
				capDb.exec(
					"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('revoked-cap','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:30:00.000Z','2026-08-20T00:30:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/capability revoked/,
		);
		const approvalDb = migrated();
		seedCore(approvalDb);
		seedTedi(approvalDb);
		approvalDb.exec(
			`UPDATE work_items SET required_authorities='["deploy"]',admission_spec_revision='approval-revision',updated_at='2026-08-20T00:00:00.000Z',version=2 WHERE id='work'; INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at) VALUES('approval','org','work',2,'deploy','admission','{}','system','tedix','user','user','Approved','2026-08-20T00:20:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','approval',2,'approved','user','user','Approved','2026-08-20T00:10:00.000Z')`,
		);
		admitWithCapacity(approvalDb);
		expectAbort(
			() =>
				approvalDb.exec(
					"INSERT INTO work_attempts(id,admission_id,work_item_id,org_id,executor_type,executor_id,runtime_state,attempt_number,started_at,heartbeat_at,expires_at) VALUES('expired-approval','admission','work','org','tedi','tedi','running',1,'2026-08-20T00:30:00.000Z','2026-08-20T00:30:00.000Z','2026-08-20T02:00:00.000Z')",
				),
			/approval expired/,
		);
	});

	it("releases only the losing admission after a real two-start active-slot collision", async () => {
		const sqlite = migrated();
		seedCore(sqlite);
		seedTedi(sqlite);
		sqlite.exec(
			`UPDATE work_items SET disposition='accepted' WHERE id='work'; INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('pool','org','browser','capacity',2,'2026-08-20T00:00:00.000Z'); INSERT INTO work_resource_requirements(org_id,work_item_id,resource_key,quantity,created_at,updated_at) VALUES('org','work','browser',1,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z'); INSERT INTO work_budget_envelopes(id,org_id,scope_type,scope_id,limit_micros,reservation_micros,currency,created_at) VALUES('envelope','org','work_item','work',120,60,'USD','2026-08-20T00:00:00.000Z'); INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'winner-admission','org',id,version,admission_spec_revision,'tedi','tedi','admitted','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='work'; INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'loser-admission','org',id,version,admission_spec_revision,'tedi','tedi','admitted','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z','2026-08-20T00:00:00.000Z' FROM work_items WHERE id='work'; INSERT INTO work_resource_reservations(id,org_id,admission_id,work_item_id,pool_id,pool_version,resource_key,quantity,state,reserved_at,expires_at) VALUES('winner-resource','org','winner-admission','work','pool',1,'browser',1,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z'),('loser-resource','org','loser-admission','work','pool',1,'browser',1,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z'); INSERT INTO work_budget_reservations(id,org_id,admission_id,work_item_id,envelope_id,envelope_version,amount_micros,state,reserved_at,expires_at) VALUES('winner-budget','org','winner-admission','work','envelope',1,60,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z'),('loser-budget','org','loser-admission','work','envelope',1,60,'active','2026-08-20T00:00:00.000Z','2026-08-20T02:00:00.000Z')`,
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const winner = await startWorkItemAttempt(db, {
			orgId: "org",
			workItemId: "work",
			admissionId: "winner-admission",
			executor: { type: "tedi", id: "tedi" },
			expiresAt: "2026-08-20T02:00:00.000Z",
			startedAt: "2026-08-20T00:30:00.000Z",
		});
		await expect(
			startWorkItemAttempt(db, {
				orgId: "org",
				workItemId: "work",
				admissionId: "loser-admission",
				executor: { type: "tedi", id: "tedi" },
				expiresAt: "2026-08-20T02:00:00.000Z",
				startedAt: "2026-08-20T00:30:00.000Z",
			}),
		).rejects.toMatchObject({ code: "NOT_READY" });
		expect(
			sqlite
				.prepare("SELECT admission_id,runtime_state FROM work_attempts")
				.all(),
		).toEqual([{ admission_id: "winner-admission", runtime_state: "running" }]);
		expect(
			sqlite
				.prepare(
					"SELECT admission_id,state FROM work_resource_reservations ORDER BY admission_id",
				)
				.all(),
		).toEqual([
			{ admission_id: "loser-admission", state: "released" },
			{ admission_id: "winner-admission", state: "active" },
		]);
		expect(
			sqlite
				.prepare(
					"SELECT admission_id,state FROM work_budget_reservations ORDER BY admission_id",
				)
				.all(),
		).toEqual([
			{ admission_id: "loser-admission", state: "released" },
			{ admission_id: "winner-admission", state: "active" },
		]);
		expect(winner.attempt.admissionId).toBe("winner-admission");
	});

	it("normalizes historical composite attempt ids without losing provenance", () => {
		const guardIndex = migrations.findIndex((row) =>
			row.name.startsWith("20260821020828_"),
		);
		const sqlite = migrated(guardIndex);
		seedCore(sqlite);
		const compositeId = "work:checkout:agent:mcp:historical-execution-session";
		sqlite
			.prepare(
				`INSERT INTO work_attempts
				(id,work_item_id,org_id,executor_type,executor_id,runtime_state,outcome,
				 attempt_number,started_at,heartbeat_at,finished_at,metadata)
				VALUES (?,'work','org','tedi','tedi','finished','succeeded',1,
				 '2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z',
				 '2026-08-20T00:01:00.000Z','{}')`,
			)
			.run(compositeId);

		for (const row of migrations.slice(guardIndex)) sqlite.exec(row.sql);
		const attempt = sqlite
			.prepare(
				"SELECT id,metadata FROM work_attempts WHERE work_item_id='work'",
			)
			.get() as { id: string; metadata: string };
		expect(attempt.id).toMatch(/^40000000-0000-5000-8000-[0-9a-f]{12}$/);
		expect(JSON.parse(attempt.metadata)).toMatchObject({
			migratedCompositeAttemptId: compositeId,
		});
	});
});
