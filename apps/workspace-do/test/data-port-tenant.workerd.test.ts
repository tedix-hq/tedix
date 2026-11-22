import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import { tenantStoreStub } from "@tedix/db/tenant-store/router";
import { createTenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import type { TenantStoreDb } from "@tedix/db/queries/durable-sqlite/tenant-store";
import {
	createDbQueryClient,
	type DbQueryClient,
} from "@tedix/db/query-client";
import { connectionInstances } from "@tedix/db/schema/connection-instances";
import { connectionProviders } from "@tedix/db/schema/connection-providers";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { storeOutputBody, TenantDataPort } from "../src/data-port-tenant";
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

function ddl(table: SQLiteTable): string {
	const columns = Object.values(getTableColumns(table)).map((column) => {
		const parts = [`"${column.name}"`, column.getSQLType()];
		if (column.primary) parts.push("PRIMARY KEY");
		return parts.join(" ");
	});
	return `CREATE TABLE IF NOT EXISTS "${getTableName(table)}" (${columns.join(", ")})`;
}

function port(
	tenant: TenantStoreDb,
	activated: boolean,
	overrides: Partial<ConstructorParameters<typeof TenantDataPort>[0]> = {},
) {
	return new TenantDataPort({
		...scope,
		tenant,
		core,
		bucket,
		workspaceFiles: bucket,
		actorKind: "user",
		validateAppSource: unused,
		assertWorkspaceAuthority: async () => {
			if (!activated) throw new Error("Workspace activation is required");
		},
		commitOutput: unused,
		notifyOutputRevision: unused,
		...overrides,
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

	test("reading a legacy sheet does not upload blocks or commit a conversion", async () => {
		const bindings = env as unknown as WorkspaceEnv;
		const ws = tenantStoreStub(bindings.WORKSPACE, bindings, scope);
		await runInDurableObject(ws, async (_instance, state) => {
			const content = { kind: "sheet", columns: ["A"], rows: [[1]] };
			state.storage.sql.exec(
				"INSERT INTO os_outputs (id, organization_id, workspace_id, kind, title, current_revision_id, created_by_kind, created_by_id) VALUES ('legacy-sheet', ?, ?, 'sheet', 'Legacy', 'legacy-revision', 'user', 'fixture')",
				scope.organizationId,
				scope.workspaceId,
			);
			state.storage.sql.exec(
				"INSERT INTO os_output_revisions (id, organization_id, output_id, revision, content, access_envelope, created_by_kind, created_by_id) VALUES ('legacy-revision', ?, 'legacy-sheet', 1, ?, ?, 'user', 'fixture')",
				scope.organizationId,
				JSON.stringify(content),
				JSON.stringify({ version: 1, sources: [] }),
			);
			const data = port(createTenantStoreDb(state.storage), true);
			expect(await data.getOutput("legacy-sheet")).toMatchObject({
				revision: 1,
				content,
			});
		});
	});

	test("migrates old row objects to chunks under the workspace revision digest fence", async () => {
		const bindings = env as unknown as WorkspaceEnv;
		const ws = tenantStoreStub(bindings.WORKSPACE, bindings, scope);
		await runInDurableObject(ws, async (_instance, state) => {
			const raw = JSON.stringify({ cells: { "column:0": 1 }, overflow: [] });
			const digest = await sha256Hex(raw);
			const rowKey = `os-sheet-blocks/v1/${scope.organizationId}/${digest}.gz`;
			await bindings.R2_BUCKET.put(
				rowKey,
				await new Response(
					new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
				).arrayBuffer(),
			);
			const legacy = {
				sheetBlocks: 1,
				content: { kind: "sheet", columns: ["A"], rows: [] },
				tables: [
					{
						id: "flat",
						columns: ["column:0"],
						rows: [
							{
								id: "row:0",
								digest,
								bytes: new TextEncoder().encode(raw).byteLength,
								contentBytes: 3,
							},
						],
					},
				],
			};
			const stored = await storeOutputBody(
				bindings.R2_BUCKET,
				scope.organizationId,
				JSON.stringify(legacy),
			);
			state.storage.sql.exec(
				"INSERT INTO os_outputs (id,organization_id,workspace_id,kind,title,current_revision_id,created_by_kind,created_by_id) VALUES ('v1-sheet',?,?,'sheet','V1','v1-revision','user','fixture')",
				scope.organizationId,
				scope.workspaceId,
			);
			state.storage.sql.exec(
				"INSERT INTO os_output_revisions (id,organization_id,output_id,revision,content,access_envelope,created_by_kind,created_by_id,content_sha256,content_bytes,body_r2_key) VALUES ('v1-revision',?,'v1-sheet',1,'',?,'user','fixture',?,?,?)",
				scope.organizationId,
				JSON.stringify({ version: 1, sources: [] }),
				stored.contentSha256,
				stored.contentBytes,
				stored.bodyR2Key,
			);
			const data = port(createTenantStoreDb(state.storage), true, {
				bucket: bindings.R2_BUCKET,
				commitOutput: async (_id, write) => write(),
			});
			const expected = {
				revision: 1,
				content: { kind: "sheet", columns: ["A"], rows: [[1]] },
			};
			expect(await data.getOutput("v1-sheet")).toMatchObject(expected);
			const updated = state.storage.sql
				.exec<{ content_sha256: string }>(
					"SELECT content_sha256 FROM os_output_revisions WHERE id='v1-revision'",
				)
				.one();
			expect(updated.content_sha256).not.toBe(stored.contentSha256);
			await bindings.R2_BUCKET.delete(rowKey);
			expect(await data.getOutput("v1-sheet")).toMatchObject(expected);
		});
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
			// These need no account, so the shared database is never read.
			const native = {
				kind: "file",
				status: "active",
				slot: null,
				providerId: "fixture",
				service: "fixture",
				connectionScope: "organization",
				connectionInstanceId: null,
				providerAccess: null,
				connectedForYou: null,
			};
			expect(await data.listResources()).toEqual([
				{ id: "first", name: "First", ...native },
				{ id: "a", name: "Same", ...native },
				{ id: "z", name: "Same", ...native },
			]);
		});
	});

	test("a source says how it is connected and whether the acting person has its account, and names no owner", async () => {
		const bindings = env as unknown as WorkspaceEnv;
		const sources = {
			organizationId: "org_port_sources",
			workspaceId: "workspace_port_sources",
		};
		for (const table of [connectionInstances, connectionProviders])
			await bindings.DB.prepare(ddl(table)).run();
		await bindings.DB.prepare(
			"INSERT OR REPLACE INTO connection_providers (id, name, description, icon, category, type, recommended_scope, supported_scopes, required_scopes) VALUES ('drive', 'Example Drive', '', '', 'storage', 'oauth', 'user', '[]', '[]')",
		).run();
		// [id, organization, owner, provider, holds a grant]
		for (const [id, organizationId, owner, providerId, granted] of [
			["ana-drive", null, "ana", "drive", true],
			["ana-second-drive", null, "ana", "drive", false],
			["ben-drive", null, "ben", "drive", true],
			["ben-mail", null, "ben", "mail", true],
			["org-drive", sources.organizationId, "ben", "drive", true],
			["org-mail", sources.organizationId, "ben", "mail", false],
			["other-org-mail", "org_port_other", "ben", "mail", true],
		] as const)
			await bindings.DB.prepare(
				"INSERT OR REPLACE INTO connection_instances (id, owner_user_id, organization_id, provider_id, label, token_ids, token_sub, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-11-18', '2026-11-18')",
			)
				.bind(
					id,
					owner,
					organizationId,
					providerId,
					id,
					granted ? '["grant"]' : "[]",
					granted ? "subject" : null,
				)
				.run();
		const ws = tenantStoreStub(bindings.WORKSPACE, bindings, sources);
		await runInDurableObject(ws, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id) VALUES (?, ?, 'Sources', 'user', 'fixture')",
				sources.workspaceId,
				sources.organizationId,
			);
			// [id, slot, provider, scope, owner, account, access]
			for (const [id, slot, providerId, scope, owner, account, access] of [
				[
					"1-own",
					"notes",
					"drive",
					"user",
					"ana",
					"ana-drive",
					'{"canRead":true,"canWrite":false}',
				],
				[
					"2-own-unconnected",
					null,
					"drive",
					"user",
					"ana",
					"ana-second-drive",
					null,
				],
				["3-colleague-drive", null, "drive", "user", "ben", "ben-drive", null],
				["4-colleague-mail", null, "mail", "user", "ben", "ben-mail", null],
				["5-shared", null, "drive", "tenant", null, "org-drive", null],
				[
					"6-shared-unconnected",
					null,
					"mail",
					"tenant",
					null,
					"org-mail",
					null,
				],
				["7-file", null, "tedix", "tenant", null, null, null],
			] as const)
				state.storage.sql.exec(
					"INSERT INTO os_workspace_resources (id, organization_id, workspace_id, slot, provider_id, connection_scope, personal_owner_user_id, connection_instance_id, provider_access, resource_type, provider_resource_id, name, status, created_by_kind, created_by_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'folder', ?, ?, 'active', 'user', 'fixture')",
					id,
					sources.organizationId,
					sources.workspaceId,
					slot,
					providerId,
					scope,
					owner,
					account,
					access,
					id,
					id,
				);
			const list = (actingUserId: string | null) =>
				new TenantDataPort({
					...sources,
					tenant: createTenantStoreDb(state.storage),
					core: createDbQueryClient(bindings.DB),
					bucket,
					workspaceFiles: bucket,
					actorKind: actingUserId ? "user" : "external_agent",
					actingUserId,
					validateAppSource: unused,
					assertWorkspaceAuthority: async () => {},
					commitOutput: unused,
					notifyOutputRevision: unused,
				}).listResources();
			const forAna = await list("ana");
			expect(forAna[0]).toEqual({
				id: "1-own",
				name: "1-own",
				kind: "folder",
				status: "active",
				slot: "notes",
				providerId: "drive",
				service: "Example Drive",
				connectionScope: "personal",
				connectionInstanceId: "ana-drive",
				providerAccess: { canRead: true, canWrite: false },
				connectedForYou: true,
			});
			const connected = (rows: typeof forAna) =>
				Object.fromEntries(rows.map((row) => [row.id, row.connectedForYou]));
			expect(connected(forAna)).toEqual({
				"1-own": true,
				// Her other account of the same service does not stand in for it.
				"2-own-unconnected": false,
				// A colleague's source reads through her own account of that service.
				"3-colleague-drive": true,
				"4-colleague-mail": false,
				"5-shared": true,
				"6-shared-unconnected": false,
				"7-file": null,
			});
			expect(
				forAna.map((row) => [row.id, row.connectionScope, row.service]),
			).toEqual([
				["1-own", "personal", "Example Drive"],
				["2-own-unconnected", "personal", "Example Drive"],
				["3-colleague-drive", "personal", "Example Drive"],
				["4-colleague-mail", "personal", "mail"],
				["5-shared", "organization", "Example Drive"],
				["6-shared-unconnected", "organization", "mail"],
				["7-file", "organization", "tedix"],
			]);
			// With no person acting, only the organization's accounts count.
			expect(connected(await list(null))).toEqual({
				"1-own": false,
				"2-own-unconnected": false,
				"3-colleague-drive": false,
				"4-colleague-mail": false,
				"5-shared": true,
				"6-shared-unconnected": false,
				"7-file": null,
			});
			const shown = JSON.stringify([forAna, await list("ben")]);
			expect(shown).not.toContain("personalOwnerUserId");
			expect(shown).not.toContain('"ana"');
			expect(shown).not.toContain('"ben"');
			expect(shown).not.toContain("grant");
			expect(shown).not.toContain("subject");
		});
	});

	test("an agent turn's saves stay the person's and record the turn", async () => {
		const bindings = env as unknown as WorkspaceEnv;
		const ws = tenantStoreStub(bindings.WORKSPACE, bindings, scope);
		await runInDurableObject(ws, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT OR IGNORE INTO os_workspaces (id, organization_id, name, created_by_kind, created_by_id) VALUES (?, ?, 'Fixture', 'user', 'fixture')",
				scope.workspaceId,
				scope.organizationId,
			);
			const tenant = createTenantStoreDb(state.storage);
			const data = (agentTurnId?: string) =>
				new TenantDataPort({
					...scope,
					tenant,
					core,
					bucket: bindings.R2_BUCKET,
					workspaceFiles: bindings.SKILL_ARTIFACTS,
					actorKind: "user",
					agentTurnId,
					validateAppSource: unused,
					assertWorkspaceAuthority: async () => {},
					commitOutput: (_outputId, write) => write(),
					notifyOutputRevision: async () => {},
				});
			const created = await data("turn-1").createOutput({
				title: "Notes",
				content: { kind: "document", blocks: [] },
				actorId: "person-1",
			});
			await data("turn-2").reviseOutput({
				outputId: created.id,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "From the agent" }],
				},
				expectedRevision: 1,
				actorId: "person-1",
			});
			await data().reviseOutput({
				outputId: created.id,
				content: {
					kind: "document",
					blocks: [{ type: "paragraph", text: "Typed by the person" }],
				},
				expectedRevision: 2,
				actorId: "person-1",
			});
			expect(
				state.storage.sql
					.exec(
						"SELECT revision, created_by_kind, created_by_id, agent_turn_id FROM os_output_revisions WHERE output_id = ? ORDER BY revision",
						created.id,
					)
					.toArray(),
			).toEqual([
				{
					revision: 1,
					created_by_kind: "user",
					created_by_id: "person-1",
					agent_turn_id: "turn-1",
				},
				{
					revision: 2,
					created_by_kind: "user",
					created_by_id: "person-1",
					agent_turn_id: "turn-2",
				},
				{
					revision: 3,
					created_by_kind: "user",
					created_by_id: "person-1",
					agent_turn_id: null,
				},
			]);
		});
	});
});
