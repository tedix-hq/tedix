import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { deriveWorkItemReadiness } from "@tedix/db/queries/work-items/readiness";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { policyPacks } from "@tedix/db/schema/control-plane";
import {
	workApprovalProposals,
	workApprovalDecisions,
	workResourceRequirements,
	workBudgetEnvelopes,
	workCaseItems,
} from "@tedix/db/schema/work-factory";
import {
	workItems,
	workEvents,
	workAttempts,
	workItemComments,
	workItemRelations,
} from "@tedix/db/schema/work-items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import type { BaseContext } from "../../orpc";

vi.mock("./policy-helpers", async (original) => ({
	...(await original<typeof import("./policy-helpers")>()),
	workItemStewardActor: vi.fn(async () => ({
		type: "user",
		id: "fictional-owner",
	})),
}));
import { updateSpecificationProcedure } from "./factory-lifecycle";

const ITEM = "11111111-1111-4111-8111-111111111111";
const ORG = "org-fictional";
const migration = readFileSync(
	new URL(
		"../../../../../../packages/db/drizzle/20260821020828_work_factory_external_session_fences/migration.sql",
		import.meta.url,
	),
	"utf8",
);

it.each([
	{ laneDispatch: { state: "ready" as const } },
	{ executor: "codex" as const },
	{ executor: "claude-code" as const },
])(
	"re-queues approved high-risk Work with immutable approval guards: %j",
	async (change) => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys=OFF");
			sqlite.exec(
				schemaDdl(
					organizationMembers,
					policyPacks,
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
					"INSERT INTO work_items(id,org_id,title,disposition,risk_level,work_class,purpose_exception_expires_at,admission_spec_revision,created_at,metadata) VALUES(?,?,?,'accepted','high','maintenance','2099-01-01T00:00:00.000Z','reviewed','2026-10-20T00:00:00.000Z',?)",
				)
				.run(
					ITEM,
					ORG,
					"Fictional change",
					JSON.stringify({
						executor: "codex",
						laneDispatch: { state: "held" },
					}),
				);
			sqlite
				.prepare(
					"INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,status,rationale,expires_at,created_at) VALUES('proposal',?,?,1,'risk:high','admission','{}','user','fictional-requester','user','fictional-approver','approved','Reviewed scope','2099-01-01T00:00:00.000Z','2026-10-20T00:00:00.000Z')",
				)
				.run(ORG, ITEM);
			sqlite.exec(
				"INSERT INTO work_approval_decisions(id,proposal_id,resolved_proposal_version,decision,decider_type,decider_id,rationale,decided_at) VALUES('decision','proposal',1,'approved','user','fictional-approver','Reviewed scope','2026-10-20T00:00:00.000Z')",
			);
			// Schema-derived DDL omits triggers; install the actual production guard.
			const guard = migration
				.split("--> statement-breakpoint")
				.find((sql) =>
					sql.includes("CREATE TRIGGER `work_approval_proposal_update_guard`"),
				);
			expect(guard).toBeDefined();
			sqlite.exec(guard!);
			const db = createDbQueryClient(createD1Facade(sqlite));
			const readiness = () =>
				deriveWorkItemReadiness(db, {
					orgId: ORG,
					workItemId: ITEM,
					budgetAdmissible: true,
					resourcesAvailable: true,
				});
			expect((await readiness()).state).toBe("ready");
			const update = () =>
				updateSpecificationProcedure["~orpc"].handler!({
					input: { id: ITEM, expectedWorkItemVersion: 1, ...change },
					context: { db, organizationId: ORG } as BaseContext,
					path: ["workItems", "updateSpecification"],
					procedure: updateSpecificationProcedure,
					signal: undefined,
					lastEventId: undefined,
				});
			const updated = await update();
			expect(updated.version).toBe(2);
			expect(updated.disposition).toBe("accepted");
			expect(updated.metadata?.laneDispatch).toEqual({ state: "ready" });
			expect(updated.metadata?.executor).toBe(change.executor ?? "codex");
			expect(
				sqlite
					.prepare(
						"SELECT work_item_version AS version, status FROM work_approval_proposals",
					)
					.get(),
			).toEqual({ version: 1, status: "approved" });
			expect((await readiness()).state).toBe("approval_blocked");
			expect(
				sqlite.prepare("SELECT id, body FROM work_item_comments").all(),
			).toEqual([
				{
					id: updated.metadata?.laneDispatchReceiptId,
					body: expect.stringContaining("Dispatched to "),
				},
			]);
			await expect(update()).rejects.toThrow("Work changed");
			expect((await getWorkItemById(db, ITEM, ORG))?.version).toBe(2);
			expect(
				sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
			).toBe(1);
		} finally {
			sqlite.close();
		}
	},
);
