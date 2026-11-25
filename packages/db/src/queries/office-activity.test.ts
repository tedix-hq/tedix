import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
	type OfficeActivityRow,
	OfficeActivityRowSchema,
} from "@tedix/api-contract/schemas/office-activity";
import { createDbQueryClient } from "../query-client";
import { workItems, workAttempts, workEvents } from "../schema/work-items";
import { workAgentSessions } from "../schema/work-agent-sessions";
import { organizationMembers } from "../schema/organization-members";
import { organizations } from "../schema/organizations";
import {
	workInteractions,
	workInteractionResponses,
} from "../schema/work-factory";
import { userConfigs } from "../schema/user-configs";
import { createD1Facade } from "../test/d1-facade";

import {
	recordOfficeObservation,
	readOfficeObservations,
	pruneOfficeObservations,
	pruneExpiredOfficeSnapshots,
	officeReplyReference,
	readOfficeCanonicalSources,
} from "./office-activity";

async function fixture(store: "d1" | "postgres") {
	if (store === "d1") {
		const sqlite = createMigratedSqlite();
		return {
			db: createDbQueryClient(createD1Facade(sqlite)),
			close: () => sqlite.close(),
		};
	}
	const fixture = await createPGliteFacade();
	for (const migration of readMigrationFiles({
		migrationsFolder: fileURLToPath(
			new URL("../../drizzle-pg", import.meta.url),
		),
	}))
		for (const ddl of migration.sql) await fixture.engine.exec(ddl);
	return fixture;
}

