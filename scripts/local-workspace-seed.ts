import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { withBearerToken } from "@tedix/api-client/adapters";
import { createLink, createORPCClient } from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";
import type { RouterContractClient } from "@tedix/api-contract/types";
import { LOCAL_DEMO_TOKEN } from "../packages/auth/src/local-demo";
import { collectWorkspaceRows } from "./migrate-workspaces/export";
import { RowDigest, type StoredRow } from "./migrate-workspaces/rows";
import { Snapshot } from "./migrate-workspaces/source";
import { mappingFor } from "./migrate-workspaces/tables";
import {
	RemoteWorkspaceStore,
	readAllRows,
	type WorkspaceStore,
} from "./migrate-workspaces/target";

/** Seed only unactivated objects: a restart must preserve edits made in the demo. */
export async function seedWorkspaceFiles(
	store: WorkspaceStore,
	tables: Map<string, StoredRow[]>,
) {
	if ((await store.describe()).outputAuthority === "object") return;
	for (const [table, rows] of tables) {
		for (let offset = 0; offset < rows.length; offset += 1000)
			await store.importRows({
				batchId: `local-demo:${table}:${offset}`,
				table,
				rows: rows.slice(offset, offset + 1000),
			});
	}
	for (const [table, rows] of tables) {
		const source = new RowDigest(mappingFor(table).primaryKey);
		const target = new RowDigest(mappingFor(table).primaryKey);
		for (const row of rows) source.add(row);
		for (const row of await readAllRows(store, table)) target.add(row);
		if (source.hex() !== target.hex())
			throw new Error(`Local workspace seed differs: ${table}`);
	}
	const current = await store.describe();
	if (!store.activate || !current.importGeneration)
		throw new Error("Local workspace seed was not imported");
	await store.activate({
		importGeneration: current.importGeneration,
		reconciliationRef: "local-demo:verified-seed",
	});
}

if (import.meta.main) {
	const state = process.env.TEDIX_LOCAL_PERSIST_TO;
	const port = process.env.TEDIX_LOCAL_WORKSPACE_PORT;
	const token = process.env.TEDIX_LOCAL_WORKSPACE_SEED_TOKEN;
	if (!state || !port || !token || process.env.TEDIX_LOCAL_RUN_MODE !== "demo")
		throw new Error("Workspace seeding requires the local demo launcher");
	const directory = join(resolve(state), "v3/d1/miniflare-D1DatabaseObject");
	const files = readdirSync(directory).filter(
		(name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
	);
	if (files.length !== 1)
		throw new Error("Expected exactly one isolated local D1 database");
	const snapshot = Snapshot.open({ main: join(directory, files[0]!) });
	const client: RouterContractClient<ApiContract> = createORPCClient(
		createLink({
			url: `http://localhost:${process.env.TEDIX_LOCAL_API_PORT || "8790"}/rpc`,
			getHeaders: withBearerToken(() => LOCAL_DEMO_TOKEN),
		}),
	);
	try {
		for (const ref of snapshot.listWorkspaces()) {
			const store = new RemoteWorkspaceStore(
				`http://localhost:${port}`,
				token,
				ref,
			);
			await seedWorkspaceFiles(
				store,
				collectWorkspaceRows(snapshot, ref, {}).tables,
			);
			// Listing republishes the object rows into the shared routing index.
			const { items } = await client.osWorkspaces.outputs.list({
				workspaceId: ref.workspaceId,
				limit: 100,
			});
			for (const output of items) {
				const deadline = Date.now() + 30_000;
				for (;;) {
					try {
						await client.osWorkspaces.outputs.get({ outputId: output.id });
						break;
					} catch (error) {
						if (
							!(error instanceof Error) ||
							!("code" in error) ||
							error.code !== "NOT_FOUND" ||
							Date.now() >= deadline
						)
							throw error;
					}
					await Bun.sleep(100);
				}
			}
		}
	} finally {
		snapshot.close();
	}
}
