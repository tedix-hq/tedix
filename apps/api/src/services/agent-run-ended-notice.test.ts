import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { canonicalWorkFactoryDdl } from "@tedix/db/test/schema-ddl";
import { workAttempts } from "@tedix/db/schema/work-items";
import { createWorkItem } from "@tedix/db/queries/work-items/crud";
import type { BaseContext } from "../rpc/orpc";
import {
	agentRunEndedHomeMessage,
	agentRunEndedMessage,
	notifyAgentRunEnded,
} from "./agent-run-ended-notice";

const workItemId = "11111111-1111-4111-8111-111111111111";
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});

async function fixture({
	sourceSessionKey = "agent:main:chat-1" as string | null,
	outcome = "succeeded" as "succeeded" | "failed" | "cancelled" | "rejected",
	executorType = "external_agent" as "external_agent" | "tedi",
	steward = true,
	summary = "Changed the label.\nTests pass." as string | null,
} = {}) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(canonicalWorkFactoryDdl());
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Org','org')",
	);
	const db = createDbClient(createD1Facade(sqlite));
	const now = new Date().toISOString();
	const work = await createWorkItem(db, {
		id: workItemId,
		orgId: "org",
		title: "Rename the button",
		sourceSessionKey: sourceSessionKey ?? undefined,
		...(steward ? { stewardType: "tedi" as const, stewardId: "tedi-1" } : {}),
		createdAt: now,
	});
	const [attempt] = await db
		.insert(workAttempts)
		.values({
			id: "attempt-1",
			orgId: "org",
			workItemId,
			executorType,
			executorId: "codex",
			attemptNumber: 1,
			runtimeState: outcome === "succeeded" ? "finished" : "failed",
			outcome,
			summary,
			startedAt: now,
			heartbeatAt: now,
			finishedAt: now,
		})
		.returning();
	const context = {
		db,
		organizationId: "org",
		authType: "oidc",
		userId: "runner-owner",
		headers: new Headers(),
	} as BaseContext;
	const enqueue = vi.fn(async () => ({ status: "queued" }));
	return { db, work, attempt: attempt!, context, enqueue };
}

