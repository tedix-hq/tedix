import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workApprovalDecisions,
	workApprovalProposals,
	workBudgetEnvelopes,
	workCaseItems,
	workResourceRequirements,
} from "../../schema/work-factory";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItemRelations,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { updateWorkItemSpecification } from "./crud";
import { deriveWorkItemReadiness } from "./readiness";

const ORG = "org-fictional";
const ITEM = "work-fictional";
const LATER = "2099-01-01T00:00:00.000Z";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workAttempts,
			workItemComments,
			workItemRelations,
			workApprovalProposals,
			workApprovalDecisions,
			workResourceRequirements,
			workBudgetEnvelopes,
			workCaseItems,
		),
	);
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,risk_level,work_class,purpose_exception_expires_at,admission_spec_revision,created_at,accepted_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
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
			JSON.stringify({ executor: "codex" }),
		);
	sqlite
		.prepare(
			"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at,resolved_at) VALUES('proposal',?,?,1,'risk:high','admission','{}','user','fictional-requester','user','fictional-cto','approved','Reviewed scope',?,?,?)",
		)
		.run(
			ORG,
			ITEM,
			LATER,
			"2026-10-20T00:00:00.000Z",
			"2026-10-20T00:00:00.000Z",
		);
	sqlite
		.prepare(
			"INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','proposal',1,'approved','user','fictional-cto','Reviewed scope','2026-10-20T00:00:00.000Z')",
		)
		.run();
	const db = createDbQueryClient(createD1Facade(sqlite));
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
	return { sqlite, update, readiness, boundVersion };
}

describe("approval freshness through lane planning", () => {
	it("approve, plan held then ready, and the approval still admits the unchanged scope", async () => {
		const { sqlite, update, readiness, boundVersion } = fixture();
		expect(await readiness()).toBe("ready");

		const held = await update({ laneDispatch: { state: "held" } });
		expect(held.version).toBe(2);
		expect(held.admissionSpecRevision).toBe("rev-approved");
		expect(boundVersion()).toBe(2);
		expect(await readiness()).toBe("ready");

		// Repeating the current executor is planning, not a reassignment.
		const ready = await update({
			executor: "codex",
			laneDispatch: { state: "ready" },
			riskLevel: "high",
		});
		expect(ready.version).toBe(3);
		expect(ready.admissionSpecRevision).toBe("rev-approved");
		expect(boundVersion()).toBe(3);
		expect(await readiness()).toBe("ready");
		sqlite.close();
	});

	it.each([
		["a reassignment", { executor: "claude-code" }],
		["a risk change", { riskLevel: "critical" as const }],
		["a capability change", { requiredCapabilities: ["deploy"] }],
		["an authority change", { requiredAuthorities: ["finance:approve"] }],
		["a brief change", { description: "A wider brief" }],
	])("planning with %s still invalidates the approval", async (_, change) => {
		const { sqlite, update, readiness, boundVersion } = fixture();
		const changed = await update({
			laneDispatch: { state: "ready" },
			...change,
		});
		expect(changed.version).toBe(2);
		expect(changed.admissionSpecRevision).not.toBe("rev-approved");
		expect(boundVersion()).toBe(1);
		expect(await readiness()).toBe("approval_blocked");
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
});
