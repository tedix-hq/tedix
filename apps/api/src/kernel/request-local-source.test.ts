import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	kernelRequests,
	kernelRequestEvents,
} from "@tedix/db/schema/kernel-requests";
import { agentSessionRequests } from "@tedix/db/schema/agent-session-requests";
import { workItems, workAttempts } from "@tedix/db/schema/work-items";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import { osOutputs, osWorkspaces } from "@tedix/db/schema/os-workspaces";
import {
	recordAgentSessionRequests,
	fileAgentSessionRequest,
	getAgentSessionRequest,
} from "@tedix/db/queries/agent-session-requests";
import { getKernelRequest } from "@tedix/db/queries/kernel-requests";
import type { BaseContext } from "../rpc/orpc";
import {
	captureLocalKernelRequests,
	bindLocalKernelRequest,
	reconcileLocalKernelRequest,
} from "./request-local-source";
import { readKernelRequestPolicy } from "./request-home-source";
vi.mock("@tedix/db/queries/kernel-runtime-support", () => ({
	getActivePolicyPackDefinition: async () => ({
		kernelRequestCoordinator: {
			version: 1,
			enabled: true,
			nextOwner: "kernel-example",
			retryMs: 1000,
			probeTimeoutMs: 1000,
			maxProbeAttempts: 3,
			runBudgetMs: 1000,
			repositoryTargets: [],
		},
	}),
}));
const now = "2026-10-17T10:00:00.000Z";
const owner = { organizationId: "org-example", userId: "user-ada" };
const session = {
	...owner,
	harness: "codex" as const,
	sessionKey: "session-one",
	sourceAt: now,
};
async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			kernelRequests,
			kernelRequestEvents,
			agentSessionRequests,
			workItems,
			workAttempts,
			organizationMembers,
			osOutputs,
			osWorkspaces,
		),
	);
	const db = createDbClient(createD1Facade(sqlite));
	const context = {
		db,
		env: {},
		authType: "user",
		user: { sub: owner.userId },
	} as BaseContext;
	await db.insert(organizationMembers).values({
		id: "member-one",
		organizationId: owner.organizationId,
		descopeUserId: owner.userId,
		email: "ada@example.com",
		status: "active",
	});
	await db.insert(osWorkspaces).values({
		id: "workspace-one",
		organizationId: owner.organizationId,
		name: "Example",
		visibility: "private",
		ownerUserId: owner.userId,
		createdByKind: "user",
		createdById: owner.userId,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(osOutputs).values({
		id: "output-one",
		organizationId: owner.organizationId,
		workspaceId: "workspace-one",
		kind: "document",
		title: "Example",
		currentRevisionId: "revision-one",
		createdByKind: "user",
		createdById: owner.userId,
		createdAt: now,
		updatedAt: now,
	});
	const [recorded] = await recordAgentSessionRequests(db, {
		...session,
		repository: "example/product",
		sourceKey: "event-one",
		requests: [{ kind: "request", text: "Private original source text" }],
		now,
	});
	const source = (await fileAgentSessionRequest(db, {
		...owner,
		id: recorded!.id,
		projectId: "project-one",
		now,
	}))!;
	await db.insert(workItems).values({
		id: "work-one",
		orgId: owner.organizationId,
		projectId: "project-one",
		title: "Authorized brief",
		disposition: "completed",
		createdAt: now,
	});
	await db.insert(workAttempts).values({
		id: "attempt-one",
		orgId: owner.organizationId,
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
	return { context, db, source };
}
describe("private local request adapter", () => {
	it("replays source capture without copying private text or exposing it to another owner", async () => {
		const { context, db, source } = await fixture();
		await captureLocalKernelRequests(context, session);
		await captureLocalKernelRequests(context, session);
		const rows = await db.select().from(kernelRequests);
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain(source.text);
		expect(
			await getKernelRequest(db, {
				organizationId: owner.organizationId,
				ownerUserId: "user-other",
				id: `agent:${source.id}`,
			}),
		).toBeUndefined();
		await expect(
			captureLocalKernelRequests(context, { ...session, userId: "user-other" }),
		).rejects.toThrow("owner mismatch");
	});
	it("verifies canonical Work and reports local chat delivery as unavailable", async () => {
		const { context, db, source } = await fixture();
		const bound = await bindLocalKernelRequest(context, source, "work-one", [
			{
				kind: "os_output_revision",
				outputId: "output-one",
				revisionId: "revision-one",
			},
		]);
		expect(bound.snapshot.workOrder).toMatchObject({
			workItemId: "work-one",
			workVersion: 1,
			goal: "Authorized brief",
			citations: ["work:work-one@1"],
			destination: { kind: "agent_session_request", sourceId: source.id },
		});
		expect(JSON.stringify(bound.snapshot)).not.toContain(source.text);
		const replay = await bindLocalKernelRequest(
			context,
			source,
			"work-one",
			[],
		);
		expect(replay.snapshot.workOrder).toEqual(bound.snapshot.workOrder);
		const row = await reconcileLocalKernelRequest(
			context,
			bound,
			(await readKernelRequestPolicy(context, owner.organizationId))!,
		);
		expect(row.snapshot).toMatchObject({
			state: "learned",
			outcome: "verified",
			delivery: { status: "unavailable" },
		});
		expect(
			(await getAgentSessionRequest(db, { ...owner, id: source.id }))?.evidence,
		).toContain("Originating chat delivery unavailable");
		expect(await db.select().from(workItems)).toHaveLength(1);
	});
	it("refuses cross-owner and wrong-project binding", async () => {
		const { context, source } = await fixture();
		await expect(
			bindLocalKernelRequest(
				context,
				{ ...source, userId: "user-other" },
				"work-one",
				[],
			),
		).rejects.toThrow("owner mismatch");
		await expect(
			bindLocalKernelRequest(
				context,
				{ ...source, projectId: "project-other" },
				"work-one",
				[],
			),
		).rejects.toThrow("share the same");
	});
});