describe.each(["d1", "postgres"] as const)(
	"private bounded Office history: %s",
	(store) => {
		it("atomically merges interleaved reports, deduplicates IDs, caps history and isolates owner/tenant", async () => {
			const { db, close } = await fixture(store);
			const owner = { organizationId: "example", userId: "ada" };
			const now = "2026-11-03T12:00:00.000Z";
			const row = OfficeActivityRowSchema.parse({
				id: crypto.randomUUID(),
				at: now,
				host: "codex",
				source: "hook",
				sessionKey: "codex:example",
				trigger: "Stop",
				reason: "reported",
				outcome: "observed",
				reporterVersion: "0.19.3",
				workItemId: null,
			});
			await recordOfficeObservation(db, owner, row, now);
			await recordOfficeObservation(db, owner, row, now);
			expect(await readOfficeObservations(db, owner)).toHaveLength(1);
			for (let i = 0; i < 210; i++)
				await recordOfficeObservation(
					db,
					owner,
					{ ...row, id: crypto.randomUUID(), sessionKey: `codex:example-${i}` },
					now,
				);
			expect(await readOfficeObservations(db, owner)).toHaveLength(150);
			expect(
				await readOfficeObservations(db, { ...owner, userId: "grace" }),
			).toEqual([]);
			expect(
				await readOfficeObservations(db, { ...owner, organizationId: "other" }),
			).toEqual([]);
			await recordOfficeObservation(
				db,
				{ ...owner, organizationId: "other" },
				row,
				now,
			);
			await pruneOfficeObservations(db, owner, "2026-11-05T12:00:00.000Z");
			expect(await readOfficeObservations(db, owner)).toEqual([]);
			expect(
				await readOfficeObservations(db, { ...owner, organizationId: "other" }),
			).toHaveLength(1);
			await db.insert(coreTable(db, userConfigs)).values({
				id: "preferences",
				userId: "ada",
				namespace: "other.preferences",
				key: "example",
				value: {},
				updatedAt: now,
			});
			expect(
				await pruneExpiredOfficeSnapshots(db, "2026-11-05T12:00:00.000Z"),
			).toBe(1);
			expect(
				await db
					.select({ id: coreTable(db, userConfigs).id })
					.from(coreTable(db, userConfigs))
					.where(eq(coreTable(db, userConfigs).namespace, "other.preferences")),
			).toEqual([{ id: "preferences" }]);
			await close();
		});

		it("combines repeated hook reports per session so supervisor and older rows stay visible", async () => {
			const { db, close } = await fixture(store);
			const owner = { organizationId: "example", userId: "ada" };
			const start = Date.parse("2026-11-03T00:00:00.000Z");
			const at = (minutes: number) =>
				new Date(start + minutes * 60_000).toISOString();
			const hook = (minutes: number, extra: Partial<OfficeActivityRow>) =>
				OfficeActivityRowSchema.parse({
					id: crypto.randomUUID(),
					at: at(minutes),
					host: "opencode",
					source: "hook",
					sessionKey: "opencode:ses_example",
					trigger: "PostToolUse",
					reportedState: "working",
					reason: "reported",
					outcome: "observed",
					reporterVersion: "0.19.3",
					workItemId: null,
					...extra,
				});
			const { reportedState: _state, ...base } = hook(1, {});
			const supervisor = OfficeActivityRowSchema.parse({
				...base,
				host: "codex",
				sessionKey: "codex:example",
				source: "supervisor",
				trigger: "reply_drain",
				reason: "delivery_confirmed",
				outcome: "success",
				requestId: crypto.randomUUID(),
				responseId: crypto.randomUUID(),
			});
			const older = hook(0, {
				host: "claude-code",
				sessionKey: "claude-code:older",
			});
			await recordOfficeObservation(db, owner, older, at(0));
			await recordOfficeObservation(db, owner, supervisor, at(1));
			// One busy OpenCode lane: permission and tool reports every few seconds.
			for (let i = 0; i < 60; i++)
				await recordOfficeObservation(
					db,
					owner,
					hook(2 + i / 20, {
						trigger: i % 2 ? "PostToolUse" : "PermissionRequest",
						occurrences: 2,
					}),
					at(2 + i / 20),
				);
			const merged = (await readOfficeObservations(
				db,
				owner,
			)) as OfficeActivityRow[];
			expect(merged.map((row) => row.id).slice(-2)).toEqual([
				supervisor.id,
				older.id,
			]);
			expect(merged.find((row) => row.id === supervisor.id)).toEqual(
				supervisor,
			);
			expect(
				merged
					.filter((row) => row.sessionKey === "opencode:ses_example")
					.map((row) => [row.trigger, row.occurrences, row.firstAt, row.at]),
			).toEqual([
				["PostToolUse", 60, at(2.05), at(2 + 59 / 20)],
				["PermissionRequest", 60, at(2), at(2 + 58 / 20)],
			]);
			// Many other sessions fill the hook share but cannot evict the supervisor.
			for (let i = 0; i < 160; i++)
				await recordOfficeObservation(
					db,
					owner,
					hook(20 + i / 60, { sessionKey: `opencode:ses_other${i}` }),
					at(20 + i / 60),
				);
			const rows = (await readOfficeObservations(
				db,
				owner,
			)) as OfficeActivityRow[];
			expect(rows.filter((row) => row.source === "hook")).toHaveLength(150);
			expect(rows.find((row) => row.id === supervisor.id)).toEqual(supervisor);
			await close();
		}, 60_000);
		it("reads only the owner's canonical reply receipts within the tenant and delivery window", async () => {
			const { db, close } = await fixture(store);
			const owner = {
				organizationId: "example",
				userId: "ada",
				descopeUserId: "descope-ada",
			};
			const at = "2026-11-25T00:00:00.000Z";
			try {
				await db.insert(coreTable(db, organizations)).values([
					{ id: "example", name: "Example", slug: "example" },
					{ id: "other", name: "Other", slug: "other" },
				]);
				await db.insert(coreTable(db, organizationMembers)).values([
					{
						id: "member-ada",
						organizationId: "example",
						userId: "ada",
						descopeUserId: "descope-ada",
						email: "ada@example.test",
					},
					{
						id: "member-other",
						organizationId: "other",
						userId: "ada",
						descopeUserId: "descope-ada",
						email: "ada@example.test",
					},
					{
						id: "member-someone",
						organizationId: "example",
						userId: "someone",
						descopeUserId: "descope-someone",
						email: "someone@example.test",
					},
				]);
				for (const [id, orgId, targetId, host, delivery] of [
					["mine", "example", "ada", "codex", "hook"],
					["hidden", "example", "ada", "codex", "none"],
					["someone", "example", "someone", "codex", "hook"],
					["tenant", "other", "ada", "codex", "hook"],
				] as const) {
					await db.insert(coreTable(db, workItems)).values({
						id: `work-${id}`,
						orgId,
						title: "Example",
						admissionSpecRevision: `spec-${id}`,
						createdAt: at,
						updatedAt: at,
					});
					await db.insert(coreTable(db, workInteractions)).values({
						id,
						orgId,
						workItemId: `work-${id}`,
						kind: "question",
						subject: "Question",
						prompt: "Reply",
						creatorType: "system",
						creatorId: "tedix",
						targetType: "user",
						targetId,
						createdAt: at,
						metadata: { sessionId: "session", host },
					});
					await db.insert(coreTable(db, workInteractionResponses)).values({
						id: `response-${id}`,
						orgId,
						interactionId: id,
						resolvedRequestVersion: 2,
						resolutionFence: "fence",
						responderType: "user",
						responderId: targetId,
						body: "private answer",
						responseKind: "answer",
						respondedAt: at,
						metadata: { delivery },
					});
				}
				expect(
					await officeReplyReference(db, owner, {
						sessionKey: "codex:session",
						host: "codex",
						requestId: "mine",
						responseId: "response-mine",
					}),
				).toEqual({ workItemId: "work-mine" });
				expect(
					await officeReplyReference(db, owner, {
						sessionKey: "codex:session",
						host: "claude-code",
						requestId: "mine",
						responseId: "response-mine",
					}),
				).toBeNull();
				expect(
					await officeReplyReference(db, owner, {
						sessionKey: "codex:session",
						host: "codex",
						requestId: "tenant",
						responseId: "response-tenant",
					}),
				).toBeNull();
				const sources = await readOfficeCanonicalSources(db, owner, at);
				expect(sources.replies).toMatchObject([
					{
						responseId: "response-mine",
						workItemId: "work-mine",
						sessionKey: "session",
						host: "codex",
					},
				]);
				expect(sources.replies).toHaveLength(1);
				expect(sources.events).toEqual([]);
				expect(
					(
						await readOfficeCanonicalSources(
							db,
							owner,
							"2026-11-26T00:00:00.000Z",
						)
					).replies,
				).toEqual([]);
			} finally {
				await close();
			}
		});
		it.skipIf(store !== "postgres")(
			"reads legacy and prefixed Attempt sessions without accepting another harness",
			async () => {
				const { db, close } = await fixture(store);
				const at = "2026-11-25T00:00:00.000Z";
				try {
					await db
						.insert(coreTable(db, organizations))
						.values({ id: "example", name: "Example", slug: "example" });
					await db.insert(coreTable(db, workAgentSessions)).values({
						id: "session",
						organizationId: "example",
						userId: "ada",
						harness: "codex",
						sessionKey: "session",
						state: "working",
						stateSince: at,
						lastEventAt: at,
					});
					for (const [id, externalSessionKey] of [
						["bare", "session"],
						["prefixed", "codex:session"],
						["wrong", "claude-code:session"],
					] as const) {
						await db.insert(coreTable(db, workItems)).values({
							id,
							orgId: "example",
							title: id,
							admissionSpecRevision: `spec-${id}`,
							createdAt: at,
							updatedAt: at,
						});
						await db.insert(coreTable(db, workAttempts)).values({
							id: `attempt-${id}`,
							orgId: "example",
							workItemId: id,
							executorType: "external_agent",
							executorId: "agent",
							executorSessionId: "executor-session",
							externalSessionKey,
							attemptNumber: 1,
							runtimeState: "finished",
							outcome: "succeeded",
							startedAt: at,
							heartbeatAt: at,
							finishedAt: at,
							summary: "done",
						});
						await db.insert(coreTable(db, workEvents)).values({
							id: `event-${id}`,
							orgId: "example",
							workItemId: id,
							eventType: "work.completed",
							actorType: "system",
							actorId: "tedix",
							occurredAt: at,
						});
					}
					const sources = await readOfficeCanonicalSources(
						db,
						{
							organizationId: "example",
							userId: "ada",
							descopeUserId: "descope-ada",
						},
						at,
					);
					expect(
						sources.events.map((row) => [
							row.workItemId,
							row.attemptId,
							row.resultRecorded,
						]),
					).toEqual([
						["prefixed", "attempt-prefixed", true],
						["bare", "attempt-bare", true],
					]);
				} finally {
					await close();
				}
			},
		);
	},
);
