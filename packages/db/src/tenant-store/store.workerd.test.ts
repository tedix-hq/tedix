/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import type { TenantStore, TenantStoreImportRow } from "./store";
import { routeTenantQuery, tenantStoreName, tenantStoreStub } from "./router";
import type { TenantStoreFixture } from "../../test/tenant-store/worker";

const bindings = env as unknown as {
	TENANT_STORE: DurableObjectNamespace<TenantStore>;
	TENANT_STORE_FIXTURE: DurableObjectNamespace<TenantStoreFixture>;
};

let counter = 0;
function scope(label: string) {
	counter += 1;
	return {
		organizationId: `org_${label}_${counter}`,
		workspaceId: `ws:${label}/${counter}`,
	};
}

function note(
	id: string,
	at: { organizationId: string; workspaceId: string },
	extra: Partial<TenantStoreImportRow> = {},
): TenantStoreImportRow {
	return {
		id,
		organization_id: at.organizationId,
		workspace_id: at.workspaceId,
		body: `note ${id}`,
		payload: '{"kept":"verbatim"}',
		pinned: 1,
		...extra,
	};
}

/** Await an RPC call that must fail; `expect().rejects` leaks RPC rejections. */
async function failure(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the RPC call to fail");
}

describe("TenantStore", () => {
	it("migrates on wake and binds to its first scope", async () => {
		const at = scope("wake");
		const description = await routeTenantQuery(
			bindings.TENANT_STORE,
			bindings,
			at,
			(store, s) => store.describe(s),
		);
		expect(description).toMatchObject(at);
		expect(description.migrations).toEqual([
			"20261105190055_tenant_store_core",
			"20261106092045_tenant_memory",
			"20261106092201_tenant_memory_projections",
			"20261106093101_tenant_memory_state",
			"20261107171152_workspace_outputs",
			"20261107194341_memory_facts_expertise_live",
			"20261108100233_workspace_chat_tables",
		]);
		// A second call is served by the same object and keeps its identity.
		const again = await tenantStoreStub(
			bindings.TENANT_STORE,
			bindings,
			at,
		).describe(at);
		expect(again).toEqual(description);
	});

	it("routes each workspace to its own object", async () => {
		const a = scope("route");
		const b = { ...a, workspaceId: `${a.workspaceId}-other` };
		expect(tenantStoreName(a)).toBe(
			`${encodeURIComponent(a.organizationId)}:${encodeURIComponent(a.workspaceId)}`,
		);
		const first = tenantStoreStub(bindings.TENANT_STORE_FIXTURE, bindings, a);
		const second = tenantStoreStub(bindings.TENANT_STORE_FIXTURE, bindings, b);
		expect(first.id.equals(second.id)).toBe(false);
		await first.importRows(a, {
			batchId: "a-1",
			table: "fixture_notes",
			rows: [note("n1", a)],
		});
		expect(await first.countNotes()).toBe(1);
		expect(await second.countNotes()).toBe(0);
	});

	it("rejects a scope the object does not serve", async () => {
		const a = scope("reject");
		const b = scope("reject");
		const named = tenantStoreStub(bindings.TENANT_STORE, bindings, a);
		expect(await failure(() => named.describe(b))).toContain(
			"TenantStore scope does not match this object",
		);
		// Without a name, the stored identity is the guard.
		const unnamed = bindings.TENANT_STORE.get(
			bindings.TENANT_STORE.newUniqueId(),
		);
		await unnamed.describe(a);
		expect(await failure(() => unnamed.describe(b))).toContain(
			"TenantStore scope does not match this object",
		);
		expect(
			await failure(() => named.describe({ organizationId: a.organizationId })),
		).toContain("TenantStore scope requires workspaceId");
	});
});

describe("TenantStore bulk import", () => {
	it("writes raw values once per batch ID", async () => {
		const at = scope("import");
		const store = tenantStoreStub(bindings.TENANT_STORE_FIXTURE, bindings, at);
		const batch = {
			batchId: "notes-0001",
			table: "fixture_notes",
			rows: [note("n1", at), note("n2", at, { body: null, pinned: 0 })],
		};
		expect(await store.importRows(at, batch)).toEqual({
			batchId: "notes-0001",
			table: "fixture_notes",
			rowCount: 2,
			status: "imported",
		});
		expect(await store.importRows(at, batch)).toMatchObject({
			rowCount: 2,
			status: "duplicate",
		});
		expect(await store.countNotes()).toBe(2);
		expect(await store.readNote("n1")).toMatchObject({
			payload: '{"kept":"verbatim"}',
			pinned: 1,
		});
		expect(
			await failure(() =>
				store.importRows(at, { ...batch, table: "tenant_store_identity" }),
			),
		).toContain("cannot import table tenant_store_identity");
	});

	it("loads nothing when any row in the batch fails", async () => {
		const at = scope("atomic");
		const store = tenantStoreStub(bindings.TENANT_STORE_FIXTURE, bindings, at);
		await store.importRows(at, {
			batchId: "seed",
			table: "fixture_notes",
			rows: [note("existing", at)],
		});
		const cases: [TenantStoreImportRow, string][] = [
			[note("x", at, { workspace_id: "elsewhere" }), "outside this workspace"],
			[note("x", at, { unknown: "v" }), "has no column unknown"],
			[note("existing", at), "UNIQUE constraint failed"],
		];
		for (const [bad, message] of cases) {
			expect(
				await failure(() =>
					store.importRows(at, {
						batchId: `bad-${message}`,
						table: "fixture_notes",
						rows: [note("fresh", at), bad],
					}),
				),
			).toContain(message);
		}
		expect(await store.countNotes()).toBe(1);
		// A failed batch leaves no receipt, so it can be retried.
		expect(
			await store.importRows(at, {
				batchId: "bad-UNIQUE constraint failed",
				table: "fixture_notes",
				rows: [note("fresh", at)],
			}),
		).toMatchObject({ status: "imported", rowCount: 1 });
	});

	it("imports 10,000 rows in 1,000-row batches", async () => {
		const at = scope("bulk");
		const store = tenantStoreStub(bindings.TENANT_STORE_FIXTURE, bindings, at);
		const started = performance.now();
		for (let batch = 0; batch < 10; batch += 1) {
			const rows = Array.from({ length: 1000 }, (_, i) =>
				note(`b${batch}-${i}`, at, { body: "x".repeat(200) }),
			);
			await store.importRows(at, {
				batchId: `bulk-${batch}`,
				table: "fixture_notes",
				rows,
			});
		}
		const elapsed = performance.now() - started;
		expect(await store.countNotes()).toBe(10_000);
		console.log(
			`[tenant-store] imported 10000 rows in ${elapsed.toFixed(0)} ms (local workerd)`,
		);
	});
});
