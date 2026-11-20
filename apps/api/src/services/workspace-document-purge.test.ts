import { DatabaseSync } from "node:sqlite";
import { expect, it, vi, onTestFinished } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osWorkspaces,
	osWorkspaceResources,
	osCollaborationProposals,
} from "@tedix/db/schema/os-workspaces";
import {
	osOutputs,
	osOutputRevisions,
} from "@tedix/db/tenant-store/outputs-schema";
import {
	osWorkspaceCollaborators,
	osWorkspaceAccessEdges,
	osWorkspaceShareLinks,
	osWorkspaceShareKeys,
} from "@tedix/db/schema/os-collaborators";
import { osShareLinks } from "@tedix/db/schema/os-shares";
import { providerInstallations } from "@tedix/db/schema/provider-installations";
import { auditEvents } from "@tedix/db/schema/audit-events";
import { userConfigs } from "@tedix/db/schema/user-configs";
import { workspaceOutputIndex } from "@tedix/db/schema/workspace-feed";
import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import { createWorkspaceDocumentOwner } from "./workspace-document-owner";
import { createOsOutput } from "./workspace-output-storage";
import {
	deleteWorkspaceWithDocuments,
	deleteOrganizationWorkspaceDocuments,
} from "./workspace-document-delete";
import { purgeArchivedOsItems } from "./os-archived-purge";
import { userContext } from "../rpc/routers/__tests__/os-workspaces-env";
import { createRouterClient } from "@orpc/server";
import { osWorkspacesContractRouter } from "../rpc/routers/os-workspaces";

function fixture() {
	const sql = new DatabaseSync(":memory:");
	sql.exec(
		"CREATE TABLE organizations(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org-1'), ('org-2');",
	);
	sql.exec(
		schemaDdl(
			osWorkspaces,
			osOutputs,
			osOutputRevisions,
			osWorkspaceResources,
			osCollaborationProposals,
			osWorkspaceCollaborators,
			osWorkspaceAccessEdges,
			osWorkspaceShareLinks,
			osWorkspaceShareKeys,
			osShareLinks,
			providerInstallations,
			auditEvents,
			userConfigs,
		),
	);
	const binding = createD1Facade(sql);
	const db = createDbQueryClient(binding);
	const store = workspaceOutputFixture(sql, { uninitialized: true });
	const context = userContext({
		env: { DB: binding } as CloudflareEnv,
		organizationId: "org-1",
	});
	const client = createRouterClient(osWorkspacesContractRouter, { context });
	onTestFinished(() => sql.close());
	async function seed(
		id: string,
		organizationId = "org-1",
		ownerUserId = "user-1",
	) {
		const workspace = await createWorkspaceDocumentOwner(db, {
			id,
			organizationId,
			name: id,
			status: "archived",
			visibility: "private",
			ownerUserId,
			createdByKind: "user",
			createdById: "user-1",
		});
		const scope = { organizationId, workspaceId: id };
		await createOsOutput(
			db,
			scope,
			{
				...scope,
				id: `doc-${id}`,
				kind: "document",
				title: id,
				currentRevisionId: `rev-${id}`,
				createdByKind: "user",
				createdById: "user-1",
			},
			{
				id: `rev-${id}`,
				organizationId,
				outputId: `doc-${id}`,
				revision: 1,
				content: "",
				bodyR2Key: "body",
				contentSha256: "abc",
				contentBytes: 1,
				createdByKind: "user",
				createdById: "user-1",
			},
		);
		await store.tenant.insert(osWorkspaceResources).values({
			id: `resource-${id}`,
			...scope,
			providerId: "example",
			connectionScope: "tenant",
			resourceType: "document",
			providerResourceId: id,
			name: id,
			createdByKind: "user",
			createdById: "user-1",
		});
		return workspace;
	}
	function ids(table: string) {
		return store.objectSql
			.prepare(`SELECT id FROM ${table} ORDER BY id`)
			.all()
			.map((row) => row.id);
	}
	return { ...store, db, sql, seed, ids, context, client };
}

it("permanent delete clears only the owning workspace's documents, revisions, resources and index", async () => {
	const f = fixture();
	const deletedId = "00000000-0000-4000-8000-000000000001";
	await f.seed(deletedId);
	await f.seed("keep");
	await f.seed("foreign", "org-2");
	const query = vi.spyOn(f.runtime, "outputQuery");
	await expect(
		f.client.workspaces.delete({ workspaceId: deletedId }),
	).resolves.toEqual({ deleted: true });
	expect(f.ids("os_outputs")).toEqual(["doc-foreign", "doc-keep"]);
	expect(f.ids("os_output_revisions")).toEqual(["rev-foreign", "rev-keep"]);
	expect(f.ids("os_workspace_resources")).toEqual([
		"resource-foreign",
		"resource-keep",
	]);
	expect(
		(await f.db.select().from(workspaceOutputIndex))
			.map((row) => row.workspaceId)
			.sort(),
	).toEqual(["foreign", "keep"]);
	expect(query.mock.calls.filter(([, op]) => op.op === "purge")).toEqual([
		[{ organizationId: "org-1", workspaceId: deletedId }, { op: "purge" }],
	]);
});

