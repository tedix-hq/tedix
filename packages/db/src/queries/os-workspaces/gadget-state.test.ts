import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	osGadgetState,
	osGadgetStateMutations,
} from "../../schema/os-gadget-state";
import {
	osWorkspaces,
	osGadgets,
	osGadgetExecutions,
} from "../../schema/os-workspaces";
import { skillRuns } from "../../schema/cognitive";
import {
	getGadgetState,
	listGadgetState,
	mutateGadgetState,
	hasLiveGadgetStateFence,
	type MutateGadgetStateParams,
} from "./gadget-state";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			osGadgetState,
			osGadgetStateMutations,
			osWorkspaces,
			osGadgets,
			osGadgetExecutions,
			skillRuns,
		),
	);
	sqlite.exec(`INSERT INTO os_workspaces(id,organization_id,name,status,created_by_kind,created_by_id,created_at,updated_at) VALUES('ws','org','Operations','active','user','operator','2030-01-01','2030-01-01');
 INSERT INTO os_gadgets(id,organization_id,workspace_id,name,status,current_revision_id,created_by_kind,created_by_id,created_at,updated_at) VALUES('gadget','org','ws','Coordinator','active','revision','user','operator','2030-01-01','2030-01-01');
 INSERT INTO skill_runs(id,organization_id,skill_id,tedi_id,workflow_instance_id,runtime_environment,status,execution_epoch) VALUES('run','org','skill','tedi','workflow','production','running',0);
 INSERT INTO os_gadget_executions(id,organization_id,workspace_id,gadget_id,revision_id,revision,status,granted_capabilities,policy_decision,run_id,tedi_id,runtime_environment,created_by_kind,created_by_id,resource_access_envelope,execution_epoch,created_at) VALUES('execution','org','ws','gadget','revision',1,'running','["os.gadget.state.write"]','{"allowed":true}','run','tedi','production','tedi','tedi','{"version":1,"sources":[]}',0,'2030-01-01');`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const params: MutateGadgetStateParams = {
		organizationId: "org",
		workspaceId: "ws",
		gadgetId: "gadget",
		executionId: "execution",
		executionEpoch: 0,
		tediId: "tedi",
		revisionId: "revision",
		runtimeEnvironment: "production",
		capability: "os.gadget.state.write",
		key: "sync:cursor",
		expectedRevision: 0,
		idempotencyKey: "first",
		digest: "intent-first",
		value: '{"cursor":1}',
		deleted: false,
		accessEnvelope: '{"version":1,"sources":[]}',
		now: "2030-01-01T00:00:00.000Z",
	};
	return { sqlite, db, params };
}
describe("durable Gadget state D1 transaction", () => {
	it("settles one CAS winner, replays its immutable result after later changes, and rejects changed intent", async () => {
		const { db, params } = fixture();
		const first = await mutateGadgetState(db, params);
		expect(first.status).toBe("applied");
		expect(JSON.parse(first.result!).revision).toBe(1);
		const rival = await mutateGadgetState(db, {
			...params,
			idempotencyKey: "rival",
			digest: "rival",
		});
		expect(rival.status).toBe("conflict");
		await mutateGadgetState(db, {
			...params,
			idempotencyKey: "second",
			digest: "second",
			expectedRevision: 1,
			value: '{"cursor":2}',
		});
		expect((await mutateGadgetState(db, params)).result).toBe(first.result);
		expect(
			(await mutateGadgetState(db, { ...params, digest: "changed" })).digest,
		).toBe(params.digest);
		expect((await getGadgetState(db, params, params.key))?.revision).toBe(2);
	});
	it("races two CAS attempts and rolls back state when receipt settlement fails", async () => {
		const { db, params, sqlite } = fixture();
		const results = await Promise.all([
			mutateGadgetState(db, params),
			mutateGadgetState(db, {
				...params,
				idempotencyKey: "racer",
				digest: "racer",
			}),
		]);
		expect(results.map((row) => row.status).sort()).toEqual([
			"applied",
			"conflict",
		]);
		sqlite.exec(
			"CREATE TRIGGER refuse_settlement BEFORE UPDATE ON os_gadget_state_mutations BEGIN SELECT RAISE(ABORT, 'receipt settlement failed'); END",
		);
		await expect(
			mutateGadgetState(db, {
				...params,
				key: "rollback",
				idempotencyKey: "rollback",
				digest: "rollback",
			}),
		).rejects.toThrow();
		expect(await getGadgetState(db, params, "rollback")).toBeUndefined();
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS count FROM os_gadget_state_mutations WHERE idempotency_key='rollback'",
				)
				.get()?.count,
		).toBe(0);
	});

	it("preserves revision and provenance on tombstone and refuses recreate at revision zero", async () => {
		const { db, params } = fixture();
		await mutateGadgetState(db, params);
		await mutateGadgetState(db, {
			...params,
			idempotencyKey: "delete",
			digest: "delete",
			expectedRevision: 1,
			value: null,
			deleted: true,
		});
		const tombstone = await getGadgetState(db, params, params.key);
		expect(tombstone).toMatchObject({
			revision: 2,
			deleted: true,
			value: null,
			accessEnvelope: params.accessEnvelope,
		});
		expect(
			(
				await mutateGadgetState(db, {
					...params,
					idempotencyKey: "recreate",
					digest: "recreate",
				})
			).status,
		).toBe("conflict");
		expect(
			(
				await mutateGadgetState(db, {
					...params,
					idempotencyKey: "restore",
					digest: "restore",
					expectedRevision: 2,
				})
			).status,
		).toBe("applied");
	});
	it.each([
		"UPDATE os_gadgets SET status='archived'",
		"UPDATE os_workspaces SET status='archived'",
		"UPDATE os_gadgets SET current_revision_id='new'",
		"UPDATE skill_runs SET execution_epoch=1",
		"UPDATE skill_runs SET workflow_retired_at='retired'",
		"UPDATE skill_runs SET restart_requested_at='pending'",
		"UPDATE os_gadget_executions SET status='completed'",
		"UPDATE os_gadget_executions SET granted_capabilities='[]'",
	])("fences mutation after authority changes: %s", async (change) => {
		const { sqlite, db, params } = fixture();
		expect(await hasLiveGadgetStateFence(db, params)).toBe(true);
		sqlite.exec(change);
		expect((await mutateGadgetState(db, params)).status).toBe("conflict");
		expect(await getGadgetState(db, params, params.key)).toBeUndefined();
	});
	it("uses literal key prefixes and tenant-bound reads", async () => {
		const { db, params } = fixture();
		for (const key of ["sync:a", "sync:b", "other:a"])
			await mutateGadgetState(db, {
				...params,
				key,
				idempotencyKey: key,
				digest: key,
			});
		expect(
			(
				await listGadgetState(db, params, {
					prefix: "sync:",
					after: "sync:a",
					limit: 10,
				})
			).map((row) => row.key),
		).toEqual(["sync:b"]);
		expect(
			await getGadgetState(
				db,
				{ ...params, organizationId: "foreign" },
				"sync:a",
			),
		).toBeUndefined();
	});
});