describe("agent run ended notice", () => {
	it.each([
		["succeeded", "succeeded"],
		["failed", "failed"],
		["cancelled", "cancelled"],
		["rejected", "failed"],
	] as const)(
		"tells the tedi's chat that the run %s",
		async (outcome, word) => {
			const { work, attempt, context, enqueue } = await fixture({ outcome });
			await expect(
				notifyAgentRunEnded(context, work, attempt, enqueue),
			).resolves.toBe("sent");
			expect(enqueue).toHaveBeenCalledTimes(1);
			const [sentContext, message] = enqueue.mock.calls[0] as unknown as [
				BaseContext,
				unknown,
			];
			expect(message).toEqual({
				tediId: "tedi-1",
				conversationId: "agent:main:chat-1",
				idempotencyKey: "agent-run-ended:attempt-1",
				content: `The run for "Rename the button" ended: ${word}. Changed the label. Tests pass. Task: /work/items/${workItemId}`,
			});
			expect(sentContext).toMatchObject({
				authType: "service-binding",
				organizationId: "org",
			});
			expect(sentContext.userId).toBeUndefined();
		},
	);

	it("sends one message when the same Attempt is reported again", async () => {
		const { work, attempt, context, enqueue } = await fixture();
		await notifyAgentRunEnded(context, work, attempt, enqueue);
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue),
		).resolves.toBe("skipped");
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it.each([
		["no source conversation", { sourceSessionKey: null }],
		["a session that is not a tedi chat", { sourceSessionKey: "codex:abc" }],
		["no tedi steward", { steward: false }],
		["a tedi executor", { executorType: "tedi" as const }],
	])("sends nothing for Work with %s", async (_name, options) => {
		const { db, work, attempt, context, enqueue } = await fixture(options);
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue),
		).resolves.toBe("skipped");
		expect(enqueue).not.toHaveBeenCalled();
		const [row] = await db.select().from(workAttempts);
		expect(row!.metadata).toEqual({});
	});

	it.each([
		[
			"throws",
			async () => {
				throw new Error("runtime down");
			},
		],
		["is refused", async () => ({ status: "failed", error: "unreachable" })],
	])(
		"does not throw when the message %s, and a later report can send",
		async (_name, failing) => {
			vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const { work, attempt, context, enqueue } = await fixture();
			await expect(
				notifyAgentRunEnded(context, work, attempt, failing),
			).resolves.toBe("failed");
			await expect(
				notifyAgentRunEnded(context, work, attempt, enqueue),
			).resolves.toBe("sent");
		},
	);

	it("does not throw when the Attempt cannot be marked", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { work, attempt, context, enqueue } = await fixture();
		databases.pop()!.close();
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue),
		).resolves.toBe("failed");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("reports once to Home in the person's chat when a tedi picked there started the run", async () => {
		const { db, work, attempt, context, enqueue } = await fixture({
			sourceSessionKey: "home:os:chat-7",
		});
		const enqueueHome = vi.fn(async () => ({ status: "queued" }));
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue, enqueueHome),
		).resolves.toBe("sent");
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue, enqueueHome),
		).resolves.toBe("skipped");
		expect(enqueue).not.toHaveBeenCalled();
		expect(enqueueHome).toHaveBeenCalledTimes(1);
		const [sentContext, message] = enqueueHome.mock.calls[0] as unknown as [
			BaseContext,
			unknown,
		];
		expect(message).toEqual({
			organizationId: "org",
			conversationId: "home:os:chat-7",
			idempotencyKey: "agent-run-ended-attempt-1",
			content: `[System: an agent run that a tedi started from this chat has ended. Tell the person the result. Do not start new work.] The run for "Rename the button" ended: succeeded. Changed the label. Tests pass. Task: /work/items/${workItemId}`,
		});
		expect(sentContext).toMatchObject({
			authType: "service-binding",
			organizationId: "org",
		});
		expect(sentContext.userId).toBeUndefined();
		const [row] = await db.select().from(workAttempts);
		expect(row!.metadata).not.toEqual({});
	});

	it.each([
		["no tedi steward", { steward: false }],
		["a tedi executor", { executorType: "tedi" as const }],
	])(
		"sends nothing to the person's chat for Work with %s",
		async (_name, options) => {
			const { work, attempt, context, enqueue } = await fixture({
				sourceSessionKey: "home:os:chat-7",
				...options,
			});
			const enqueueHome = vi.fn(async () => ({ status: "queued" }));
			expect(agentRunEndedHomeMessage(work, attempt)).toBeNull();
			await expect(
				notifyAgentRunEnded(context, work, attempt, enqueue, enqueueHome),
			).resolves.toBe("skipped");
			expect(enqueueHome).not.toHaveBeenCalled();
		},
	);

	it("does not throw when Home refuses the message, and a later report can send", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const { work, attempt, context, enqueue } = await fixture({
			sourceSessionKey: "home:os:chat-7",
		});
		const enqueueHome = vi.fn(async () => ({ status: "queued" }));
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue, async () => {
				throw new Error("Access denied to Home conversation");
			}),
		).resolves.toBe("failed");
		await expect(
			notifyAgentRunEnded(context, work, attempt, enqueue, enqueueHome),
		).resolves.toBe("sent");
		expect(enqueue).not.toHaveBeenCalled();
	});

	it("keeps the note to 500 characters and leaves it out when empty", async () => {
		const { work, attempt } = await fixture();
		const long = agentRunEndedMessage(work, {
			...attempt,
			summary: "x".repeat(900),
		})!;
		expect(long.content).toBe(
			`The run for "Rename the button" ended: succeeded. ${"x".repeat(500)}. Task: /work/items/${workItemId}`,
		);
		expect(
			agentRunEndedMessage(work, { ...attempt, summary: null })!.content,
		).toBe(
			`The run for "Rename the button" ended: succeeded. Task: /work/items/${workItemId}`,
		);
	});
});
