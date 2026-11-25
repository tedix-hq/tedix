import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { createDbQueryClient, type DbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import { createPGliteFacade } from "../test/pglite-facade";
import { pgTableDdl } from "../test/pg-schema-ddl";
import { coreTable, createCoreStore } from "./client";
import {
	anyIds,
	jsonWrite,
	jsonRead,
	containsText,
	likeText,
	unixTime,
	coreStore,
} from "./dialect";
import { workItems, workItemComments, workEvents } from "../schema/work-items";
import { memoryFacts } from "../schema/memory-graph";
import { organizationMembers } from "../schema/organization-members";
import { learningImprovementProposals } from "../schema/learning-feedback";
import { hasProjectWorkItemReference } from "../queries/work-items/project-access";
import {
	listPersonalCardStyleRules,
	reviewPersonalCardStyleRule,
	getPersonalCardStyleRule,
	resolveCardStyleOwner,
	getPersonalCardStyleProposal,
} from "../queries/work-items/card-style-rules";
import {
	claimAgentReviewRetry,
	listAgentReviewsForTriage,
	recordAgentReviewTriageNotice,
} from "../queries/work-items/agent-review-triage";
import type { PgTable } from "drizzle-orm/pg-core";

const at = "2026-10-20T12:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbQueryClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			const tables = [
				workItems,
				workItemComments,
				workEvents,
				memoryFacts,
				organizationMembers,
				learningImprovementProposals,
			];
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					"CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE projects(id TEXT PRIMARY KEY); CREATE TABLE tedi_objectives(id TEXT PRIMARY KEY); CREATE TABLE work_attempts(id TEXT PRIMARY KEY); CREATE TABLE memory_domains(id TEXT PRIMARY KEY); CREATE TABLE tedis(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'),('other'); INSERT INTO projects VALUES ('project')",
				);
				for (const table of tables)
					for (const ddl of tableDdl(table)) sqlite.exec(ddl);
				sqlite.exec(
					"CREATE UNIQUE INDEX work_event_id_fixture ON work_events(id)",
				);
				db = createDbQueryClient(
					createD1Facade(sqlite, { maxBoundParams: 100 }),
				);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const table of tables)
					for (const ddl of pgTableDdl(
						coreTable(db, table) as unknown as PgTable,
					))
						await fixture.engine.exec(ddl).catch((error) => {
							throw new Error(ddl, { cause: error });
						});
			}
			await db.insert(coreTable(db, workItems)).values([
				{
					id: "review",
					orgId: "org",
					projectId: "project",
					title: "Review",
					workKind: "coding",
					metadata: { agentReview: true },
					createdAt: at,
					updatedAt: at,
				},
				{
					id: "foreign",
					orgId: "other",
					projectId: "project",
					title: "Other",
					workKind: "coding",
					metadata: { agentReview: true },
					createdAt: at,
					updatedAt: at,
				},
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("binds a large candidate set once and preserves organization/project scope", async () => {
			const ids = Array.from({ length: 300 }, (_, index) => `absent-${index}`);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "org",
					projectId: "project",
					ids: [...ids, "foreign"],
				}),
			).toBe(false);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "org",
					projectId: "project",
					ids: [...ids, "review"],
				}),
			).toBe(true);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "org",
					projectId: "wrong",
					ids: ["review"],
				}),
			).toBe(false);
			expect(
				await hasProjectWorkItemReference(db, {
					orgId: "org",
					projectId: "project",
					ids: [],
				}),
			).toBe(false);
		});
		it("filters and reviews private JSON style rules without crossing owners", async () => {
			const facts = coreTable(db, memoryFacts);
			for (const [id, org, owner] of [
				["mine", "org", "owner"],
				["theirs", "org", "someone"],
				["other", "other", "owner"],
			])
				await db.insert(facts).values({
					id: id!,
					organizationId: org!,
					content: "Style",
					factType: "preference",
					visibility: "private",
					reviewStatus: "confirmed",
					usePolicy: "can_use_as_instruction",
					metadata: {
						cardStyle: { version: 1 },
						learningFeed: { ownerUserId: owner! },
					},
					updatedAt: at,
				});
			expect(
				(await listPersonalCardStyleRules(db, "org", "owner")).map(
					(row) => row.id,
				),
			).toEqual(["mine"]);
			expect(
				await getPersonalCardStyleRule(db, "org", "someone", "mine"),
			).toBeNull();
			expect(
				await reviewPersonalCardStyleRule(db, "org", "owner", "theirs", false),
			).toBeNull();
			expect(
				(await reviewPersonalCardStyleRule(db, "org", "owner", "mine", false))
					?.reviewStatus,
			).toBe("rejected");
			expect(await listPersonalCardStyleRules(db, "org", "owner")).toEqual([]);
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "member",
				organizationId: "org",
				descopeUserId: "subject",
				userId: "person",
				email: "person@example.test",
			});
			expect(await resolveCardStyleOwner(db, "org", "person")).toBe("subject");
			expect(
				await getPersonalCardStyleProposal(db, "org", "owner", "missing"),
			).toBeNull();
		});
		it("runs ordered dependent writes once, reads JSON retries and rolls back a later failure", async () => {
			const claim = {
				orgId: "org",
				workItemId: "review",
				retry: 1,
				at,
				tickSlotId: "tick",
			};
			expect(await claimAgentReviewRetry(db, claim)).toBe(true);
			expect(await claimAgentReviewRetry(db, claim)).toBe(false);
			const rows = await listAgentReviewsForTriage(db, {
				orgId: "org",
				projectId: "project",
				leadTediId: "lead",
				maxRetries: 1,
				retryBefore: at,
				recentAfter: "2026-10-01",
				limit: 5,
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id: "review",
				createdAt: at,
				retries: 1,
				lastRetry: at,
			});
			await recordAgentReviewTriageNotice(db, {
				orgId: "org",
				workItemId: "review",
				state: "digest",
				projectId: "project",
				at,
			});
			const comments = coreTable(db, workItemComments);
			await expect(
				db.batch([
					db.insert(comments).values({
						id: "rollback",
						orgId: "org",
						workItemId: "review",
						authorType: "system",
						body: "Must roll back",
						createdAt: at,
					}),
					db.insert(comments).values({
						id: "tick",
						orgId: "org",
						workItemId: "review",
						authorType: "system",
						body: "Duplicate",
						createdAt: at,
					}),
				]),
			).rejects.toThrow();
			expect(
				await db.select().from(comments).where(eq(comments.id, "rollback")),
			).toEqual([]);
		});
		it("round trips bound text, JSON updates and array punctuation without executing parameter text", async () => {
			const comments = coreTable(db, workItemComments);
			const value = "quote'\\; -- $1 /* nested */ 雪";
			const [written] = await db.batch([
				db
					.insert(comments)
					.values({
						id: value,
						orgId: "org",
						workItemId: "review",
						authorType: "system",
						body: value,
						metadata: { value },
						createdAt: at,
					})
					.returning(),
			]);
			expect(written[0]?.metadata).toEqual({ value });
			expect(
				(
					await db.all<{ id: string }>(
						sql`SELECT id FROM ${comments} WHERE id = ${value}`,
					)
				)[0]?.id,
			).toBe(value);
			const [row] = await db
				.select()
				.from(comments)
				.where(anyIds(db, comments.id, [value, 'comma,{}"\\']));
			expect(row?.body).toBe(value);
			await db
				.update(comments)
				.set({
					metadata: jsonWrite(
						db,
						comments.metadata,
						["changed", "nested"],
						true,
					),
				})
				.where(eq(comments.id, value));
			const projected = await db
				.select({
					value: jsonRead(
						db,
						comments.metadata,
						["changed", "nested"],
						"boolean",
					),
				})
				.from(comments)
				.where(eq(comments.id, value));
			expect(Boolean(projected[0]?.value)).toBe(true);
			const [time] = await db
				.select({ epoch: unixTime(db, sql`${"2026-10-20T12:00:00.900Z"}`) })
				.from(comments)
				.limit(1);
			expect(Number(time?.epoch)).toBe(1792497600);
			await db
				.update(comments)
				.set({ metadata: { cardStyle: { version: "invalid" } } })
				.where(eq(comments.id, value));
			const [wrongType] = await db
				.select({
					number: jsonRead(
						db,
						comments.metadata,
						["cardStyle", "version"],
						"number",
					),
				})
				.from(comments)
				.where(eq(comments.id, value));
			expect(
				wrongType?.number === null || wrongType?.number === "invalid",
			).toBe(true);
			expect(
				await db
					.select({ id: comments.id })
					.from(comments)
					.where(containsText(db, comments.body, value)),
			).toHaveLength(1);
			expect(
				await db
					.select({ id: comments.id })
					.from(comments)
					.where(likeText(db, comments.body, "QUOTE%")),
			).toHaveLength(1);
		});
	});

it("defaults to D1 and refuses a Postgres selection without its binding", async () => {
	const sqlite = new DatabaseSync(":memory:");
	const env = { DB: createD1Facade(sqlite) };
	const store = createCoreStore(env);
	try {
		expect(coreStore(store.db)).toBe("d1");
		expect(await store.db.all(sql`SELECT 1 AS value`)).toEqual([{ value: 1 }]);
		expect(() => createCoreStore({ ...env, CORE_STORE: "postgres" })).toThrow(
			"requires CORE_HYPERDRIVE",
		);
	} finally {
		await store.close();
		sqlite.close();
	}
});
