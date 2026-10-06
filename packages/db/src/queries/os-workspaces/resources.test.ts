import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osWorkspaceResources, osWorkspaces } from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	createOsWorkspaceResource,
	getOsWorkspaceResource,
	listOsWorkspaceResources,
	removeOsWorkspaceResource,
	rebindOsWorkspaceResource,
	renameOsWorkspaceResource,
} from "./resources";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
		INSERT INTO organizations (id) VALUES ('org-1'), ('org-2');
	`);
	sqlite.exec(schemaDdl(osWorkspaces, osWorkspaceResources));
	// schemaDdl deliberately omits expression indexes; exercise the production identity index on real SQLite.
	sqlite.exec(
		"CREATE UNIQUE INDEX os_workspace_resources_provider_object_unique ON os_workspace_resources(workspace_id,provider_id,connection_scope,coalesce(personal_owner_user_id, ''),coalesce(connection_instance_id, ''),resource_type,provider_resource_id)",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	return { db };
}

async function seed() {
	const { db } = fixture();
	await db.insert(osWorkspaces).values({
		id: "ws-1",
		organizationId: "org-1",
		name: "Launch",
		createdByKind: "user",
		createdById: "u-1",
	});
	const resource = await createOsWorkspaceResource(db, {
		id: "resource-1",
		organizationId: "org-1",
		workspaceId: "ws-1",
		providerId: "github",
		connectionScope: "tenant",
		requiredScopes: '["contents:read"]',
		resourceType: "repository",
		providerResourceId: "tedix-hq/tedix",
		name: "Product repository",
		metadata: '{"url":"https://github.com/tedix-hq/tedix"}',
		createdByKind: "user",
		createdById: "u-1",
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	});
	return { db, resource };
}

describe("OS Workspace resources", () => {
	it("creates, lists, and reads only through organization and Workspace scope", async () => {
		const { db } = await seed();
		expect(
			await listOsWorkspaceResources(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				status: "active",
			}),
		).toHaveLength(1);
		expect(
			await getOsWorkspaceResource(db, {
				organizationId: "org-2",
				workspaceId: "ws-1",
				resourceId: "resource-1",
			}),
		).toBeUndefined();
	});

	it("rejects duplicate provider objects inside one Workspace", async () => {
		const { db, resource } = await seed();
		await expect(
			createOsWorkspaceResource(db, { ...resource, id: "resource-2" }),
		).rejects.toThrow();
	});

	it("isolates identical provider IDs by exact personal account and clears the binding on tenant rebind", async () => {
		const { db, resource } = await seed();
		const personal = {
			...resource,
			id: "personal-a",
			connectionScope: "user" as const,
			personalOwnerUserId: "owner",
			connectionInstanceId: "account-a",
		};
		await createOsWorkspaceResource(db, personal);
		await createOsWorkspaceResource(db, {
			...personal,
			id: "personal-b",
			connectionInstanceId: "account-b",
		});
		await expect(
			createOsWorkspaceResource(db, { ...personal, id: "personal-duplicate" }),
		).rejects.toThrow();
		await expect(
			rebindOsWorkspaceResource(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				resourceId: "personal-a",
				connectionScope: "tenant",
				expectedUpdatedAt: resource.updatedAt,
				now: "2026-08-20T02:00:00.000Z",
			}),
		).rejects.toThrow();
		// The matching tenant object already exists, so rebind cannot erase account identity by colliding with it.
		expect(
			(
				await getOsWorkspaceResource(db, {
					organizationId: "org-1",
					workspaceId: "ws-1",
					resourceId: "personal-a",
				})
			)?.connectionInstanceId,
		).toBe("account-a");
	});

	it("uses optimistic concurrency for rename and removal", async () => {
		const { db, resource } = await seed();
		expect(
			await renameOsWorkspaceResource(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				resourceId: resource.id,
				name: "Wrong",
				expectedUpdatedAt: "stale",
				now: "2026-08-20T01:00:00.000Z",
			}),
		).toBeUndefined();
		const renamed = await renameOsWorkspaceResource(db, {
			organizationId: "org-1",
			workspaceId: "ws-1",
			resourceId: resource.id,
			name: "Primary repository",
			expectedUpdatedAt: resource.updatedAt,
			now: "2026-08-20T01:00:00.000Z",
		});
		expect(renamed?.name).toBe("Primary repository");
		const removed = await removeOsWorkspaceResource(db, {
			organizationId: "org-1",
			workspaceId: "ws-1",
			resourceId: resource.id,
			expectedUpdatedAt: renamed!.updatedAt,
			now: "2026-08-20T02:00:00.000Z",
		});
		expect(removed).toMatchObject({
			status: "removed",
			removedAt: "2026-08-20T02:00:00.000Z",
		});
		expect(
			await listOsWorkspaceResources(db, {
				organizationId: "org-1",
				workspaceId: "ws-1",
				status: "active",
			}),
		).toHaveLength(0);
	});

	it("rebinds only an active exact resource with a matching revision", async () => {
		const { db, resource } = await seed();
		const params = {
			organizationId: "org-1",
			workspaceId: "ws-1",
			resourceId: resource.id,
			connectionScope: "user" as const,
			requiredScopes: '["drive.readonly"]',
			expectedUpdatedAt: resource.updatedAt,
			now: "2026-08-20T01:00:00.000Z",
		};
		expect(
			await rebindOsWorkspaceResource(db, {
				...params,
				organizationId: "org-2",
			}),
		).toBeUndefined();
		const rebound = await rebindOsWorkspaceResource(db, params);
		expect(rebound).toMatchObject({
			id: resource.id,
			providerId: resource.providerId,
			resourceType: resource.resourceType,
			providerResourceId: resource.providerResourceId,
			connectionScope: "user",
			requiredScopes: '["drive.readonly"]',
			updatedAt: params.now,
		});
		expect(
			await rebindOsWorkspaceResource(db, {
				...params,
				connectionScope: "tenant",
			}),
		).toBeUndefined();
		const preservedScopes = await rebindOsWorkspaceResource(db, {
			...params,
			connectionScope: "tenant",
			requiredScopes: undefined,
			expectedUpdatedAt: rebound!.updatedAt,
			now: "2026-08-20T02:00:00.000Z",
		});
		expect(preservedScopes?.requiredScopes).toBe('["drive.readonly"]');
		await removeOsWorkspaceResource(db, {
			organizationId: "org-1",
			workspaceId: "ws-1",
			resourceId: resource.id,
			expectedUpdatedAt: preservedScopes!.updatedAt,
			now: "2026-08-20T03:00:00.000Z",
		});
		expect(
			await rebindOsWorkspaceResource(db, {
				...params,
				expectedUpdatedAt: "2026-08-20T03:00:00.000Z",
				now: "2026-08-20T04:00:00.000Z",
			}),
		).toBeUndefined();
	});
});
