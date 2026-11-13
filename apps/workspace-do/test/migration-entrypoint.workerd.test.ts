import { tenantStoreName } from "@tedix/db/tenant-store/router";
import {
	createExecutionContext,
	env,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vite-plus/test";
import worker, { InternalEntrypoint } from "../src/index";
import type { WorkspaceEnv } from "../src/env";

const scope = {
	organizationId: "org_migration_fixture",
	workspaceId: "11111111-1111-4111-8111-111111111119",
};
const base = `https://workspace.internal/migration/workspaces/${scope.organizationId}/${scope.workspaceId}`;
const token = "migration-test-token";

function entrypoint() {
	return new InternalEntrypoint(createExecutionContext(), {
		...(env as unknown as WorkspaceEnv),
		MIGRATE_WORKSPACES_TOKEN: token,
	});
}

describe("migration through the RPC service entrypoint", () => {
	test("refuses organization memory imports through public and service fetch before addressing an object", async () => {
		const guardedEnv = {
			MIGRATE_WORKSPACES_TOKEN: token,
			// An absent namespace proves rejection precedes even an object wake.
		} as WorkspaceEnv;
		const service = new InternalEntrypoint(
			createExecutionContext(),
			guardedEnv,
		);
		for (const fetch of [
			(request: Request) => worker.fetch(request, guardedEnv),
			(request: Request) => service.fetch(request),
		]) {
			for (const authorization of [
				"",
				"Bearer incorrect-test-token",
				`Bearer ${token}`,
			]) {
				const response = await fetch(
					new Request(`${base}/import`, {
						method: "POST",
						headers: { authorization },
						body: JSON.stringify({
							batchId: "b1",
							table: "memory_facts",
							rows: [],
						}),
					}),
				);
				expect(response.status).toBe(
					authorization === `Bearer ${token}` ? 409 : 401,
				);
				if (response.status === 409)
					expect(await response.json()).toMatchObject({
						code: "ORGANIZATION_MEMORY_STAYS",
					});
			}
		}
	});

	test("imports workspace rows through the bound entrypoint, once per batch", async () => {
		const send = () =>
			entrypoint().fetch(
				new Request(`${base}/import`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify({
						batchId: "workspace-row-1",
						table: "os_workspaces",
						rows: [
							{
								id: scope.workspaceId,
								organization_id: scope.organizationId,
								name: "Fixture",
								status: "active",
								created_by_kind: "user",
								created_by_id: "u1",
								created_at: "2026-11-07T10:00:00.000Z",
								updated_at: "2026-11-07T10:00:00.000Z",
							},
						],
					}),
				}),
			);
		const first = await send();
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({
			rowCount: 1,
			status: "imported",
		});
		expect(await (await send()).json()).toMatchObject({ status: "duplicate" });
		// Workspace chats move too, and can be read back for the reconciler.
		const chat = await entrypoint().fetch(
			new Request(`${base}/import`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({
					batchId: "chat-1",
					table: "kernel_conversations",
					rows: [
						{
							id: "kc-1",
							organization_id: scope.organizationId,
							conversation_id: "conv-1",
							workspace_id: scope.workspaceId,
							last_message_at: "2026-11-07T10:00:00.000Z",
						},
					],
				}),
			}),
		);
		expect(await chat.json()).toMatchObject({
			rowCount: 1,
			status: "imported",
		});
		const rows = await entrypoint().fetch(
			new Request(`${base}/rows`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: JSON.stringify({
					table: "kernel_conversations",
					after: null,
					limit: 10,
				}),
			}),
		);
		expect(
			((await rows.json()) as { rows: Array<{ id: string }> }).rows.map(
				(row) => row.id,
			),
		).toEqual(["kc-1"]);
	});

	test("describes the real workspace schema through the bound entrypoint", async () => {
		const response = await entrypoint().fetch(
			new Request(base, {
				headers: {
					authorization: `Bearer ${token}`,
					"X-Workspace-Org": scope.organizationId,
					"X-Workspace-Id": scope.workspaceId,
				},
			}),
		);
		expect(response.status).toBe(200);
		const description = (await response.json()) as typeof scope & {
			migrations: string[];
		};
		expect(description).toMatchObject(scope);
		expect(description.migrations).toContain(
			"20261108100233_workspace_chat_tables",
		);
	});

	test("activation requires its own authenticated operation and current reconciliation generation", async () => {
		const target = base.replace(scope.workspaceId, crypto.randomUUID());
		const post = (
			route: string,
			body: unknown,
			authorization = `Bearer ${token}`,
		) =>
			entrypoint().fetch(
				new Request(`${target}${route}`, {
					method: "POST",
					headers: { authorization },
					body: JSON.stringify(body),
				}),
			);
		for (const authorization of ["", "Bearer incorrect-test-token"]) {
			expect(
				(
					await post(
						"/activate",
						{ importGeneration: 1, reconciliationRef: "fixture:proof" },
						authorization,
					)
				).status,
			).toBe(401);
		}
		expect((await post("/activate", {})).status).toBe(400);
		expect(
			(
				await post("/import", {
					batchId: "staged",
					table: "os_outputs",
					rows: [],
				})
			).status,
		).toBe(200);
		expect(
			(
				await post("/import", {
					batchId: "invalid",
					table: "os_outputs",
					rows: [{ id: "invalid-row" }],
				})
			).status,
		).toBe(400);
		const description = await (
			await entrypoint().fetch(
				new Request(target, { headers: { authorization: `Bearer ${token}` } }),
			)
		).json();
		expect(description).toMatchObject({
			outputAuthority: "shared",
			importGeneration: 1,
		});
		expect(
			(
				await post("/activate", {
					importGeneration: 2,
					reconciliationRef: "fixture:wrong",
				})
			).status,
		).toBe(400);
		const activation = {
			importGeneration: 1,
			reconciliationRef: "fixture:reconciled",
		};
		expect(await (await post("/activate", activation)).json()).toEqual(
			activation,
		);
		expect(await (await post("/activate", activation)).json()).toEqual(
			activation,
		);
		expect(
			await (
				await entrypoint().fetch(
					new Request(target, {
						headers: { authorization: `Bearer ${token}` },
					}),
				)
			).json(),
		).toMatchObject({ outputAuthority: "object" });
	});

	test("rejects missing or incorrect migration bearers", async () => {
		for (const authorization of ["", "Bearer incorrect-test-token"]) {
			const response = await entrypoint().fetch(
				new Request(base, { headers: { authorization } }),
			);
			expect(response.status).toBe(401);
		}
	});

	test("preserves the method guard and ordinary workspace header requirement", async () => {
		const response = await entrypoint().fetch(
			new Request(base, {
				method: "DELETE",
				headers: { authorization: `Bearer ${token}` },
			}),
		);
		expect(response.status).toBe(405);
		const unrelated = await entrypoint().fetch(
			new Request("https://workspace.internal/subscribe"),
		);
		expect(unrelated.status).toBe(400);
	});
});

