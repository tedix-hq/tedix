import { DatabaseSync } from "node:sqlite";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import {
	chatDispatchIdempotency,
	type KernelConversationOrigin,
	kernelConversationGrants,
	kernelConversationOriginOrHuman,
	kernelConversations,
	kernelHomeApprovalMirrors,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelToolResults,
	kernelWakeQueue,
} from "../schema/cognitive-runtime";
import { kernelConversationArtifactPins } from "../schema/conversation-artifact-pins";
import { kernelConversationCapabilities } from "../schema/conversation-capabilities";
import { harnessSubjectTraceBundles } from "../schema/harness-versions";
import { runtimeSubmissions } from "../schema/runtime-submissions";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	listKernelConversationPage,
	purgeKernelConversation,
	recordKernelConversationMessage,
} from "./kernel-conversations";

/**
 * The `origin` merge rule, against the strict D1 facade and DDL derived from
 * the production table.
 *
 * The rule is deliberately asymmetric and the SQL is a `CASE` the ORM cannot
 * typecheck, so it is proven behaviorally: `human` overwrites anything,
 * `agent` only lands where it cannot destroy information, and an unstamped
 * write touches nothing.
 */

const ORG = "org-1";
const DDL = `CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL);
${schemaDdl(kernelConversations)}`;

function realDb(): DbClient {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	// A second org exists so org-scoping can be proven, not assumed.
	sqlite.exec(`INSERT INTO organizations (id) VALUES ('${ORG}'), ('org-2');`);
	return createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
}

async function record(
	db: DbClient,
	input: { createdAt: string; origin?: KernelConversationOrigin | null },
): Promise<void> {
	await recordKernelConversationMessage(db, {
		organizationId: ORG,
		conversationId: "home:chat",
		channel: "home",
		createdAt: input.createdAt,
		provisionalTitle: null,
		origin: input.origin ?? null,
	});
}

async function readOrigin(db: DbClient): Promise<string | null> {
	const [row] = await listKernelConversationPage(db, {
		organizationId: ORG,
		cursor: null,
		limit: 10,
	});
	return row?.origin ?? null;
}

describe("recordKernelConversationMessage origin", () => {
	it("stamps the creating turn's origin", async () => {
		const db = realDb();
		await record(db, {
			createdAt: "2026-07-01T00:00:00.000Z",
			origin: "agent",
		});
		expect(await readOrigin(db)).toBe("agent");
	});

	it("writes nothing when the turn carries no stamp", async () => {
		const db = realDb();
		await record(db, { createdAt: "2026-07-01T00:00:00.000Z" });
		const origin = await readOrigin(db);
		expect(origin).toBeNull();
		// The whole point of leaving it NULL: it still reads as the operator's.
		expect(kernelConversationOriginOrHuman(origin)).toBe("human");
	});

	it("lets a human turn take over an agent-created conversation", async () => {
		const db = realDb();
		await record(db, {
			createdAt: "2026-07-01T00:00:00.000Z",
			origin: "agent",
		});
		await record(db, {
			createdAt: "2026-07-01T00:01:00.000Z",
			origin: "human",
		});
		expect(await readOrigin(db)).toBe("human");
	});

	it("does not let an agent turn take over a human conversation", async () => {
		const db = realDb();
		await record(db, {
			createdAt: "2026-07-01T00:00:00.000Z",
			origin: "human",
		});
		await record(db, {
			createdAt: "2026-07-01T00:01:00.000Z",
			origin: "agent",
		});
		expect(await readOrigin(db)).toBe("human");
	});

	it("does not stamp agent onto a row that already has unstamped history", async () => {
		const db = realDb();
		await record(db, { createdAt: "2026-07-01T00:00:00.000Z" });
		await record(db, {
			createdAt: "2026-07-01T00:01:00.000Z",
			origin: "agent",
		});
		expect(await readOrigin(db)).toBeNull();
	});

	it("leaves an existing stamp alone when a later turn carries none", async () => {
		const db = realDb();
		await record(db, {
			createdAt: "2026-07-01T00:00:00.000Z",
			origin: "agent",
		});
		await record(db, { createdAt: "2026-07-01T00:01:00.000Z" });
		expect(await readOrigin(db)).toBe("agent");
	});
});

describe("workspace conversation projection", () => {
	it("persists a Workspace association and scopes indexed pages to it", async () => {
		const db = realDb();
		await recordKernelConversationMessage(db, {
			organizationId: ORG,
			conversationId: "home:workspace",
			channel: "home",
			createdAt: "2026-07-01T00:00:00.000Z",
			provisionalTitle: null,
			workspaceId: "workspace-1",
			workpieceKind: "gadget",
			workpieceId: "gadget-1",
		});
		await recordKernelConversationMessage(db, {
			organizationId: ORG,
			conversationId: "home:global",
			channel: "home",
			createdAt: "2026-07-01T00:01:00.000Z",
			provisionalTitle: null,
		});
		const rows = await listKernelConversationPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 10,
			workspaceId: "workspace-1",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			conversationId: "home:workspace",
			workspaceId: "workspace-1",
			workpieceKind: "gadget",
			workpieceId: "gadget-1",
		});
	});
});

