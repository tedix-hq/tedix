import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osGadgets,
	osWorkspaces,
	osOutputs,
	osOutputRevisions,
	osWorkspaceResources,
} from "@tedix/db/schema/os-workspaces";
import { listWorkspaceResourceSummaries } from "@tedix/db/queries/durable-sqlite/workspace-resources";
import { executeOutputQuery } from "@tedix/db/queries/durable-sqlite/output-rpc";
import { workspaceOutputFixture } from "../../test/workspace-output-fixture";
import { initializeWorkspaceDocumentOwner } from "./workspace-document-owner";
import * as storage from "./workspace-resource-storage";

const scope = { organizationId: "org-test", workspaceId: "workspace" };
const resource = {
	...scope,
	id: "resource",
	providerId: "example",
	connectionScope: "tenant" as const,
	requiredScopes: "[]",
	resourceType: "file",
	providerResourceId: "remote-file",
	name: "New file",
	createdByKind: "user" as const,
	createdById: "owner",
	createdAt: "2026-11-01",
	updatedAt: "2026-11-01",
};
const identity = { ...scope, resourceId: resource.id };
async function fixture(owned: boolean) {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osGadgets,
			osWorkspaces,
			osOutputs,
			osOutputRevisions,
			osWorkspaceResources,
		),
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	await db.insert(osWorkspaces).values({
		id: scope.workspaceId,
		organizationId: scope.organizationId,
		name: "Files",
		createdByKind: "user",
		createdById: "owner",
	});
	const object = workspaceOutputFixture(sqlite, { uninitialized: true });
	if (owned)
		await initializeWorkspaceDocumentOwner({
			organizationId: scope.organizationId,
			id: scope.workspaceId,
		});
	return { ...object, db, sqlite };
}

describe.each([true, false])(
	"workspace resource writer (object owner: %s)",
	(owned) => {
		it("links, renames, rebinds, removes and restores using the authoritative row", async () => {
			const f = await fixture(owned);
			let row = await storage.createOsWorkspaceResource(f.db, resource);
			const check = () => {
				const shared = f.sqlite
					.prepare(
						"SELECT name, status, metadata, connection_scope FROM os_workspace_resources",
					)
					.get();
				const local = f.objectSql
					.prepare(
						"SELECT name, status, metadata, connection_scope FROM os_workspace_resources",
					)
					.get();
				if (owned) expect(local).toEqual(shared);
				else expect(local).toBeUndefined();
			};
			check();
			row = (await storage.renameOsWorkspaceResource(f.db, {
				...identity,
				expectedUpdatedAt: row.updatedAt,
				name: "Renamed",
				slot: "source",
				now: "2026-11-02",
			}))!;
			expect(row.name).toBe("Renamed");
			check();
			expect(
				await storage.removeOsWorkspaceResource(f.db, {
					...identity,
					expectedUpdatedAt: "stale",
					now: "2026-11-03",
				}),
			).toBeUndefined();
			row = (await storage.rebindOsWorkspaceResource(f.db, {
				...identity,
				expectedUpdatedAt: row.updatedAt,
				connectionScope: "user",
				personalOwnerUserId: "owner",
				connectionInstanceId: "account",
				requiredScopes: '["read"]',
				now: "2026-11-03",
			}))!;
			expect(row.connectionInstanceId).toBe("account");
			check();
			row = (await storage.updateOsWorkspaceResourceMetadata(f.db, {
				...identity,
				expectedUpdatedAt: row.updatedAt,
				metadata: '{"label":"updated"}',
				now: "2026-11-04",
			}))!;
			check();
			row = (await storage.removeOsWorkspaceResource(f.db, {
				...identity,
				expectedUpdatedAt: row.updatedAt,
				now: "2026-11-05",
			}))!;
			expect(row.status).toBe("removed");
			check();
			expect(listWorkspaceResourceSummaries(f.tenant, scope)).toEqual([]);
			row = (await storage.restoreOsWorkspaceResource(f.db, {
				...identity,
				now: "2026-11-06",
			}))!;
			expect(row.status).toBe("active");
			check();
			expect(listWorkspaceResourceSummaries(f.tenant, scope)).toHaveLength(
				owned ? 1 : 0,
			);
		});
		it("confirms the same file concurrently without duplicate resources", async () => {
			const f = await fixture(owned);
			await Promise.all([
				storage.confirmWorkspaceFileResource(f.db, resource),
				storage.confirmWorkspaceFileResource(f.db, resource),
			]);
			expect(
				await storage.getOsWorkspaceResource(f.db, identity),
			).toMatchObject({ id: resource.id });
			expect(
				f.sqlite.prepare("SELECT count(*) n FROM os_workspace_resources").get()
					?.n,
			).toBe(1);
			expect(listWorkspaceResourceSummaries(f.tenant, scope)).toHaveLength(
				owned ? 1 : 0,
			);
		});
	},
);

