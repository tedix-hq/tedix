import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { kernelRequests, kernelRequestEvents } from "../schema/kernel-requests";
import {
	kernelRuntimeEvents,
	kernelConversationGrants,
} from "../schema/cognitive-runtime";
import { workItems, workAttempts } from "../schema/work-items";
import { organizationMembers } from "../schema/organization-members";
import {
	receiveKernelRequest,
	publishKernelRequestReport,
} from "./kernel-requests";
const now = "2026-10-17T10:00:00.000Z";
const scope = {
	id: "request-one",
	organizationId: "org-example",
	ownerUserId: "user-ada",
};
const snapshot = {
	state: "verifying" as const,
	workItemId: "work-one",
	attemptId: "attempt-one",
	briefRevision: 1,
	checks: [],
	acceptanceKey: "acceptance-one",
	observations: [],
	outcome: "verified" as const,
	delivery: {
		intentId: "intent-one",
		status: "pending" as const,
		receiptRef: null,
	},
	learning: null,
};
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			kernelRequests,
			kernelRequestEvents,
			kernelRuntimeEvents,
			kernelConversationGrants,
			workItems,
			workAttempts,
			organizationMembers,
		),
	);
	// schemaDdl omits partial predicates; restore the real active-Attempt uniqueness boundary.
	sqlite.exec(
		"DROP INDEX uniq_work_attempt_active; CREATE UNIQUE INDEX uniq_work_attempt_active ON work_attempts(org_id,work_item_id) WHERE runtime_state IN ('queued','running','waiting','retrying')",
	);
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100 }),
	);
	await db.insert(organizationMembers).values({
		id: "member-one",
		organizationId: scope.organizationId,
		descopeUserId: scope.ownerUserId,
		email: "ada@example.com",
		status: "active",
	});
	await db.insert(workItems).values({
		id: "work-one",
		orgId: scope.organizationId,
		title: "Example target",
		disposition: "completed",
		createdAt: now,
	});
	await db.insert(workAttempts).values({
		id: "attempt-one",
		orgId: scope.organizationId,
		workItemId: "work-one",
		executorType: "tedi",
		executorId: "tedi-example",
		attemptNumber: 1,
		runtimeState: "finished",
		outcome: "succeeded",
		startedAt: now,
		heartbeatAt: now,
		finishedAt: now,
	});
	await receiveKernelRequest(db, {
		...scope,
		sourceKind: "home",
		sourceId: "run-one",
		conversationId: "home-one",
		snapshot,
		nextOwner: "kernel",
		nextAction: "deliver_report",
		nextDueAt: now,
		lastEventId: "request-event",
		createdAt: now,
		updatedAt: now,
	});
	const input = {
		...scope,
		expectedVersion: 1,
		acceptanceKey: "acceptance-one",
		attemptId: "attempt-one",
		workItemId: "work-one",
		intentId: "intent-one",
		conversationId: "home-one",
		runId: "run-one",
		messageId: "message-one",
		payload: {
			role: "assistant",
			content: "Verified",
			metadata: { requestId: scope.id },
		},
		now,
	};
	return { db, input };
}
describe("atomic request report publication", () => {
	it("publishes once and returns the same source acknowledgment on replay", async () => {
		const { db, input } = await fixture();
		expect((await publishKernelRequestReport(db, input))?.id).toBe(
			"intent-one",
		);
		expect((await publishKernelRequestReport(db, input))?.id).toBe(
			"intent-one",
		);
		expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(1);
	});
	it("refuses a newly admitted successor even before the request binding catches up", async () => {
		const { db, input } = await fixture();
		await db.insert(workAttempts).values({
			id: "attempt-two",
			orgId: scope.organizationId,
			workItemId: "work-one",
			executorType: "tedi",
			executorId: "tedi-example",
			attemptNumber: 2,
			startedAt: now,
			heartbeatAt: now,
		});
		expect(await publishKernelRequestReport(db, input)).toBeUndefined();
	});
	it("refuses cancellation, revoked source membership, conversation ACL changes and stale CAS", async () => {
		for (const fault of [
			"cancel",
			"membership",
			"conversation",
			"version",
		] as const) {
			const { db, input } = await fixture();
			if (fault === "cancel")
				await db
					.update(workItems)
					.set({ disposition: "cancelled" })
					.where(eq(workItems.id, "work-one"));
			if (fault === "membership")
				await db
					.update(organizationMembers)
					.set({ status: "deactivated" })
					.where(eq(organizationMembers.id, "member-one"));
			if (fault === "conversation")
				await db.insert(kernelConversationGrants).values({
					id: "grant-one",
					organizationId: scope.organizationId,
					conversationId: "home-one",
					granteeDescopeUserId: "user-other",
					access: "owner",
				});
			if (fault === "version")
				await db
					.update(kernelRequests)
					.set({ version: 2 })
					.where(eq(kernelRequests.id, scope.id));
			expect(await publishKernelRequestReport(db, input)).toBeUndefined();
			expect(await db.select().from(kernelRuntimeEvents)).toHaveLength(0);
		}
	});
});