describe("purgeKernelConversation", () => {
	it("removes conversation-owned runtime state and retains only a content-free tombstone", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`PRAGMA foreign_keys = OFF;
CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE tedis (id TEXT PRIMARY KEY NOT NULL);
${schemaDdl(
	kernelConversations,
	kernelConversationArtifactPins,
	kernelConversationCapabilities,
	kernelConversationGrants,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelToolResults,
	kernelHomeApprovalMirrors,
	kernelWakeQueue,
	chatDispatchIdempotency,
	runtimeSubmissions,
	harnessSubjectTraceBundles,
)}`);
		sqlite.exec(`INSERT INTO organizations (id) VALUES ('${ORG}'), ('org-2');`);
		const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
		const conversationId = "home:purge-me";
		const otherConversationId = "home:keep";
		const createdAt = "2026-08-31T12:00:00.000Z";
		await db.insert(kernelConversations).values([
			{
				id: `${ORG}:${conversationId}`,
				organizationId: ORG,
				conversationId,
				title: "Sensitive title",
				lastMessageAt: createdAt,
				messageCount: 1,
			},
			{
				id: `${ORG}:${otherConversationId}`,
				organizationId: ORG,
				conversationId: otherConversationId,
				lastMessageAt: createdAt,
				messageCount: 1,
			},
		]);
		await db.insert(kernelRuntimeEvents).values([
			{
				id: "event-delete",
				organizationId: ORG,
				kind: "message.completed",
				conversationId,
				payload: { role: "user", content: "private" },
			},
			{
				id: "event-keep",
				organizationId: ORG,
				kind: "message.completed",
				conversationId: otherConversationId,
			},
		]);
		await db.insert(kernelRuntimeRuns).values({
			id: "run-delete",
			organizationId: ORG,
			conversationId,
			status: "completed",
		});
		await db.insert(runtimeSubmissions).values({
			id: "submission-delete",
			organizationId: ORG,
			subjectKind: "kernel",
			subjectId: `kernel:${ORG}`,
			conversationId,
			sourceKind: "home",
		});
		await db.insert(kernelToolResults).values({
			id: "result-delete",
			organizationId: ORG,
			conversationId,
			sourceKind: "direct_read",
			sourceId: "read-delete",
			objectKey: "home-tool-results/org/result-delete",
			sha256: "a".repeat(64),
			byteSize: 10,
			createdAt,
			expiresAt: "2026-09-01T12:00:00.000Z",
		});

		const deletedAt = "2026-08-31T12:30:00.000Z";
		const purged = await purgeKernelConversation(db, {
			organizationId: ORG,
			conversationId,
			deletedAt,
		});
		expect(purged.evictedToolResults).toEqual([
			expect.objectContaining({
				id: "result-delete",
				objectKey: "home-tool-results/org/result-delete",
				evictedAt: deletedAt,
			}),
		]);

		expect(
			await db
				.select()
				.from(kernelRuntimeEvents)
				.where(eq(kernelRuntimeEvents.organizationId, ORG)),
		).toEqual([expect.objectContaining({ id: "event-keep" })]);
		expect(await db.select().from(kernelRuntimeRuns)).toEqual([]);
		expect(await db.select().from(runtimeSubmissions)).toEqual([]);
		const [tombstone] = await db
			.select()
			.from(kernelConversations)
			.where(
				and(
					eq(kernelConversations.organizationId, ORG),
					eq(kernelConversations.conversationId, conversationId),
				),
			);
		expect(tombstone).toMatchObject({
			title: null,
			messageCount: 0,
			deletedAt,
		});
		await recordKernelConversationMessage(db, {
			organizationId: ORG,
			conversationId,
			channel: "home",
			createdAt: "2026-08-31T12:31:00.000Z",
			provisionalTitle: "Late private message",
		});
		const [afterLateFrame] = await db
			.select()
			.from(kernelConversations)
			.where(
				and(
					eq(kernelConversations.organizationId, ORG),
					eq(kernelConversations.conversationId, conversationId),
				),
			);
		expect(afterLateFrame).toMatchObject({
			title: null,
			messageCount: 0,
			deletedAt,
		});
		expect(
			await listKernelConversationPage(db, {
				organizationId: ORG,
				cursor: null,
				limit: 10,
				includeArchived: true,
			}),
		).toEqual([
			expect.objectContaining({ conversationId: otherConversationId }),
		]);
	});
});

/**
 * Sidebar hiding for CI marker-per-run smoke threads, which otherwise crowd out
 * operator conversations.
 */
describe("listKernelConversationPage hiddenPrefixes", () => {
	const SMOKE = "home:mcp-tasks-live-smoke-";

	async function seed(db: DbClient) {
		await db.insert(kernelConversations).values(
			Array.from({ length: 12 }, (_unused, index) => ({
				id: `${ORG}:conversation:${index}`,
				organizationId: ORG,
				conversationId:
					index % 2 === 0
						? `${SMOKE}${1000 + index}`
						: `home:real-${String(index).padStart(2, "0")}`,
				lastMessageAt: `2026-08-01T00:00:${String(index).padStart(2, "0")}.000Z`,
				messageCount: 2,
				createdAt: "2026-08-01T00:00:00.000Z",
				updatedAt: "2026-08-01T00:00:00.000Z",
			})),
		);
	}

	it("excludes hidden prefixes from the page", async () => {
		const db = realDb();
		await seed(db);
		const page = await listKernelConversationPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 50,
			hiddenPrefixes: [SMOKE],
		});
		expect(page).toHaveLength(6);
		expect(
			page.every((row) => row.conversationId.startsWith("home:real-")),
		).toBe(true);
	});

	it("still returns a FULL page when most rows are hidden", async () => {
		// The regression a JS-only post-filter would cause: SELECT LIMIT 4 takes 4
		// rows, drops the hidden ones, and hands back a short page.
		const db = realDb();
		await seed(db);
		const page = await listKernelConversationPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 4,
			hiddenPrefixes: [SMOKE],
		});
		expect(page).toHaveLength(4);
	});

	it("hides nothing when no prefixes are supplied", async () => {
		const db = realDb();
		await seed(db);
		const page = await listKernelConversationPage(db, {
			organizationId: ORG,
			cursor: null,
			limit: 50,
		});
		expect(page).toHaveLength(12);
	});
});
