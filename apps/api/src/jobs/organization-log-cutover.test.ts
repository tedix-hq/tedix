import { DatabaseSync } from "node:sqlite";
import type {
	OrganizationLogImportPage,
	OrganizationLogRuntime,
	OrganizationLogState,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	gatewayChangeRecordCheckpoints,
	gatewayChangeRecords,
} from "@tedix/db/schema/gateway-change-records";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { sealGatewayChangeRecordRuns } from "./gateway-change-record-sealer";
import { runOrganizationLogCutover } from "./organization-log-cutover";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});

/** The store's side of the protocol: state, tail and what it was handed. */
function stubStore() {
	let state: OrganizationLogState = "passthrough";
	let tail: { sequence: number; chainHash: string | null } | null = null;
	let cutoverStartedAt: string | null = null;
	const imports: OrganizationLogImportPage[] = [];
	const finished: Array<{ sequence: number; chainHash: string | null }> = [];
	const log = {
		organizationLogAvailable: async () => true,
		organizationLogStatus: async () => ({
			available: true,
			state,
			tail: tail && { ...tail, checkpointDigest: null },
			pending: 0,
			oldestPendingAt: null,
			cutoverStartedAt,
			mainTailSequence: state === "live" ? 3 : null,
		}),
		organizationLogImport: async (
			_org: string,
			page: OrganizationLogImportPage,
		) => {
			imports.push(page);
			const head = page.checkpoints.at(-1)!;
			tail = { sequence: head.lastSequence, chainHash: head.headChainHash };
			return { ...tail, checkpointDigest: head.checkpointDigest };
		},
		organizationLogBeginCutover: async () => {
			state = "cutover";
			cutoverStartedAt = new Date(NOW - 3 * 60_000).toISOString();
		},
		organizationLogFinishCutover: async (
			_org: string,
			expected: { sequence: number; chainHash: string | null },
		) => {
			finished.push(expected);
			state = "live";
			return { chained: 0, dropped: 0 };
		},
	} as unknown as OrganizationLogRuntime;
	return { log, imports, finished, state: () => state };
}

it("copies bundled checkpoints, begins the cutover when caught up and finishes at main's head", async () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(gatewayChangeRecords, gatewayChangeRecordCheckpoints));
	const db = createDbQueryClient(createD1Facade(sqlite));
	for (let n = 1; n <= 3; n++)
		sqlite
			.prepare(
				"INSERT INTO gateway_change_records (id, organization_id, resource, actor_id, recorded_at, record) VALUES (?, 'org-a', 'tool:x', 'user-1', ?, ?)",
			)
			.run(
				`00000000-0000-4000-8000-00000000000${n}`,
				new Date(NOW - 10 * 60_000).toISOString(),
				JSON.stringify({
					resource: "tool:x",
					operation: "x",
					actor: { id: "user-1", kind: "user", organizationId: "org-a" },
					source: { surface: "mcp_gateway" },
					decision: {
						verdict: "allow",
						gate: "tool_scope",
						reason: "allowed",
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
					outcome: "applied",
					argsHash: `hash-${n}`,
				}),
			);
	await sealGatewayChangeRecordRuns(db, NOW, null);
	const store = stubStore();

	// No bundle yet: nothing is copied and the cutover does not begin.
	await runOrganizationLogCutover(db, store.log, NOW);
	expect(store.imports).toHaveLength(0);
	expect(store.state()).toBe("passthrough");

	sqlite.exec(
		"UPDATE gateway_change_record_checkpoints SET evidence_bundle_key = 'bundle'",
	);
	expect(await runOrganizationLogCutover(db, store.log, NOW)).toMatchObject({
		recordsCopied: 3,
		checkpointsCopied: 1,
		cutoversBegun: 1,
	});
	expect(store.imports[0]?.records.map((r) => r.sequence)).toEqual([1, 2, 3]);

	const [head] = sqlite
		.prepare("SELECT head_chain_hash FROM gateway_change_record_checkpoints")
		.all() as Array<{ head_chain_hash: string }>;
	expect(await runOrganizationLogCutover(db, store.log, NOW)).toMatchObject({
		cutoversFinished: 1,
	});
	expect(store.finished).toEqual([
		{ sequence: 3, chainHash: head!.head_chain_hash },
	]);
	expect(await runOrganizationLogCutover(db, store.log, NOW)).toMatchObject({
		organizationsLive: 1,
	});
});
