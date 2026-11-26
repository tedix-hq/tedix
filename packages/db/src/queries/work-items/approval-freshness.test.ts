import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import {
	evaluateAndRecordWorkAdmission,
	replaceWorkAdmissionSpecification,
} from "./admissions";
import { getWorkItemById, updateWorkItemSpecification } from "./crud";
import {
	deriveWorkItemReadiness,
	listWorkItemReadinessProjection,
} from "./readiness";
import { listReadyWork } from "./scheduler";
import { startWorkItemAttempt } from "./attempts";
import { decideWorkApproval } from "./approvals";

const ORG = "org-fictional";
const ITEM = "work-fictional";
const LATER = "2099-01-01T00:00:00.000Z";

function fixture({ approve = true, expiresAt = LATER } = {}) {
	const sqlite = createMigratedSqlite();
	sqlite
		.prepare(
			"INSERT INTO organizations(id,name,slug) VALUES(?,'Fictional','fictional')",
		)
		.run(ORG);
	for (const user of ["fictional-requester", "fictional-cto"]) {
		sqlite
			.prepare("INSERT INTO users(id,email) VALUES(?,?)")
			.run(user, `${user}@example.com`);
		sqlite
			.prepare(
				"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,status) VALUES(?,?,?,?,?,'active')",
			)
			.run(user, ORG, user, user, `${user}@example.com`);
	}
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,risk_level,work_class,purpose_exception_expires_at,admission_spec_revision,created_at,accepted_at,executor_type,executor_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
		)
		.run(
			ITEM,
			ORG,
			"Fictional high-risk change",
			"accepted",
			"high",
			"maintenance",
			LATER,
			"rev-approved",
			"2026-10-20T00:00:00.000Z",
			"2026-10-20T00:00:00.000Z",
			"external_agent",
			"codex",
		);
	sqlite
		.prepare(
			"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,resolved_at) VALUES('proposal',?,?,1,'risk:high','admission','{}','user','fictional-requester','user','fictional-cto','pending','Reviewed scope',?,?,?)",
		)
		.run(
			ORG,
			ITEM,
			expiresAt,
			"2026-10-20T00:00:00.000Z",
			"2026-10-20T00:00:00.000Z",
		);
	if (approve)
		sqlite
			.prepare(
				"INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','proposal',2,'approved','user','fictional-cto','Reviewed scope','2026-10-20T00:00:00.000Z')",
			)
			.run();

	sqlite
		.prepare(
			"INSERT INTO tedis(id,organization_id,name,slug) VALUES('fictional-executor',?,'Executor','executor')",
		)
		.run(ORG);
	const facade = createD1Facade(sqlite);
	const race: { beforeBatch?: () => void } = {};
	const db = createDbQueryClient(
		new Proxy(facade, {
			get(target, key) {
				if (key !== "batch") return Reflect.get(target, key);
				return (statements: Parameters<typeof facade.batch>[0]) => {
					const beforeBatch = race.beforeBatch;
					delete race.beforeBatch;
					beforeBatch?.();
					return target.batch(statements);
				};
			},
		}),
	);
	const update = (
		changes: Omit<
			Parameters<typeof updateWorkItemSpecification>[1],
			"orgId" | "workItemId" | "actor"
		>,
	) =>
		updateWorkItemSpecification(db, {
			orgId: ORG,
			workItemId: ITEM,
			actor: { type: "system", id: "fictional-planner" },
			...changes,
		});
	const readiness = async () =>
		(
			await deriveWorkItemReadiness(db, {
				orgId: ORG,
				workItemId: ITEM,
				budgetAdmissible: true,
				resourcesAvailable: true,
			})
		).state;
	const boundVersion = () =>
		sqlite
			.prepare(
				"SELECT work_item_version AS v FROM work_approval_proposals WHERE id='proposal'",
			)
			.get()?.v;
	const admit = async () => {
		const item = (await getWorkItemById(db, ITEM, ORG))!;
		return evaluateAndRecordWorkAdmission(db, {
			id: crypto.randomUUID(),
			orgId: ORG,
			workItemId: ITEM,
			expectedWorkItemVersion: item.version,
			expectedAdmissionSpecRevision: item.admissionSpecRevision,
			executorType: "tedi",
			executorId: "fictional-executor",
			leaseTtlMs: 60000,
			now: "2026-11-16T12:00:00.000Z",
		});
	};
	return { db, sqlite, update, readiness, boundVersion, admit, race };
}

