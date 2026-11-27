import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { DatabaseSync } from "node:sqlite";
import { schemaDdl } from "../../test/schema-ddl";
import { tedis } from "../../schema/tedis";
import { organizationMembers } from "../../schema/organization-members";
import { memoryFacts } from "../../schema/memory-graph";
import {
	workItems,
	workEvents,
	workAttempts,
	commitmentWakeOutbox,
} from "../../schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
} from "../../schema/work-factory";
import { tediApprovalRequests } from "../../schema/approvals";
import { osGadgetExecutions } from "../../schema/os-workspaces";
import { skillRuns } from "../../schema/cognitive";
import { projects } from "../../schema/projects";
import {
	platformCronCheckpoints,
	platformCronExecutions,
} from "../../schema/platform-cron-executions";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	advanceCommitmentWakeCheckpoint,
	advanceCommitmentWakeCursor,
	getCommitmentFollowupTarget,
	getCommitmentWakeCursor,
	listCommitmentChanges,
	listCommitmentWakeRetryPages,
	listDueCommitmentWakes,
	recordCommitmentFollowupAttention,
	recordCommitmentWakeProgress,
	retainCommitmentWakeChanges,
	retainCommitmentWakePage,
} from "./commitment-changes";

const after = "2026-10-22T08:00:00.000Z";
const due = "2026-10-22T08:01:00.000Z";
const through = "2026-10-22T08:02:00.000Z";
const old = "2026-10-20T08:01:00.000Z";

