import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import {
	kernelRuntimeRuns,
	kernelRuntimeEvents,
	kernelConversationGrants,
} from "@tedix/db/schema/cognitive-runtime";
import {
	runtimeSubmissions,
	runtimeSubmissionAttempts,
} from "@tedix/db/schema";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	getHomeKernelRequest,
	listKernelRequestEvents,
	receiveKernelRequest,
} from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import type { KernelRequestPolicy } from "@tedix/api-contract/schemas/kernel-request";
import { receivedKernelRequest } from "./request-coordinator";
import { reconcileNativeHomeRequest } from "./request-home-native";

const now = "2026-10-17T10:00:00.000Z";
const policy: KernelRequestPolicy = {
	version: 1,
	enabled: true,
	nextOwner: "kernel-example",
	retryMs: 1000,
	probeTimeoutMs: 1000,
	maxProbeAttempts: 3,
	runBudgetMs: 1000,
	repositoryTargets: [],
};
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			kernelRequests,
			kernelRequestEvents,
			kernelRuntimeRuns,
			kernelRuntimeEvents,
			kernelConversationGrants,
			runtimeSubmissions,
			runtimeSubmissionAttempts,
			organizationMembers,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const context = { db, env: {} } as BaseContext;
	await db.insert(organizationMembers).values({
		id: "member-one",
		organizationId: "org-example",
		descopeUserId: "user-ada",
		email: "ada@example.com",
		status: "active",
	});
	await db.insert(kernelRuntimeRuns).values({
		id: "run-one",
		organizationId: "org-example",
		conversationId: "home-one",
		status: "completed",
		outputMessageId: "answer-one",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(runtimeSubmissions).values({
		id: "submission-one",
		organizationId: "org-example",
		subjectKind: "kernel",
		subjectId: "kernel:org-example",
		sourceKind: "home",
		conversationId: "home-one",
		runId: "run-one",
		currentAttemptId: "attempt-one",
		attemptCount: 1,
		status: "settled",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(runtimeSubmissionAttempts).values({
		id: "attempt-one",
		organizationId: "org-example",
		submissionId: "submission-one",
		attemptNo: 1,
		status: "settled",
		startedAt: now,
	});
	await db.insert(kernelRuntimeEvents).values({
		id: "reply-one",
		organizationId: "org-example",
		conversationId: "home-one",
		runId: "run-one",
		messageId: "answer-one",
		kind: "message.completed",
		payload: { role: "assistant", content: "Here is the requested draft." },
		runtimeBackend: "custom",
		createdAt: now,
	});
	const row = (await receiveKernelRequest(db, {
		id: "home:run-one",
		organizationId: "org-example",
		ownerUserId: "user-ada",
		sourceKind: "home",
		sourceId: "run-one",
		conversationId: "home-one",
		snapshot: receivedKernelRequest(),
		nextOwner: policy.nextOwner,
		nextAction: "file_request",
		nextDueAt: now,
		lastEventId: "received",
		createdAt: now,
		updatedAt: now,
	}))!;
	return { db, context, row };
}
describe("native Home request acceptance", () => {
	it("uses the admitted Home attempt and original source reply through all states without inventing Work", async () => {
		const { db, context, row } = await fixture();
		const final = await reconcileNativeHomeRequest(context, row, policy);
		expect(final.snapshot).toMatchObject({
			state: "learned",
			workItemId: null,
			attemptId: "attempt-one",
			checks: [{ kind: "home_response" }],
			outcome: "verified",
			delivery: { status: "acknowledged", receiptRef: "reply-one" },
			learning: "no_new_lesson",
		});
		expect(final.snapshot.observations[0]?.limitations).toContain(
			"not factual correctness or external target state",
		);
		expect(final.nextDueAt).toBeNull();
		expect(
			(await listKernelRequestEvents(db, row)).map((e) => e.snapshot.state),
		).toEqual([
			"received",
			"filed",
			"briefed",
			"running",
			"verifying",
			"verifying",
			"verifying",
			"reported",
			"learned",
		]);
		await reconcileNativeHomeRequest(context, final, policy);
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(1);
	});
	it.each([
		"revoked",
		"private",
		"missing_reply",
		"wrong_message",
		"wrong_conversation",
		"old_reply",
		"wrong_attempt",
		"failed",
	])(
		"does not verify or acknowledge an unavailable source (%s)",
		async (mode) => {
			const { db, context, row } = await fixture();
			if (mode === "revoked")
				await db.update(organizationMembers).set({ status: "inactive" });
			if (mode === "private")
				await db.insert(kernelConversationGrants).values({
					id: "grant-one",
					organizationId: "org-example",
					conversationId: "home-one",
					granteeDescopeUserId: "user-other",
					access: "owner",
					createdAt: now,
				});
			if (mode === "missing_reply") await db.delete(kernelRuntimeEvents);
			if (mode === "wrong_message")
				await db.update(kernelRuntimeEvents).set({ messageId: "answer-other" });
			if (mode === "wrong_conversation")
				await db
					.update(kernelRuntimeEvents)
					.set({ conversationId: "home-other" });
			if (mode === "old_reply")
				await db
					.update(kernelRuntimeEvents)
					.set({ createdAt: "2026-10-17T09:59:00.000Z" });
			if (mode === "wrong_attempt")
				await db
					.update(runtimeSubmissions)
					.set({ currentAttemptId: "attempt-other" });
			if (mode === "failed") {
				await db.update(runtimeSubmissions).set({ status: "failed" });
				await db.update(runtimeSubmissionAttempts).set({ status: "failed" });
			}
			const final = await reconcileNativeHomeRequest(context, row, policy);
			expect(final.snapshot.outcome).not.toBe("verified");
			expect(final.snapshot.delivery).toBeNull();
			expect(final.nextDueAt).not.toBeNull();
		},
	);
	it("cancels from the canonical Home submission and preserves the original request", async () => {
		const { db, context, row } = await fixture();
		await db.update(runtimeSubmissions).set({ status: "canceled" });
		await db.update(runtimeSubmissionAttempts).set({ status: "canceled" });
		const final = await reconcileNativeHomeRequest(context, row, policy);
		expect(final.snapshot.state).toBe("cancelled");
		expect(final.nextDueAt).toBeNull();
		expect((await getHomeKernelRequest(db, "org-example", "run-one"))?.id).toBe(
			row.id,
		);
	});
});
