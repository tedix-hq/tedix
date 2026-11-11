/**
 * Bulk purge of archived Tedix OS items (`purge_archived_os_items`): the
 * per-item delete rules hold, a dry run deletes nothing, and work proceeds in
 * bounded chunks that a later call resumes.
 */
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { auditEvents } from "@tedix/db/schema/audit-events";
import {
	chatDispatchIdempotency,
	kernelConversations,
	kernelHomeApprovalMirrors,
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelToolResults,
	kernelWakeQueue,
} from "@tedix/db/schema/cognitive-runtime";
import {
	kernelConversationArtifactPins,
	kernelConversationCapabilities,
	kernelConversationSessionPolicies,
} from "@tedix/db/schema";
import { harnessSubjectTraceBundles } from "@tedix/db/schema/harness-versions";
import { osShareLinks } from "@tedix/db/schema/os-shares";
import { osOutputs, osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { runtimeSubmissions } from "@tedix/db/schema/runtime-submissions";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { purgeArchivedOsItems } from "../../services/os-archived-purge";
import { osWorkspacesContractRouter } from "./os-workspaces";
import {
	apiKeyContext,
	createEnv,
	userContext,
} from "./__tests__/os-workspaces-env";

const ADMIN = ["settings:manage", "tedis:update"];

function setup() {
	const env = createEnv([
		kernelRuntimeEvents,
		kernelToolResults,
		kernelConversationArtifactPins,
		kernelConversationCapabilities,
		kernelConversationSessionPolicies,
		kernelHomeApprovalMirrors,
		kernelWakeQueue,
		chatDispatchIdempotency,
		runtimeSubmissions,
		harnessSubjectTraceBundles,
	]);
	const adminContext = () =>
		userContext({ env, organizationId: "org-1", permissions: ADMIN });
	return {
		env,
		db: createDbClient(env.DB),
		adminContext,
		admin: createRouterClient(osWorkspacesContractRouter, {
			context: adminContext(),
		}),
		osOnlyAdmin: createRouterClient(osWorkspacesContractRouter, {
			context: userContext({ env, organizationId: "org-1" }),
		}),
		org2: createRouterClient(osWorkspacesContractRouter, {
			context: userContext({
				env,
				organizationId: "org-2",
				permissions: ADMIN,
			}),
		}),
		machineAgent: createRouterClient(osWorkspacesContractRouter, {
			context: {
				...apiKeyContext({ env, organizationId: "org-1" }),
				externalAgentSessionId: "codex:session-1",
				externalAgentPrincipalId: "external-agent-1",
			},
		}),
	};
}

type Setup = ReturnType<typeof setup>;

async function seedConversation(
	t: Setup,
	conversationId: string,
	fields: Partial<typeof kernelConversations.$inferInsert> = {},
	organizationId = "org-1",
) {
	await t.db.insert(kernelConversations).values({
		id: `${organizationId}:${conversationId}`,
		organizationId,
		conversationId,
		title: `Chat ${conversationId}`,
		lastMessageAt: "2026-10-01T00:00:00.000Z",
		messageCount: 2,
		createdAt: "2026-10-01T00:00:00.000Z",
		updatedAt: "2026-10-01T00:00:00.000Z",
		...fields,
	});
	await t.db.insert(kernelRuntimeEvents).values({
		id: `event:${organizationId}:${conversationId}`,
		organizationId,
		kind: "message.received",
		conversationId,
		payload: { text: "hello" },
		createdAt: "2026-10-01T00:00:00.000Z",
	});
}

async function conversationRow(t: Setup, conversationId: string) {
	const [row] = await t.db
		.select()
		.from(kernelConversations)
		.where(
			and(
				eq(kernelConversations.organizationId, "org-1"),
				eq(kernelConversations.conversationId, conversationId),
			),
		);
	return row;
}

async function eventCount(t: Setup, conversationId: string) {
	return (
		await t.db
			.select()
			.from(kernelRuntimeEvents)
			.where(eq(kernelRuntimeEvents.conversationId, conversationId))
	).length;
}

async function archivedWorkspace(t: Setup, name: string) {
	const { workspace } = await t.admin.workspaces.create({ name });
	await t.admin.workspaces.archive({ workspaceId: workspace.id });
	return workspace;
}

async function archivedOutput(t: Setup, title: string, workspaceId?: string) {
	const { output } = await t.admin.outputs.create({
		kind: "document",
		title,
		...(workspaceId ? { workspaceId } : {}),
	});
	await t.admin.outputs.archive({ outputId: output.id });
	return output;
}

async function shareLink(
	t: Setup,
	resourceType: "workspace" | "output",
	resourceId: string,
	revokedAt: string | null = null,
) {
	await t.db.insert(osShareLinks).values({
		id: `share-${resourceId}-${revokedAt ? "revoked" : "live"}`,
		organizationId: "org-1",
		resourceType,
		resourceId,
		tokenHash: `hash-${resourceId}-${revokedAt}`,
		createdByKind: "user",
		createdById: "user-1",
		revokedAt,
	});
}

describe("purge_archived_os_items", () => {
	let t: Setup;
	beforeEach(() => {
		t = setup();
	});

	it("dry run reports what would go and deletes nothing", async () => {
		const workspace = await archivedWorkspace(t, "Old project");
		const output = await archivedOutput(t, "Old notes");
		await seedConversation(t, "chat-archived", {
			archivedAt: "2026-10-02T00:00:00.000Z",
		});

		const result = await t.admin.workspaces.purgeArchived({
			kinds: ["workspaces", "outputs", "conversations"],
		});

		expect(result).toMatchObject({
			dryRun: true,
			complete: true,
			stoppedBy: "finished",
			workspaces: { eligible: 1, deleted: 0, remaining: 0 },
			outputs: { eligible: 1, deleted: 0, remaining: 0 },
			conversations: { eligible: 1, deleted: 0, remaining: 0 },
		});
		expect(result.workspaces?.sampleIds).toEqual([workspace.id]);
		expect(result.outputs?.sampleIds).toEqual([output.id]);
		expect(result.conversations?.sampleIds).toEqual(["chat-archived"]);
		expect(await t.db.select().from(osWorkspaces)).toHaveLength(1);
		expect(await t.db.select().from(osOutputs)).toHaveLength(1);
		expect(await eventCount(t, "chat-archived")).toBe(1);
		expect((await conversationRow(t, "chat-archived"))?.title).toBe(
			"Chat chat-archived",
		);
	});

	it("preview reports eligible items and never deletes", async () => {
		const workspace = await archivedWorkspace(t, "Old project");
		const output = await archivedOutput(t, "Old notes");

		const result = await t.admin.workspaces.previewArchivedCleanup({
			kinds: ["workspaces", "outputs"],
		});

		expect(result).toMatchObject({
			dryRun: true,
			workspaces: { eligible: 1, deleted: 0 },
			outputs: { eligible: 1, deleted: 0 },
		});
		expect(result.workspaces?.sampleIds).toEqual([workspace.id]);
		expect(result.outputs?.sampleIds).toEqual([output.id]);
		expect(await t.db.select().from(osWorkspaces)).toHaveLength(1);
		expect(await t.db.select().from(osOutputs)).toHaveLength(1);
	});

	it("deletes archived workspaces and outputs but keeps active, shared and reviewed ones", async () => {
		const active = await t.admin.workspaces.create({ name: "Active" });
		const activeOutput = await t.admin.outputs.create({
			kind: "document",
			title: "Live doc",
		});
		const gone = await archivedWorkspace(t, "Gone");
		const shared = await archivedWorkspace(t, "Shared");
		await shareLink(t, "workspace", shared.id);
		const onceShared = await archivedWorkspace(t, "Once shared");
		await shareLink(t, "workspace", onceShared.id, "2026-10-01T00:00:00Z");

		const reviewed = await t.admin.workspaces.create({ name: "Reviewed" });
		const reviewedOutput = await t.admin.outputs.create({
			workspaceId: reviewed.workspace.id,
			kind: "document",
			title: "Reviewed draft",
			content: { kind: "document", blocks: [] },
		});
		await t.machineAgent.collaboration.create({
			workspaceId: reviewed.workspace.id,
			documentType: "output",
			documentId: reviewedOutput.output.id,
			sourceKind: "agent_session",
			sourceId: "codex:session-1",
			content: { kind: "document", blocks: [] },
		});
		await t.admin.outputs.archive({ outputId: reviewedOutput.output.id });
		await t.admin.workspaces.archive({ workspaceId: reviewed.workspace.id });

		const plainOutput = await archivedOutput(t, "Plain");
		const sharedOutput = await archivedOutput(t, "Shared file");
		await shareLink(t, "output", sharedOutput.id);
		const otherOrg = await t.org2.workspaces.create({ name: "Elsewhere" });
		await t.org2.workspaces.archive({ workspaceId: otherOrg.workspace.id });

		const result = await t.admin.workspaces.purgeArchived({
			kinds: ["workspaces", "outputs"],
			dryRun: false,
		});

		expect(result.workspaces).toMatchObject({
			examined: 4,
			deleted: 2,
			skipped: 2,
			skippedByReason: {
				active_share_links: 1,
				collaboration_history: 1,
			},
			remaining: 0,
		});
		expect(result.outputs).toMatchObject({
			examined: 3,
			deleted: 1,
			skippedByReason: {
				active_share_links: 1,
				collaboration_history: 1,
			},
		});
		const workspaceIds = (await t.db.select().from(osWorkspaces)).map(
			(row) => row.id,
		);
		expect(workspaceIds).toEqual(
			expect.arrayContaining([
				active.workspace.id,
				shared.id,
				reviewed.workspace.id,
				otherOrg.workspace.id,
			]),
		);
		expect(workspaceIds).not.toContain(gone.id);
		expect(workspaceIds).not.toContain(onceShared.id);
		const outputIds = (await t.db.select().from(osOutputs)).map(
			(row) => row.id,
		);
		expect(outputIds).toContain(activeOutput.output.id);
		expect(outputIds).toContain(sharedOutput.id);
		expect(outputIds).toContain(reviewedOutput.output.id);
		expect(outputIds).not.toContain(plainOutput.id);

		const receipts = await t.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.resourceId, gone.id));
		expect(receipts.map((row) => row.action)).toContain("os.workspace.deleted");
		const summary = await t.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.resourceId, result.purgeId));
		expect(summary.map((row) => row.action)).toEqual([
			"os.archived_items.purged",
		]);
	});

	it("purges archived conversations and leaves pinned, running and active ones", async () => {
		await seedConversation(t, "chat-archived", {
			archivedAt: "2026-10-02T00:00:00.000Z",
		});
		await seedConversation(t, "chat-soft-deleted", {
			deletedAt: "2026-10-02T00:00:00.000Z",
		});
		await seedConversation(t, "chat-pinned", {
			archivedAt: "2026-10-02T00:00:00.000Z",
			pinnedAt: "2026-10-03T00:00:00.000Z",
		});
		await seedConversation(t, "chat-running", {
			archivedAt: "2026-10-02T00:00:00.000Z",
		});
		await t.db.insert(kernelRuntimeRuns).values({
			id: "run-live",
			organizationId: "org-1",
			conversationId: "chat-running",
			status: "running",
			createdAt: "2026-10-04",
			updatedAt: "2026-10-04",
		});
		await seedConversation(t, "chat-active");
		await seedConversation(t, "chat-recent", {
			archivedAt: "2026-11-05T00:00:00.000Z",
		});

		const result = await t.admin.workspaces.purgeArchived({
			kinds: ["conversations"],
			archivedBefore: "2026-11-01T00:00:00Z",
			dryRun: false,
		});

		expect(result.conversations).toMatchObject({
			examined: 4,
			deleted: 2,
			skippedByReason: { pinned: 1, active_run: 1 },
			remaining: 0,
		});
		for (const purged of ["chat-archived", "chat-soft-deleted"]) {
			expect(await eventCount(t, purged)).toBe(0);
			expect(await conversationRow(t, purged)).toMatchObject({
				title: null,
				messageCount: 0,
				archivedAt: null,
				deletedAt: expect.any(String),
			});
		}
		for (const kept of [
			"chat-pinned",
			"chat-running",
			"chat-active",
			"chat-recent",
		])
			expect(await eventCount(t, kept)).toBe(1);

		// A purged tombstone is not a candidate again.
		const again = await t.admin.workspaces.purgeArchived({
			kinds: ["conversations"],
			archivedBefore: "2026-11-01T00:00:00Z",
		});
		expect(again.conversations).toMatchObject({ examined: 2, eligible: 0 });
		const receipts = await t.db
			.select()
			.from(auditEvents)
			.where(eq(auditEvents.action, "kernel.conversation.deleted"));
		expect(receipts.map((row) => row.resourceId).sort()).toEqual([
			"chat-archived",
			"chat-soft-deleted",
		]);
	});

	it("refuses conversations without the right to manage tedis", async () => {
		await expect(
			t.osOnlyAdmin.workspaces.purgeArchived({ kinds: ["conversations"] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("stops at the work budget and a later call finishes the job", async () => {
		for (let index = 0; index < 45; index++) {
			await seedConversation(t, `chat-${String(index).padStart(2, "0")}`, {
				archivedAt: "2026-10-02T00:00:00.000Z",
			});
		}
		const input = {
			kinds: ["conversations" as const],
			dryRun: false,
		};
		const first = await purgeArchivedOsItems(t.adminContext(), input, {
			workspacePreferenceNamespace: "tedix-os-workspaces:org-1",
			workBudget: 5,
		});
		expect(first).toMatchObject({
			complete: false,
			stoppedBy: "work_budget",
			conversations: { deleted: 40, remaining: 5 },
		});

		const second = await purgeArchivedOsItems(t.adminContext(), input, {
			workspacePreferenceNamespace: "tedix-os-workspaces:org-1",
		});
		expect(second).toMatchObject({
			complete: true,
			stoppedBy: "finished",
			conversations: { deleted: 5, remaining: 0 },
		});
		expect(await t.db.select().from(kernelRuntimeEvents)).toHaveLength(0);
	});

	it("stops at the time budget before touching anything", async () => {
		await archivedWorkspace(t, "Old");
		let clock = 0;
		const result = await purgeArchivedOsItems(
			t.adminContext(),
			{ kinds: ["workspaces"], dryRun: false },
			{
				workspacePreferenceNamespace: "tedix-os-workspaces:org-1",
				timeBudgetMs: 10,
				now: () => (clock += 20),
			},
		);
		expect(result).toMatchObject({
			complete: false,
			stoppedBy: "time_budget",
			workspaces: { examined: 0, deleted: 0, remaining: 1 },
		});
		expect(await t.db.select().from(osWorkspaces)).toHaveLength(1);
	});
});
