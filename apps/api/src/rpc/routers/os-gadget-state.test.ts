import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import {
	osGadgetState,
	osGadgetStateMutations,
} from "@tedix/db/schema/os-gadget-state";
import {
	osWorkspaces,
	osGadgets,
	osGadgetRevisions,
	osGadgetExecutions,
} from "@tedix/db/schema/os-workspaces";
import { skillRuns } from "@tedix/db/schema/cognitive";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
const sources = vi.hoisted(() => vi.fn(async () => true));
vi.mock(
	"../../services/os-derived-resource-access",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../../services/os-derived-resource-access")
		>()),
		authorizeDerivedOutputSources: sources,
	}),
);
import { osGadgetStateContractRouter } from "./os-gadget-state";
const ws = "11111111-1111-4111-8111-111111111111",
	gadget = "22222222-2222-4222-8222-222222222222",
	revision = "33333333-3333-4333-8333-333333333333",
	execution = "44444444-4444-4444-8444-444444444444",
	run = "55555555-5555-4555-8555-555555555555";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osGadgetState,
			osGadgetStateMutations,
			osWorkspaces,
			osGadgets,
			osGadgetRevisions,
			osGadgetExecutions,
			skillRuns,
		),
	);
	sqlite.exec(`INSERT INTO os_workspaces(id,organization_id,name,status,created_by_kind,created_by_id,created_at,updated_at) VALUES('${ws}','org','Operations','active','user','operator','2030-01-01','2030-01-01');
 INSERT INTO os_gadgets(id,organization_id,workspace_id,name,status,current_revision_id,created_by_kind,created_by_id,created_at,updated_at) VALUES('${gadget}','org','${ws}','Coordinator','active','${revision}','user','operator','2030-01-01','2030-01-01');
 INSERT INTO os_gadget_revisions(id,organization_id,gadget_id,revision,manifest,created_by_kind,created_by_id,created_at) VALUES('${revision}','org','${gadget}',1,'{"entry":"coordinator","capabilities":["os.gadget.state.read","os.gadget.state.write"]}','user','operator','2030-01-01');
 INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,execution_epoch) VALUES('${run}','org','skill','tedi','workflow','production','running',0);
 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,revision_id,revision,status,granted_capabilities,policy_decision,run_id,tedi_id,runtime_environment,created_by_kind,created_by_id,resource_access_envelope,execution_epoch,created_at) VALUES('${execution}','org','${ws}','${gadget}','${revision}',1,'running','["os.gadget.state.read","os.gadget.state.write"]','{"allowed":true}','${run}','tedi','production','tedi','tedi','{"version":1,"sources":[]}',0,'2030-01-01');`);
	const DB = createD1Facade(sqlite);
	const context = {
		authType: "service-binding",
		tediId: "tedi",
		tediScopes: ["apps:read", "apps:write"],
		organizationId: "org",
		headers: new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Mcp-Tool-Id": "osGadgetState.put",
			"X-Tedix-Skill-Run-Id": run,
			"X-Tedix-Workflow-Execution-Epoch": "0",
		}),
		env: { DB, ENVIRONMENT: "production" },
		db: createDbClient(DB),
		url: new URL("https://api.example.test/rpc/osGadgetState"),
	} as unknown as BaseContext;
	return {
		sqlite,
		context,
		client: createRouterClient(osGadgetStateContractRouter, { context }),
	};
}
const scope = {
	workspaceId: ws,
	gadgetId: gadget,
	execution: { executionId: execution, executionEpoch: 0 },
};
const put = {
	...scope,
	key: "sync:cursor",
	expectedRevision: 0,
	idempotencyKey: "first",
	value: { cursor: 1 },
};
beforeEach(() => sources.mockResolvedValue(true));
describe("Gadget state canonical router", () => {
	it("persists across calls, replays exact result and preserves deletion revision", async () => {
		const { client } = fixture();
		const first = await client.put(put);
		expect(first).toMatchObject({
			outcome: "applied",
			record: { revision: 1, value: { cursor: 1 }, deleted: false },
		});
		expect(await client.put(put)).toEqual(first);
		await expect(
			client.put({ ...put, value: { cursor: 2 } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			(
				await client.delete({
					...scope,
					key: put.key,
					expectedRevision: 1,
					idempotencyKey: "delete",
				})
			).record,
		).toMatchObject({ revision: 2, deleted: true, value: null });
		expect(
			(await client.get({ ...scope, key: put.key })).record?.revision,
		).toBe(2);
		expect(
			(
				await client.put({
					...put,
					idempotencyKey: "restore",
					expectedRevision: 2,
				})
			).record?.revision,
		).toBe(3);
	});
	it("paginates and refuses cross tenant, stale run and human writes", async () => {
		const { client, context, sqlite } = fixture();
		for (const key of ["a", "b", "c"])
			await client.put({ ...put, key, idempotencyKey: key });
		const page = await client.list({ ...scope, limit: 2 });
		expect(page.items.map((row) => row.key)).toEqual(["a", "b"]);
		expect(page.nextAfter).toBe("b");
		expect(
			(await client.list({ ...scope, limit: 2, after: "b" })).items.map(
				(row) => row.key,
			),
		).toEqual(["c"]);
		const foreign = createRouterClient(osGadgetStateContractRouter, {
			context: { ...context, organizationId: "foreign" },
		});
		await expect(foreign.get({ ...scope, key: "a" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		const human = createRouterClient(osGadgetStateContractRouter, {
			context: {
				...context,
				authType: "user",
				headers: new Headers(),
				tediId: undefined,
				user: { sub: "human", permissions: ["settings:manage"] },
			} as BaseContext,
		});
		expect(
			(await human.get({ workspaceId: ws, gadgetId: gadget, key: "a" })).record
				?.revision,
		).toBe(1);
		await expect(human.put(put)).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE skill_runs SET status='completed'");
		await expect(
			client.put({ ...put, idempotencyKey: "late" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("carries application state between distinct admitted executions", async () => {
		const { client, context, sqlite } = fixture();
		await client.put(put);
		const nextRun = "66666666-6666-4666-8666-666666666666",
			nextExecution = "77777777-7777-4777-8777-777777777777";
		sqlite.exec(`UPDATE skill_runs SET status='completed'; UPDATE os_gadget_executions SET status='completed';
 INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,execution_epoch) VALUES('${nextRun}','org','skill','tedi','next-workflow','production','running',0);
 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,revision_id,revision,status,granted_capabilities,policy_decision,run_id,tedi_id,runtime_environment,created_by_kind,created_by_id,resource_access_envelope,execution_epoch,created_at)
 SELECT '${nextExecution}',organization_id,workspace_id,gadget_id,revision_id,revision,'running',granted_capabilities,policy_decision,'${nextRun}',tedi_id,runtime_environment,created_by_kind,created_by_id,resource_access_envelope,execution_epoch,created_at FROM os_gadget_executions WHERE id='${execution}';`);
		const headers = new Headers(context.headers);
		headers.set("X-Tedix-Skill-Run-Id", nextRun);
		const second = createRouterClient(osGadgetStateContractRouter, {
			context: { ...context, headers },
		});
		expect(
			(await second.get({ workspaceId: ws, gadgetId: gadget, key: put.key }))
				.record?.value,
		).toEqual({ cursor: 1 });
		expect(
			(
				await second.put({
					workspaceId: ws,
					gadgetId: gadget,
					key: put.key,
					expectedRevision: 1,
					idempotencyKey: "next-execution",
					value: { cursor: 2 },
				})
			).record,
		).toMatchObject({ revision: 2, executionId: nextExecution });
	});

	it("uses host run provenance without tenant identity arguments and refuses a forged epoch", async () => {
		const { client, context } = fixture();
		const withoutHint = {
			workspaceId: ws,
			gadgetId: gadget,
			key: put.key,
			expectedRevision: 0,
			idempotencyKey: "host-provenance",
			value: put.value,
		};
		expect((await client.put(withoutHint)).outcome).toBe("applied");
		const forged = createRouterClient(osGadgetStateContractRouter, {
			context: {
				...context,
				headers: new Headers({
					"X-Service-Binding": "true",
					"X-Tedix-Mcp-Tool-Id": "osGadgetState.put",
					"X-Tedix-Skill-Run-Id": run,
					"X-Tedix-Workflow-Execution-Epoch": "1",
				}),
			},
		});
		await expect(
			forged.put({
				...withoutHint,
				idempotencyKey: "forged",
				expectedRevision: 1,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("does not disclose state after source access is revoked", async () => {
		const { client } = fixture();
		await client.put(put);
		sources.mockResolvedValue(false);
		await expect(client.get({ ...scope, key: put.key })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
	it("rejects oversized values before storage writes", async () => {
		const { client, sqlite } = fixture();
		await expect(
			client.put({ ...put, value: "x".repeat(32769) }),
		).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT count(*) AS count FROM os_gadget_state").get()
				?.count,
		).toBe(0);
	});
});