describe("frozen staged deltas", () => {
	function target() {
		const workspaceId = crypto.randomUUID();
		const scoped = { ...scope, workspaceId };
		const address = base.replace(scope.workspaceId, workspaceId);
		const post = (route: string, body: unknown) =>
			entrypoint().fetch(
				new Request(`${address}${route}`, {
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
					body: JSON.stringify(body),
				}),
			);
		const rows = async (table: string) =>
			(
				(await (
					await post("/rows", { table, after: null, limit: 100 })
				).json()) as { rows: Record<string, string | number | null>[] }
			).rows;
		const describe = async () =>
			(await (
				await entrypoint().fetch(
					new Request(address, {
						headers: { authorization: `Bearer ${token}` },
					}),
				)
			).json()) as { importGeneration: number; outputAuthority: string };
		return { scoped, post, rows, describe };
	}
	test("CAS is atomic, receipts are idempotent, and every delta invalidates prior reconciliation", async () => {
		const f = target();
		expect(
			(
				await f.post("/import", {
					batchId: "seed",
					table: "os_workspaces",
					rows: [
						{
							id: f.scoped.workspaceId,
							organization_id: scope.organizationId,
							name: "Staged",
							created_by_kind: "user",
							created_by_id: "fixture",
						},
					],
				})
			).status,
		).toBe(200);
		const before = (await f.rows("os_workspaces"))[0]!;
		const delta = {
			batchId: "rename",
			table: "os_workspaces",
			importGeneration: 1,
			freezeRef: "fixture:freeze",
			changes: [{ before, after: { ...before, name: "Frozen" } }],
		};
		expect(await (await f.post("/delta", delta)).json()).toMatchObject({
			status: "imported",
			importGeneration: 2,
		});
		expect(await (await f.post("/delta", delta)).json()).toMatchObject({
			status: "duplicate",
			importGeneration: 2,
		});
		expect(
			(
				await f.post("/activate", {
					importGeneration: 1,
					reconciliationRef: "fixture:old",
				})
			).status,
		).toBe(400);
		const current = (await f.rows("os_workspaces"))[0]!;
		expect(current.name).toBe("Frozen");
		expect(
			(
				await f.post("/delta", {
					...delta,
					batchId: "conflict",
					importGeneration: 2,
					changes: [{ before, after: { ...before, name: "Wrong" } }],
				})
			).status,
		).toBe(400);
		expect(await f.describe()).toMatchObject({
			outputAuthority: "shared",
			importGeneration: 2,
		});
		expect((await f.rows("os_workspaces"))[0]!.name).toBe("Frozen");
		expect(
			(
				await f.post("/delta", {
					...delta,
					batchId: "wrong-scope",
					importGeneration: 2,
					changes: [
						{
							before: current,
							after: { ...current, organization_id: "other" },
						},
					],
				})
			).status,
		).toBe(400);
		expect(
			(
				await f.post("/delta", {
					...delta,
					batchId: "no-freeze",
					importGeneration: 2,
					freezeRef: "",
				})
			).status,
		).toBe(400);
		expect(
			(
				await f.post("/activate", {
					importGeneration: 2,
					reconciliationRef: "fixture:frozen",
				})
			).status,
		).toBe(200);
		expect(
			(
				await f.post("/delta", {
					...delta,
					batchId: "after-activation",
					importGeneration: 2,
				})
			).status,
		).toBe(400);
	});

	test("deletion and multi-row rollback preserve the whole staged batch", async () => {
		const f = target();
		expect(
			(
				await f.post("/import", {
					batchId: "directory",
					table: "os_workspaces",
					rows: [
						{
							id: f.scoped.workspaceId,
							organization_id: scope.organizationId,
							name: "Directory",
							created_by_kind: "user",
							created_by_id: "fixture",
						},
					],
				})
			).status,
		).toBe(200);
		const resource = (id: string) => ({
			id,
			organization_id: scope.organizationId,
			workspace_id: f.scoped.workspaceId,
			provider_id: "fixture",
			connection_scope: "tenant",
			resource_type: "file",
			provider_resource_id: id,
			name: id,
			created_by_kind: "user",
			created_by_id: "fixture",
		});
		expect(
			(
				await f.post("/import", {
					batchId: "seed",
					table: "os_workspace_resources",
					rows: [resource("a"), resource("b")],
				})
			).status,
		).toBe(200);
		const [a, b] = await f.rows("os_workspace_resources");
		const directory = (await f.rows("os_workspaces"))[0]!;
		expect(
			(
				await f.post("/delta", {
					batchId: "directory-name",
					table: "os_workspaces",
					importGeneration: 2,
					freezeRef: "fixture:freeze",
					changes: [
						{ before: directory, after: { ...directory, name: "Renamed" } },
					],
				})
			).status,
		).toBe(200);
		expect(await f.rows("os_workspace_resources")).toEqual([a, b]);
		const renamed = (await f.rows("os_workspaces"))[0]!;
		expect(
			(
				await f.post("/delta", {
					batchId: "no-cascade",
					table: "os_workspaces",
					importGeneration: 3,
					freezeRef: "fixture:freeze",
					changes: [{ before: renamed, after: null }],
				})
			).status,
		).toBe(400);
		expect(await f.rows("os_workspace_resources")).toEqual([a, b]);
		expect((await f.rows("os_workspaces"))[0]).toEqual(renamed);
		expect((await f.describe()).importGeneration).toBe(3);
		const batch = {
			batchId: "atomic",
			table: "os_workspace_resources",
			importGeneration: 3,
			freezeRef: "fixture:freeze",
			changes: [
				{ before: a, after: { ...a, name: "Changed" } },
				{ before: { ...b, name: "Wrong" }, after: null },
			],
		};
		expect((await f.post("/delta", batch)).status).toBe(400);
		expect(await f.rows("os_workspace_resources")).toEqual([a, b]);
		expect((await f.describe()).importGeneration).toBe(3);
		expect(
			(
				await f.post("/delta", {
					...batch,
					batchId: "delete",
					changes: [{ before: b, after: null }],
				})
			).status,
		).toBe(200);
		expect(await f.rows("os_workspace_resources")).toEqual([a]);
		expect(
			(
				await f.post("/delta", {
					...batch,
					batchId: "last-child",
					importGeneration: 4,
					changes: [{ before: a, after: null }],
				})
			).status,
		).toBe(200);
		expect(
			(
				await f.post("/delta", {
					batchId: "parent-after-children",
					table: "os_workspaces",
					importGeneration: 5,
					freezeRef: "fixture:freeze",
					changes: [{ before: renamed, after: null }],
				})
			).status,
		).toBe(200);
		expect(await f.rows("os_workspaces")).toEqual([]);
		expect((await f.describe()).importGeneration).toBe(6);
	});

	test("rebuilds imported chat after a delta and refuses to overwrite a native rename", async () => {
		const f = target();
		expect(
			(
				await f.post("/import", {
					batchId: "chat",
					table: "kernel_conversations",
					rows: [
						{
							id: "kc-delta",
							organization_id: scope.organizationId,
							workspace_id: f.scoped.workspaceId,
							conversation_id: "conv-delta",
							title: "Staged",
							last_message_at: "2026-11-07T10:00:00Z",
						},
					],
				})
			).status,
		).toBe(200);
		const before = (await f.rows("kernel_conversations"))[0]!;
		const after = { ...before, title: "Frozen" };
		const delta = {
			batchId: "chat-rename",
			table: "kernel_conversations",
			importGeneration: 1,
			freezeRef: "fixture:freeze",
			changes: [{ before, after }],
		};
		expect((await f.post("/delta", delta)).status).toBe(200);
		expect(await entrypoint().listConversations(f.scoped)).toMatchObject([
			{ title: "Frozen" },
		]);
		const namespace = (env as unknown as WorkspaceEnv).WORKSPACE;
		await runInDurableObject(
			namespace.get(namespace.idFromName(tenantStoreName(f.scoped))),
			async (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE conversations SET title = ? WHERE id = ?",
					"Native edit",
					"conv-delta",
				);
			},
		);
		expect(
			(
				await f.post("/delta", {
					...delta,
					batchId: "clobber",
					importGeneration: 2,
					changes: [{ before: after, after: { ...after, title: "Overwrite" } }],
				})
			).status,
		).toBe(400);
		expect(await entrypoint().listConversations(f.scoped)).toMatchObject([
			{ title: "Native edit" },
		]);
		expect((await f.describe()).importGeneration).toBe(2);
	});
});