describe("approval freshness through lane planning", () => {
	it("planning held then ready leaves the approval bound to its reviewed version", async () => {
		const { db, sqlite, update, readiness, boundVersion, admit } = fixture();
		expect(await readiness()).toBe("ready");

		const held = await update({ laneDispatch: { state: "held" } });
		expect(held.version).toBe(2);
		expect(held.admissionSpecRevision).toBe("rev-approved");
		expect(boundVersion()).toBe(1);
		expect(await readiness()).toBe("ready");

		// Repeating the current executor is planning, not a reassignment.
		const ready = await update({
			executorReference: { type: "external_agent", id: "codex" },
			laneDispatch: { state: "ready" },
			riskLevel: "high",
		});
		expect(ready.version).toBe(3);
		expect(ready.admissionSpecRevision).toBe("rev-approved");
		expect(boundVersion()).toBe(1);
		expect(await readiness()).toBe("ready");
		const projection = await listWorkItemReadinessProjection(db, {
			orgId: ORG,
			observedAt: "2026-11-16T12:00:00.000Z",
		});
		expect(projection.data[0]?.readiness.state).toBe("ready");
		const scheduled = await listReadyWork(db, {
			orgId: ORG,
			executorType: "tedi",
			executorId: "fictional-executor",
			now: "2026-11-16T12:00:00.000Z",
		});
		expect(scheduled.data.map((row) => row.workItem.id)).toContain(ITEM);
		const admission = await admit();
		expect(admission.decision).toBe("admitted");
		const started = await startWorkItemAttempt(db, {
			orgId: ORG,
			workItemId: ITEM,
			admissionId: admission.id,
			executor: { type: "tedi", id: "fictional-executor" },
			expiresAt: admission.expiresAt,
			startedAt: "2026-11-16T12:00:00.000Z",
		});
		expect(started.attempt.runtimeState).toBe("running");
		sqlite.close();
	});

	it.each([
		[
			"a reassignment",
			{
				executorReference: {
					type: "external_agent" as const,
					id: "claude-code",
				},
			},
		],
		["a risk change", { riskLevel: "critical" as const }],
		["a capability change", { requiredCapabilities: ["deploy"] }],
		["an authority change", { requiredAuthorities: ["finance:approve"] }],
		["a brief change", { description: "A wider brief" }],
	])("planning with %s still invalidates the approval", async (_, change) => {
		const { sqlite, update, readiness, boundVersion, admit } = fixture();
		const changed = await update({
			laneDispatch: { state: "ready" },
			...change,
		});
		expect(changed.version).toBe(2);
		expect(changed.admissionSpecRevision).not.toBe("rev-approved");
		expect(boundVersion()).toBe(1);
		expect(await readiness()).toBe("approval_blocked");
		if ("requiredCapabilities" in change) {
			sqlite
				.prepare(
					"INSERT INTO org_capabilities(id,organization_id,slug,name,status,pace_layer,created_at) VALUES('deploy',?,'deploy','Deploy','active','record','2026-11-16T00:00:00.000Z')",
				)
				.run(ORG);
			sqlite
				.prepare(
					"INSERT INTO capability_links(id,organization_id,entity_kind,entity_id,capability_id,created_at) VALUES('link',?,'tedi','fictional-executor','deploy','2026-11-16T00:00:00.000Z')",
				)
				.run(ORG);
		}
		const admission = await admit();
		expect(admission.decision).toBe("rejected");
		expect(admission.rejectionCode).toBe("approval_blocked");
		expect(() =>
			sqlite.exec(
				`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at) SELECT 'raw-stale',org_id,id,version,admission_spec_revision,'tedi','fictional-executor','admitted','2026-11-16T12:00:00.000Z','2026-11-16T12:01:00.000Z','2026-11-16T12:00:00.000Z' FROM work_items WHERE id='work-fictional'`,
			),
		).toThrow("admission approval missing");
		sqlite.close();
	});

	it("a refused stale planning update carries nothing forward", async () => {
		const { sqlite, update, boundVersion } = fixture();
		await expect(
			update({ laneDispatch: { state: "held" }, expectedWorkItemVersion: 7 }),
		).rejects.toThrow();
		expect(boundVersion()).toBe(1);
		sqlite.close();
	});
	it("resource replacement invalidates approval and later planning cannot revive it", async () => {
		const { db, sqlite, update, readiness, admit } = fixture();
		await update({ laneDispatch: { state: "ready" } });
		sqlite
			.prepare(
				"INSERT INTO work_resource_pools(id,org_id,resource_key,allocation_mode,capacity,created_at) VALUES('pool',?,'browser','exclusive',1,'2026-11-16T00:00:00.000Z')",
			)
			.run(ORG);
		const item = (await getWorkItemById(db, ITEM, ORG))!;
		await replaceWorkAdmissionSpecification(db, {
			orgId: ORG,
			workItemId: ITEM,
			expectedWorkItemVersion: item.version,
			expectedAdmissionSpecRevision: item.admissionSpecRevision,
			specification: {
				resources: [{ resourceKey: "browser", quantity: 1 }],
				budget: null,
			},
			now: "2026-11-16T01:00:00.000Z",
		});
		await update({ laneDispatch: { state: "ready" } });
		expect(await readiness()).toBe("approval_blocked");
		expect((await admit()).rejectionCode).toBe("approval_blocked");
		sqlite.close();
	});

	it("a contract change without a revision rotation breaks the planning chain", async () => {
		const { sqlite, update, admit } = fixture();
		await update({ laneDispatch: { state: "ready" } });
		sqlite.exec(
			`UPDATE work_items SET acceptance_contract='{"version":1,"doneLooksLike":"Wider contract"}',version=version+1`,
		);
		await update({ laneDispatch: { state: "ready" } });
		expect((await admit()).rejectionCode).toBe("approval_blocked");
		sqlite.close();
	});

	it("stale planning after a substantive update cannot mint a continuity receipt", async () => {
		const { sqlite, update, admit } = fixture();
		await update({ description: "Wider scope" });
		await expect(
			update({ laneDispatch: { state: "ready" }, expectedWorkItemVersion: 1 }),
		).rejects.toThrow();
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_events WHERE json_extract(payload,'$.planningApproval') IS NOT NULL",
				)
				.get()?.n,
		).toBe(0);
		expect((await admit()).rejectionCode).toBe("approval_blocked");
		sqlite.close();
	});
	it("cannot resolve a pending admission proposal after planning changes its reviewed version", async () => {
		const { db, sqlite, update, admit } = fixture({ approve: false });
		await update({ laneDispatch: { state: "ready" } });
		await expect(
			decideWorkApproval(db, {
				id: "late-decision",
				orgId: ORG,
				proposalId: "proposal",
				expectedVersion: 1,
				decision: "approved",
				deciderType: "user",
				deciderId: "fictional-cto",
				rationale: "Stale version",
				now: "2026-11-16T11:00:00.000Z",
			}),
		).rejects.toThrow();
		expect(() =>
			sqlite.exec(
				"INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('raw-decision','proposal',2,'approved','user','fictional-cto','Stale version','2026-11-16T11:00:00.000Z')",
			),
		).toThrow("stale admission approval decision");
		expect((await admit()).rejectionCode).toBe("approval_blocked");
		sqlite.close();
	});

	it("does not extend an approval expiry through planning", async () => {
		const { sqlite, update, admit } = fixture({
			expiresAt: "2026-11-16T11:59:00.000Z",
		});
		await update({ laneDispatch: { state: "ready" } });
		expect((await admit()).rejectionCode).toBe("approval_blocked");
		sqlite.close();
	});

	it("preserves an approval issued between two planning updates", async () => {
		const { sqlite, update, admit } = fixture({ approve: false });
		await update({ laneDispatch: { state: "held" } });
		sqlite
			.prepare(
				"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at) VALUES('second',?,?,2,'risk:high','admission','{}','user','fictional-requester','user','fictional-cto','pending','Scope reviewed',?,'2026-11-16T10:00:00.000Z')",
			)
			.run(ORG, ITEM, LATER);
		sqlite.exec(
			"INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('second-decision','second',2,'approved','user','fictional-cto','Scope reviewed','2026-11-16T10:00:00.000Z')",
		);
		await update({ laneDispatch: { state: "ready" } });
		expect((await admit()).decision).toBe("admitted");
		sqlite.close();
	});
	it.each([undefined, 2])(
		"a planning writer losing its CAS cannot certify a peer's version (expected %s)",
		async (expectedWorkItemVersion) => {
			const { sqlite, update, admit, race } = fixture();
			race.beforeBatch = () =>
				sqlite.exec(
					"UPDATE work_items SET description='Peer widened scope',admission_spec_revision='peer-revision',version=2,updated_at='2026-11-16T11:00:00.000Z'",
				);
			await expect(
				update({ laneDispatch: { state: "ready" }, expectedWorkItemVersion }),
			).rejects.toThrow();
			expect(
				sqlite
					.prepare(
						"SELECT count(*) AS n FROM work_events WHERE json_extract(payload,'$.planningApproval') IS NOT NULL",
					)
					.get()?.n,
			).toBe(0);
			expect((await admit()).rejectionCode).toBe("approval_blocked");
			sqlite.close();
		},
	);
});