it("keeps the directory and index on object failure, and retries index cleanup after a committed purge", async () => {
	const f = fixture();
	const workspace = await f.seed("retry");
	const original = f.runtime.outputQuery.bind(f.runtime);
	let fail = true;
	vi.spyOn(f.runtime, "outputQuery").mockImplementation(
		async (scope, query) => {
			if (query.op === "purge" && fail) {
				fail = false;
				throw new Error("object unavailable");
			}
			return original(scope, query);
		},
	);
	await expect(deleteWorkspaceWithDocuments(f.db, workspace)).rejects.toThrow(
		"object unavailable",
	);
	expect(f.ids("os_outputs")).toEqual(["doc-retry"]);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(1);
	const batch = vi
		.spyOn(f.db, "batch")
		.mockRejectedValueOnce(new Error("index unavailable"));
	await expect(deleteWorkspaceWithDocuments(f.db, workspace)).rejects.toThrow(
		"index unavailable",
	);
	expect(f.ids("os_outputs")).toEqual([]);
	expect(await f.db.select().from(osWorkspaces)).toHaveLength(1);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(1);
	batch.mockRestore();
	expect(await deleteWorkspaceWithDocuments(f.db, workspace)).toBe(true);
	expect(await deleteWorkspaceWithDocuments(f.db, workspace)).toBe(false);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(0);
});

it("archiving keeps private documents and resources; preview keeps them; archived purge deletes them", async () => {
	const f = fixture();
	const privateId = "00000000-0000-4000-8000-000000000002";
	await f.seed(privateId);
	await f.client.workspaces.restore({ workspaceId: privateId });
	await f.client.workspaces.archive({ workspaceId: privateId });
	const query = vi.spyOn(f.runtime, "outputQuery");
	expect(f.ids("os_outputs")).toEqual([`doc-${privateId}`]);
	expect(f.ids("os_output_revisions")).toEqual([`rev-${privateId}`]);
	expect(f.ids("os_workspace_resources")).toEqual([`resource-${privateId}`]);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(1);
	const preview = await purgeArchivedOsItems(
		f.context,
		{ kinds: ["workspaces"], dryRun: true },
		{
			workspacePreferenceNamespace: "test",
			now: () => 0,
		},
	);
	expect(preview.workspaces).toMatchObject({ eligible: 1, deleted: 0 });
	expect(query.mock.calls.filter(([, op]) => op.op === "purge")).toHaveLength(
		0,
	);
	const result = await purgeArchivedOsItems(
		f.context,
		{ kinds: ["workspaces"], dryRun: false },
		{
			workspacePreferenceNamespace: "test",
			now: () => 0,
		},
	);
	expect(result.workspaces).toMatchObject({
		deleted: 1,
		skipped: 0,
		remaining: 0,
	});
	expect(f.ids("os_outputs")).toEqual([]);
	expect(f.ids("os_output_revisions")).toEqual([]);
	expect(f.ids("os_workspace_resources")).toEqual([]);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(0);
});

it("organization deletion retries serially across private owners and leaves other organizations intact", async () => {
	const f = fixture();
	await f.seed("a");
	await f.seed("b", "org-1", "other-owner");
	await f.seed("foreign", "org-2");
	const original = f.runtime.outputQuery.bind(f.runtime);
	const calls: string[] = [];
	let active = 0;
	let fail = true;
	vi.spyOn(f.runtime, "outputQuery").mockImplementation(
		async (scope, query) => {
			if (query.op !== "purge") return original(scope, query);
			expect(active++).toBe(0);
			try {
				calls.push(scope.workspaceId);
				if (scope.workspaceId === "b" && fail) {
					fail = false;
					throw new Error("object unavailable");
				}
				return await original(scope, query);
			} finally {
				active--;
			}
		},
	);
	await expect(
		deleteOrganizationWorkspaceDocuments(f.db, "org-1"),
	).rejects.toThrow("object unavailable");
	expect(calls).toEqual(["a", "b"]);
	expect(f.ids("os_outputs")).toEqual(["doc-b", "doc-foreign"]);
	await deleteOrganizationWorkspaceDocuments(f.db, "org-1");
	expect(calls).toEqual(["a", "b", "a", "b"]);
	expect(f.ids("os_outputs")).toEqual(["doc-foreign"]);
	expect(f.ids("os_output_revisions")).toEqual(["rev-foreign"]);
	expect(f.ids("os_workspace_resources")).toEqual(["resource-foreign"]);
	expect(
		(await f.db.select().from(workspaceOutputIndex)).map(
			(row) => row.workspaceId,
		),
	).toEqual(["foreign"]);
});

it("organization cleanup leaves shared authority data and index untouched", async () => {
	const f = fixture();
	await f.seed("shared");
	f.state.active = false;
	const query = vi.spyOn(f.runtime, "outputQuery");
	await deleteOrganizationWorkspaceDocuments(f.db, "org-1");
	expect(query.mock.calls.map(([, operation]) => operation.op)).toEqual([
		"authority",
	]);
	expect(f.ids("os_outputs")).toEqual(["doc-shared"]);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(1);
});

it("repeats the object purge when its successful response was lost", async () => {
	const f = fixture();
	const workspace = await f.seed("lost-reply");
	const original = f.runtime.outputQuery.bind(f.runtime);
	let fail = true;
	vi.spyOn(f.runtime, "outputQuery").mockImplementation(
		async (scope, query) => {
			const result = await original(scope, query);
			if (query.op === "purge" && fail) {
				fail = false;
				throw new Error("reply lost");
			}
			return result;
		},
	);
	await expect(deleteWorkspaceWithDocuments(f.db, workspace)).rejects.toThrow(
		"reply lost",
	);
	expect(f.ids("os_outputs")).toEqual([]);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(1);
	expect(await f.db.select().from(osWorkspaces)).toHaveLength(1);
	expect(await deleteWorkspaceWithDocuments(f.db, workspace)).toBe(true);
	expect(await f.db.select().from(workspaceOutputIndex)).toHaveLength(0);
});