// The wake scan's raw compound statements and JSON cursors run on both stores.
for (const store of ["d1", "postgres"] as const)
	describe(`commitment changes ${store}`, () => {
		let db: DbClient;
		let exec: (statement: string) => unknown;
		let close: () => unknown;
		beforeAll(async () => {
			if (store === "d1") {
				// Table shapes only: the writer triggers have their own coverage.
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					schemaDdl(
						tedis,
						organizationMembers,
						memoryFacts,
						projects,
						workItems,
						workEvents,
						workAttempts,
						workInteractions,
						workInteractionResponses,
						workApprovalProposals,
						workApprovalDecisions,
						tediApprovalRequests,
						osGadgetExecutions,
						skillRuns,
						platformCronCheckpoints,
						platformCronExecutions,
						commitmentWakeOutbox,
					),
				);
				sqlite.exec("PRAGMA foreign_keys = OFF");
				db = createDbClient(createD1Facade(sqlite));
				exec = (statement) => sqlite.exec(statement);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				// Table shapes only, as on D1: no writer triggers or foreign keys.
				await fixture.engine.exec("SET session_replication_role = replica");
				db = fixture.db;
				exec = (statement) => fixture.engine.exec(statement);
				close = fixture.close;
			}
			const resolves = store === "d1" ? "1" : "true";
			await exec(`
				INSERT INTO tedis(id,organization_id,name,slug,status,scope,owner_user_id)
				VALUES ('personal','org','Personal','personal','active','personal','human'),
					('builder','org','Builder','builder','active','organization',NULL);
				INSERT INTO organization_members(id,organization_id,user_id,descope_user_id,email,status)
				VALUES ('member','org','human','provider-user','human@example.test','active');
				INSERT INTO work_items(id,org_id,title,created_at,accepted_at,disposition,accountable_owner_type,accountable_owner_id,deadline)
				VALUES ('idle','org','Send proposal','${old}','${old}','accepted','user','human',NULL),
					('owned','org','Ship fix','${after}','${after}','accepted','tedi','builder',NULL),
					('late','org','Write report','${after}','${after}','accepted','tedi','builder','${due}');
				INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at)
				VALUES ('failed','org','owned','attempt.settled','external_agent','runner','{"outcome":"failed"}','${due}');
				INSERT INTO work_interactions(id,org_id,work_item_id,kind,status,subject,prompt,creator_type,creator_id,target_type,target_id,version,created_at)
				VALUES ('asked','org','owned','question','resolved','Pick','Pick one','tedi','builder','user','human',2,'${after}'),
					('stale','org',NULL,'question','open','Follow up: proposal','Ready?','tedi','personal','user','human',1,'${old}');
				INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,resolves_request,responded_at)
				VALUES ('answer','org','asked',1,'fence','user','human','Yes','answer',${resolves},'${due}');
				INSERT INTO memory_facts(id,organization_id,tedi_id,content,fact_type,metadata)
				VALUES ('promise','org','personal','I will send it','commitment','{"dueAt":"${due}"}');
			`);
		});
		afterAll(() => close());

		it("lists every change kind in byte order and pages by cursor", async () => {
			const changes = await listCommitmentChanges(
				db,
				after,
				through,
				"production",
			);
			expect(
				changes.map(({ key, kind, state, tediId }) => [
					key,
					kind,
					state,
					tediId,
				]),
			).toEqual([
				["idle:idle", "work", "idle", "personal"],
				["interaction-idle:stale", "interaction", "idle", "personal"],
				["interaction:answer", "interaction", "answered", "builder"],
				["memory:promise", "memory", "overdue", "personal"],
				[`overdue:late:${due}`, "work", "overdue", "builder"],
				["work:failed", "work", "failed", "builder"],
			]);
			const [first, ...rest] = changes;
			const page = await listCommitmentChanges(
				db,
				after,
				through,
				"production",
				{
					limit: 100,
					cursor: first!,
				},
			);
			expect(page).toEqual(rest);
			expect(
				await listCommitmentChanges(db, after, through, "production", {
					limit: 10,
					cursor: null,
					source: {
						orgId: "org",
						sourceKind: "work_event",
						sourceId: "failed",
						changeKey: "work:failed",
					},
				}),
			).toEqual([expect.objectContaining({ key: "work:failed" })]);
		});

		it("rechecks the interaction and records follow-up metadata once", async () => {
			const change = {
				key: "interaction-idle:stale",
				orgId: "org",
				tediId: "personal",
				slug: "personal",
				kind: "interaction" as const,
				objectId: "stale",
				state: "idle",
				changedAt: due,
			};
			expect(
				await getCommitmentFollowupTarget(db, change, through),
			).toMatchObject({ id: "stale", personId: "human", targetType: "user" });
			const attention = {
				orgId: "org",
				interactionId: "stale",
				commitmentKey: change.key,
				dedupeKey: "interaction-idle:stale",
				decisionClass: "personal.proposal.commitment" as const,
			};
			await recordCommitmentFollowupAttention(db, attention);
			await recordCommitmentFollowupAttention(db, attention);
			const [card] = await db.all<{ version: number; metadata: unknown }>(
				"SELECT version, metadata FROM work_interactions WHERE id = 'stale'",
			);
			const metadata =
				typeof card!.metadata === "string"
					? JSON.parse(card!.metadata)
					: card!.metadata;
			expect(Number(card!.version)).toBe(2);
			expect(metadata).toMatchObject({
				commitmentKey: change.key,
				dedupeKey: attention.dedupeKey,
				decisionClass: attention.decisionClass,
			});
		});

		it("moves JSON cursors forward only", async () => {
			const cursor = { changedAt: due, key: "b", tediId: "builder" };
			await advanceCommitmentWakeCheckpoint(db, after);
			await advanceCommitmentWakeCursor(db, after, cursor);
			await advanceCommitmentWakeCursor(db, after, { ...cursor, key: "a" });
			expect(await getCommitmentWakeCursor(db, after)).toEqual(cursor);
			await retainCommitmentWakePage(db, through, cursor);
			expect(await listCommitmentWakeRetryPages(db)).toEqual([
				expect.objectContaining({ through, cursor }),
			]);

			await retainCommitmentWakeChanges(db, [
				{
					key: "work:failed",
					orgId: "org",
					tediId: "builder",
					slug: "builder",
					kind: "work",
					objectId: "owned",
					state: "failed",
					changedAt: due,
				},
			]);
			const [row] = await listDueCommitmentWakes(db, through, "production");
			await recordCommitmentWakeProgress(db, row!, cursor, through);
			await recordCommitmentWakeProgress(
				db,
				row!,
				{ ...cursor, key: "a" },
				through,
			);
			const [moved] = await listDueCommitmentWakes(db, through, "production");
			expect(moved!.cursor).toEqual(cursor);
			await recordCommitmentWakeProgress(db, moved!, null, through);
			expect(await listDueCommitmentWakes(db, through, "production")).toEqual(
				[],
			);
		});
	});
