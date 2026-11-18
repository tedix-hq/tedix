import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import {
	kernelConversations,
	kernelRuntimeRuns,
} from "@tedix/db/schema/cognitive-runtime";
import {
	saveConversationWorkspace,
	WorkspacePlacementError,
} from "./workspace-document-placement";
import type { DocumentTransfer } from "@tedix/db/queries/durable-sqlite/output-rpc";
const mocks = vi.hoisted(() => ({
	env: { WORKSPACE_RUNTIME: { outputQuery: vi.fn() } },
	transfer: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("./workspace-document-transfer", () => ({
	transferWorkspaceDocument: mocks.transfer,
}));
afterEach(() => vi.resetAllMocks());

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF;");
	// Deliberately no shared document or revision tables.
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			workspaceOutputIndex,
			kernelRuntimeRuns,
			kernelConversations,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		id: "source",
		organizationId: "org-test",
		name: "Source",
		visibility: "private",
		ownerUserId: "owner",
		createdByKind: "user",
		createdById: "owner",
	});
	await db.insert(kernelConversations).values({
		id: "conversation",
		organizationId: "org-test",
		conversationId: "chat",
		lastMessageAt: "now",
	});
	for (const [id, conversationId] of [
		["a", "chat"],
		["b", "chat"],
		["unrelated", "elsewhere"],
	]) {
		await db.insert(kernelRuntimeRuns).values({
			id: `run-${id}`,
			organizationId: "org-test",
			conversationId,
			outputRevisionId: `rev-${id}`,
		});
		await db.insert(workspaceOutputIndex).values({
			id: `${id}:1`,
			organizationId: "org-test",
			workspaceId: "source",
			outputId: id!,
			revision: 1,
			revisionId: `rev-${id}`,
			isCurrent: 1,
			outputKind: "document",
			title: id!,
			status: "active",
			outputCreatedByKind: "user",
			outputCreatedById: "owner",
			outputCreatedAt: "now",
			revisionCreatedByKind: "user",
			revisionCreatedById: "owner",
			revisionCreatedAt: "now",
			updatedAt: "now",
		});
	}
	const events: string[] = [];
	let plan: DocumentTransfer[] | undefined;
	mocks.env.WORKSPACE_RUNTIME.outputQuery.mockImplementation(
		async (scope, query) => {
			expect(
				(await db.select().from(osWorkspaces)).some(
					(row) => row.id === scope.workspaceId,
				),
			).toBe(true);
			events.push(query.op);
			if (query.op === "initialize") return "object";
			if (query.op === "placementPlan")
				return (plan ??= structuredClone(query.documents));
			return "object";
		},
	);
	const params = {
		workspace: {
			id: "target",
			organizationId: "org-test",
			name: "Target",
			visibility: "private" as const,
			ownerUserId: "owner",
			createdByKind: "user" as const,
			createdById: "owner",
		},
		conversationId: "chat",
		fromWorkspaceIds: ["source"],
	};
	return { sqlite, db, params, events };
}

it("initializes before transfer, keeps its plan after repointing, and links only after source removal", async () => {
	const f = await fixture();
	let fail = true;
	const removed = new Set<string>();
	mocks.transfer.mockImplementation(
		async (_db, _org, transfer: DocumentTransfer) => {
			expect(f.events.slice(0, 2)).toEqual(["initialize", "placementPlan"]);
			expect(
				(await f.db.select().from(kernelConversations))[0]?.workspaceId,
			).toBeNull();
			await f.db
				.update(workspaceOutputIndex)
				.set({ workspaceId: "target" })
				.where(eq(workspaceOutputIndex.outputId, transfer.outputId));
			if (transfer.outputId === "b" && fail) {
				fail = false;
				throw new Error("source removal unavailable");
			}
			removed.add(transfer.outputId);
		},
	);
	await expect(saveConversationWorkspace(f.db, f.params)).rejects.toMatchObject(
		{ retryable: true, movedOutputIds: ["a"], pendingOutputIds: ["b"] },
	);
	expect(
		(await f.db.select().from(kernelConversations))[0]?.workspaceId,
	).toBeNull();
	const saved = await saveConversationWorkspace(f.db, f.params);
	expect(saved.movedOutputIds).toEqual(["a", "b"]);
	expect(removed).toEqual(new Set(["a", "b"]));
	expect((await f.db.select().from(kernelConversations))[0]?.workspaceId).toBe(
		"target",
	);
	expect(await f.db.select().from(osWorkspaces)).toHaveLength(2);
	expect(
		(
			await f.db
				.select()
				.from(workspaceOutputIndex)
				.where(eq(workspaceOutputIndex.outputId, "unrelated"))
		)[0]?.workspaceId,
	).toBe("source");
	expect(mocks.transfer.mock.calls.map((call) => call[2].transferId)).toEqual([
		"save:chat:a",
		"save:chat:b",
		"save:chat:a",
		"save:chat:b",
	]);
	f.sqlite.close();
});
it("does not plan or transfer when destination initialization fails", async () => {
	const f = await fixture();
	mocks.env.WORKSPACE_RUNTIME.outputQuery.mockRejectedValue(
		new Error("init failed"),
	);
	await expect(saveConversationWorkspace(f.db, f.params)).rejects.toThrow(
		"init failed",
	);
	expect(mocks.transfer).not.toHaveBeenCalled();
	expect(
		(await f.db.select().from(kernelConversations))[0]?.workspaceId,
	).toBeNull();
	f.sqlite.close();
});
it("refuses to transfer from a private workspace owned by another member", async () => {
	const f = await fixture();
	await f.db
		.update(osWorkspaces)
		.set({ ownerUserId: "other" })
		.where(eq(osWorkspaces.id, "source"));
	await expect(
		saveConversationWorkspace(f.db, f.params),
	).rejects.toBeInstanceOf(WorkspacePlacementError);
	expect(mocks.transfer).not.toHaveBeenCalled();
	f.sqlite.close();
});
