import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import type { DbQueryClient } from "@tedix/db/query-client";
import { TenantDataPort } from "../src/data-port-tenant";
import type { WorkspaceEnv } from "../src/env";

const scope = {
	organizationId: "org_port_fixture",
	workspaceId: "workspace_port_fixture",
};
const unused = () => {
	throw new Error("Unexpected storage access");
};
const core = new Proxy({} as DbQueryClient, { get: unused });
const bucket = { get: unused, put: unused };

function port(tenant: TenantStoreDb, activated: boolean) {
	return new TenantDataPort({
		...scope,
		tenant,
		core,
		bucket,
		actorKind: "user",
		validateAppSource: unused,
		assertWorkspaceAuthority: async () => {
			if (!activated) throw new Error("Workspace activation is required");
		},
		commitOutput: unused,
	});
}

describe("workspace agent data storage", () => {
	test("unactivated output and resource operations refuse before touching either database or R2", async () => {
		const data = port(new Proxy({} as TenantStoreDb, { get: unused }), false);
		const content = { kind: "document" as const, blocks: [] };
		for (const operation of [
			() => data.listOutputs(),
			() => data.getOutput("staged-output"),
			() =>
				data.createOutput({ title: "Refused", content, actorId: "fixture" }),
			() =>
				data.reviseOutput({
					outputId: "staged-output",
					content,
					actorId: "fixture",
					expectedRevision: 1,
				}),
			() => data.listResources(),
		])
			await expect(operation()).rejects.toThrow(
				"Workspace activation is required",
			);
	});

	test("resource summaries use only active rows in the object's organization and workspace", async () => {
		const bindings = env as unknown as WorkspaceEnv;
		const ws = tenantStoreStub(bindings.WORKSPACE, bindings, scope);
		await runInDurableObject(ws, async (_instance, state) => {
			for (const [org, workspace] of [
				[scope.organizationId, scope.workspaceId],
				["other_org", "other_org_workspace"],
				[scope.organizationId, "other_workspace"],
			] as const)
				state.storage.sql.exec(
					"INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id) VALUES (?, ?, ?, 'user', 'fixture')",
					workspace,
					org,
					workspace,
				);
			for (const [id, org, workspace, name, status] of [
				["z", scope.organizationId, scope.workspaceId, "Same", "active"],
				["a", scope.organizationId, scope.workspaceId, "Same", "active"],
				["first", scope.organizationId, scope.workspaceId, "First", "active"],
				[
					"removed",
					scope.organizationId,
					scope.workspaceId,
					"Removed",
					"removed",
				],
				[
					"foreign-org",
					"other_org",
					"other_org_workspace",
					"Foreign",
					"active",
				],
				[
					"foreign-workspace",
					scope.organizationId,
					"other_workspace",
					"Foreign",
					"active",
				],
			] as const)
				state.storage.sql.exec(
					"INSERT INTO os_workspace_resources (id, organization_id, workspace_id, provider_id, connection_scope, resource_type, provider_resource_id, name, status, created_by_kind, created_by_id) VALUES (?, ?, ?, 'fixture', 'tenant', 'file', ?, ?, ?, 'user', 'fixture')",
					id,
					org,
					workspace,
					id,
					name,
					status,
				);
			const data = port(createTenantStoreDb(state.storage), true);
			expect(await data.listResources()).toEqual([
				{ id: "first", name: "First", kind: "file", status: "active" },
				{ id: "a", name: "Same", kind: "file", status: "active" },
				{ id: "z", name: "Same", kind: "file", status: "active" },
			]);
		});
	});
});