it("does not write the list index when the object rejects the write", async () => {
	const f = await fixture(true);
	const query = f.runtime.outputQuery.bind(f.runtime);
	vi.spyOn(f.runtime, "outputQuery").mockImplementation(
		async (scope, input) => {
			if (input.op === "resources") throw new Error("object unavailable");
			return query(scope, input);
		},
	);
	await expect(
		storage.createOsWorkspaceResource(f.db, resource),
	).rejects.toThrow("object unavailable");
	expect(
		f.sqlite.prepare("SELECT count(*) n FROM os_workspace_resources").get()?.n,
	).toBe(0);
});
it("does not fall back to an index row missing from its owner", async () => {
	const f = await fixture(true);
	await f.db.insert(osWorkspaceResources).values(resource);
	expect(await storage.getOsWorkspaceResource(f.db, identity)).toBeUndefined();
	expect(
		await storage.findOsWorkspaceTenantResource(f.db, resource),
	).toBeUndefined();
});
it("rejects a resource from another workspace at the object boundary", async () => {
	const f = await fixture(true);
	await expect(
		executeOutputQuery(f.tenant, scope, {
			op: "resources",
			query: {
				operation: "create",
				params: { ...resource, workspaceId: "other" },
			},
		}),
	).rejects.toThrow("outside this workspace");
	expect(listWorkspaceResourceSummaries(f.tenant, scope)).toEqual([]);
});

it.each([true, false])(
	"preserves editor link guards (object owner: %s)",
	async (owned) => {
		const f = await fixture(owned);
		const row = await storage.createOsWorkspaceResource(f.db, {
			...resource,
			providerId: "tedix",
			resourceType: "output",
			slot: "doc",
		});
		await f.db.insert(osGadgets).values({
			id: "editor",
			organizationId: scope.organizationId,
			workspaceId: scope.workspaceId,
			name: "Editor",
			currentRevisionId: "current",
			createdByKind: "user",
			createdById: "owner",
		});
		const params = {
			...identity,
			outputId: resource.providerResourceId,
			expectedSlot: "doc",
			expectedGadgetRevisionId: "stale",
			gadgetId: "editor",
			kind: "document",
			now: "2026-11-02",
		};
		expect(
			await storage.linkWorkspaceOutputEditor(f.db, params),
		).toBeUndefined();
		expect(await storage.getOsWorkspaceResource(f.db, identity)).toEqual(row);
		expect(
			await storage.linkWorkspaceOutputEditor(f.db, {
				...params,
				expectedGadgetRevisionId: "current",
				expectedSlot: "wrong",
			}),
		).toBeUndefined();
		expect(
			await storage.linkWorkspaceOutputEditor(f.db, {
				...params,
				expectedGadgetRevisionId: "current",
			}),
		).toEqual({ id: row.id });
		expect(
			(await storage.getOsWorkspaceResource(f.db, identity))?.metadata,
		).toBe('{"gadgetId":"editor","kind":"document"}');
		const shared = f.sqlite
			.prepare("SELECT metadata FROM os_workspace_resources")
			.get();
		const local = f.objectSql
			.prepare("SELECT metadata FROM os_workspace_resources")
			.get();
		expect(local).toEqual(owned ? shared : undefined);
	},
);
