import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { osWorkspaces } from "@tedix/db/schema/os-workspaces";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import type { DocumentTransfer } from "@tedix/db/queries/durable-sqlite/output-rpc";
import { deleteWorkspaceWithDocuments } from "./workspace-document-delete";
import { workspacePlacementId } from "./workspace-document-placement";
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
	sqlite.exec(
		schemaDdl(
			osWorkspaces,
			workspaceOutputIndex,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			userConfigs,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		id: "source",
		organizationId: "org-test",
		name: "Private",
		status: "archived",
		visibility: "private",
		ownerUserId: "owner",
		createdByKind: "user",
		createdById: "owner",
	});
	for (const kind of ["document", "sheet", "presentation"] as const) {
		await db.insert(workspaceOutputIndex).values({
			id: `${kind}:1`,
			organizationId: "org-test",
			workspaceId: "source",
			outputId: kind,
			revision: 1,
			revisionId: `rev-${kind}`,
			isCurrent: 1,
			outputKind: kind,
			title: kind,
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
	const workspace = (await getOsWorkspace(db, {
		organizationId: "org-test",
		workspaceId: "source",
	}))!;
	const retainedId = await workspacePlacementId(
		workspace.organizationId,
		`delete:${workspace.id}`,
	);
	const plan: DocumentTransfer[] = [];
	const events: string[] = [];
	mocks.env.WORKSPACE_RUNTIME.outputQuery.mockImplementation(
		async (scope, query) => {
			if (query.op === "authority") return "shared";
			expect(scope.workspaceId).toBe(retainedId);
			expect(await getOsWorkspace(db, scope)).toMatchObject({
				visibility: "private",
				ownerUserId: "owner",
			});
			events.push(query.op);
			if (query.op === "placementPlan") {
				for (const document of query.documents)
					if (!plan.some((saved) => saved.outputId === document.outputId))
						plan.push(structuredClone(document));
				return structuredClone(plan);
			}
			return "object";
		},
	);
	return { sqlite, db, workspace, retainedId, events };
}
it("retries source removal after the index moved and deletes only after all documents are removed", async () => {
	const f = await fixture();
	const removed = new Set<string>();
	let fail = true;
	mocks.transfer.mockImplementation(
		async (_db, _org, transfer: DocumentTransfer) => {
			expect(f.events.slice(0, 2)).toEqual(["initialize", "placementPlan"]);
			expect(
				await getOsWorkspace(f.db, {
					organizationId: "org-test",
					workspaceId: "source",
				}),
			).toBeDefined();
			await f.db
				.update(workspaceOutputIndex)
				.set({ workspaceId: f.retainedId })
				.where(eq(workspaceOutputIndex.outputId, transfer.outputId));
			if (transfer.outputId === "sheet" && fail) {
				fail = false;
				throw new Error("source removal failed");
			}
			removed.add(transfer.outputId);
		},
	);
	await expect(
		deleteWorkspaceWithDocuments(f.db, f.workspace),
	).rejects.toMatchObject({
		movedOutputIds: ["document", "presentation"],
		pendingOutputIds: ["sheet"],
		retryable: true,
	});
	expect(
		await getOsWorkspace(f.db, {
			organizationId: "org-test",
			workspaceId: "source",
		}),
	).toBeDefined();
	expect(
		(await f.db.select().from(workspaceOutputIndex)).every(
			(row) => row.workspaceId === f.retainedId,
		),
	).toBe(true);
	expect(await deleteWorkspaceWithDocuments(f.db, f.workspace)).toBe(true);
	expect(removed).toEqual(new Set(["document", "presentation", "sheet"]));
	expect(
		await getOsWorkspace(f.db, {
			organizationId: "org-test",
			workspaceId: "source",
		}),
	).toBeUndefined();
	expect(await f.db.select().from(osWorkspaces)).toHaveLength(1);
	expect(
		mocks.transfer.mock.calls
			.filter((call) => call[2].outputId === "sheet")
			.map((call) => call[2].transferId),
	).toEqual(["delete:source:sheet", "delete:source:sheet"]);
	f.sqlite.close();
});
it("retries initialization without duplicating the retained workspace", async () => {
	const f = await fixture();
	mocks.env.WORKSPACE_RUNTIME.outputQuery
		.mockResolvedValueOnce("shared")
		.mockRejectedValueOnce(new Error("initializer failed"));
	await expect(deleteWorkspaceWithDocuments(f.db, f.workspace)).rejects.toThrow(
		"initializer failed",
	);
	expect(mocks.transfer).not.toHaveBeenCalled();
	mocks.transfer.mockImplementation(
		async (_db, _org, transfer: DocumentTransfer) => {
			await f.db
				.update(workspaceOutputIndex)
				.set({ workspaceId: f.retainedId })
				.where(eq(workspaceOutputIndex.outputId, transfer.outputId));
		},
	);
	expect(await deleteWorkspaceWithDocuments(f.db, f.workspace)).toBe(true);
	expect(await f.db.select().from(osWorkspaces)).toHaveLength(1);
	f.sqlite.close();
});
it("refuses a retained destination whose private owner changed", async () => {
	const f = await fixture();
	await f.db.insert(osWorkspaces).values({
		id: f.retainedId,
		organizationId: "org-test",
		name: "Other",
		visibility: "private",
		ownerUserId: "someone-else",
		createdByKind: "user",
		createdById: "someone-else",
	});
	await expect(deleteWorkspaceWithDocuments(f.db, f.workspace)).rejects.toThrow(
		"owner boundary",
	);
	expect(mocks.transfer).not.toHaveBeenCalled();
	expect(
		mocks.env.WORKSPACE_RUNTIME.outputQuery,
	).toHaveBeenCalledExactlyOnceWith(
		{ organizationId: "org-test", workspaceId: "source" },
		{ op: "authority" },
	);
	expect(
		await getOsWorkspace(f.db, {
			organizationId: "org-test",
			workspaceId: "source",
		}),
	).toBeDefined();
	f.sqlite.close();
});
