import { DatabaseSync } from "node:sqlite";
import {
	encodeBase64,
	importSigningKey,
	type SigningKey,
	verifyChain,
} from "@tedix/agent-governance/seal";
import { createDbQueryClient } from "@tedix/db/query-client";
import { listGatewayChangeRecordCheckpoints } from "@tedix/db/queries/gateway-change-records";
import {
	gatewayChangeRecordCheckpoints,
	gatewayChangeRecords,
} from "@tedix/db/schema/gateway-change-records";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	MAX_ORGANIZATIONS_PER_RUN,
	MAX_RECORDS_PER_RUN,
	RECORDS_PER_CHECKPOINT,
	runGatewayChangeRecordSealer,
	SETTLING_WINDOW_MS,
	sealGatewayChangeRecordRuns,
} from "./gateway-change-record-sealer";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
});

function ledger() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec(schemaDdl(gatewayChangeRecords, gatewayChangeRecordCheckpoints));
	const facade = createD1Facade(sqlite);
	const db = createDbQueryClient(facade);
	let n = 0;
	const insert = (organizationId: string, recordedAt: string) => {
		n += 1;
		const resource = "tool:send_example";
		sqlite
			.prepare(
				"INSERT INTO gateway_change_records (id, organization_id, resource, actor_id, recorded_at, record) VALUES (?, ?, ?, 'user-1', ?, ?)",
			)
			.run(
				`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
				organizationId,
				resource,
				recordedAt,
				JSON.stringify({
					resource,
					operation: "send_example",
					actor: { id: "user-1", kind: "user", organizationId },
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
		return n;
	};
	const export_ = (organizationId: string) =>
		sqlite
			.prepare(
				"SELECT * FROM gateway_change_records WHERE organization_id = ? ORDER BY sequence",
			)
			.all(organizationId)
			.map((row) => ({
				...JSON.parse(String(row.record)),
				id: row.id,
				sequence: row.sequence,
				recordedAt: row.recorded_at,
				recordDigest: row.record_digest,
				chainHash: row.chain_hash,
			}));
	const checkpoints = async (organizationId: string) =>
		(
			await listGatewayChangeRecordCheckpoints(db, organizationId, {
				limit: 1000,
			})
		).map((row) => ({
			...row,
			envelope: row.envelope ? JSON.parse(row.envelope) : null,
		}));
	return { sqlite, facade, db, insert, export_, checkpoints };
}

async function throwawayKey(): Promise<{ key: SigningKey; pkcs8: string }> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const pkcs8 = encodeBase64(
		new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
	);
	return { key: await importSigningKey(pkcs8), pkcs8 };
}

const quiet = () => {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
};

describe("gateway change record sealer", () => {
	it("seals in sequence order up to the first unsettled row, including late writes", async () => {
		quiet();
		const { insert, db, export_, checkpoints } = ledger();
		const { key } = await throwawayKey();
		const signer = { privateKey: key.privateKey, keyId: "key-1" };
		insert("org-a", ago(5 * 60_000)); // 1
		insert("org-a", ago(10_000)); // 2: still settling
		// 3: a late background write, recorded before 1 but inserted after 2.
		insert("org-a", ago(10 * 60_000));

		const first = await sealGatewayChangeRecordRuns(db, NOW, signer);
		expect(first).toMatchObject({ recordsSealed: 1, recordsUnsealed: 2 });
		// Row 3 is old, but sealing it now would leave row 2 behind the chain.
		expect(export_("org-a").map((row) => row.chainHash !== null)).toEqual([
			true,
			false,
			false,
		]);
		expect(first.oldestUnsealedAgeSeconds).toBe(600);

		// A write that lands after sealing, recorded long before, follows on.
		insert("org-a", ago(60 * 60_000)); // 4
		const later = NOW + SETTLING_WINDOW_MS;
		expect(await sealGatewayChangeRecordRuns(db, later, signer)).toMatchObject({
			organizationsSealed: 1,
			recordsSealed: 3,
			checkpointsWritten: 1,
			recordsUnsealed: 0,
		});
		const verified = await verifyChain({
			records: export_("org-a"),
			checkpoints: await checkpoints("org-a"),
			publicKey: key.publicKey,
		});
		expect(verified).toMatchObject({
			ok: true,
			recordsVerified: 4,
			checkpointsVerified: 2,
		});

		// Idempotent: nothing left, nothing written.
		expect(await sealGatewayChangeRecordRuns(db, later, signer)).toMatchObject({
			recordsSealed: 0,
			checkpointsWritten: 0,
		});
		expect(await checkpoints("org-a")).toHaveLength(2);
	});

	it("keeps each organization's chain separate and bounds the work per run", async () => {
		quiet();
		const { insert, db, export_, checkpoints } = ledger();
		const organizations = MAX_ORGANIZATIONS_PER_RUN + 2;
		for (let i = 0; i < organizations; i += 1) insert(`org-${i}`, ago(120_000));
		const run = await sealGatewayChangeRecordRuns(db, NOW, null);
		expect(run).toMatchObject({
			organizationsSealed: MAX_ORGANIZATIONS_PER_RUN,
			recordsUnsealed: 2,
		});
		// Oldest waiting first: the last two organizations wait for the next run.
		expect(export_(`org-${organizations - 1}`)[0]?.chainHash).toBeNull();
		await sealGatewayChangeRecordRuns(db, NOW, null);
		for (let i = 0; i < organizations; i += 1)
			expect(
				await verifyChain({
					records: export_(`org-${i}`),
					checkpoints: await checkpoints(`org-${i}`),
					publicKey: null,
					allowUnsigned: true,
				}),
			).toMatchObject({ ok: true, recordsVerified: 1 });
	});

	it("caps records per run and per checkpoint", async () => {
		quiet();
		const { insert, db, checkpoints } = ledger();
		for (let i = 0; i < MAX_RECORDS_PER_RUN + 5; i += 1)
			insert("org-a", ago(120_000));
		const run = await sealGatewayChangeRecordRuns(db, NOW, null);
		expect(run).toMatchObject({
			recordsSealed: MAX_RECORDS_PER_RUN,
			checkpointsWritten: MAX_RECORDS_PER_RUN / RECORDS_PER_CHECKPOINT,
			recordsUnsealed: 5,
		});
		const written = await checkpoints("org-a");
		expect(
			written.every((cp) => cp.recordCount <= RECORDS_PER_CHECKPOINT),
		).toBe(true);
		expect(
			written.every((cp) => cp.envelope === null && cp.keyId === null),
		).toBe(true);
	});

	it("does not fork when two runs seal the same organization at once", async () => {
		quiet();
		const { insert, db, export_, checkpoints } = ledger();
		const { key } = await throwawayKey();
		const signer = { privateKey: key.privateKey, keyId: "key-1" };
		for (let i = 0; i < 3; i += 1) insert("org-a", ago(120_000));
		const [one, two] = await Promise.all([
			sealGatewayChangeRecordRuns(db, NOW, signer),
			sealGatewayChangeRecordRuns(db, NOW + 1, signer),
		]);
		expect(one.recordsSealed + two.recordsSealed).toBe(3);
		expect(one.conflicts + two.conflicts).toBe(1);
		expect(await checkpoints("org-a")).toHaveLength(1);
		expect(
			await verifyChain({
				records: export_("org-a"),
				checkpoints: await checkpoints("org-a"),
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: true, recordsVerified: 3 });
	});

	it("reads the signing key from the environment and logs once when it is absent", async () => {
		const { insert, facade, export_, checkpoints } = ledger();
		insert("org-a", ago(120_000));
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await runGatewayChangeRecordSealer(
			{ DB: facade } as unknown as CloudflareEnv,
			NOW,
		);
		const warnings = warn.mock.calls.map(([line]) => JSON.parse(String(line)));
		expect(warnings).toEqual([
			expect.objectContaining({
				event: "gateway_change_records.seal.signing_off",
			}),
		]);
		const runLine = log.mock.calls
			.map(([line]) => JSON.parse(String(line)))
			.find((entry) => entry.event === "gateway_change_records.seal.run");
		expect(runLine).toEqual({
			event: "gateway_change_records.seal.run",
			organizationsSealed: 1,
			recordsSealed: 1,
			checkpointsWritten: 1,
			conflicts: 0,
			failedOrganizations: 0,
			recordsUnsealed: 0,
			oldestUnsealedAgeSeconds: null,
			signing: "off",
		});

		const { key, pkcs8 } = await throwawayKey();
		insert("org-a", ago(120_000));
		warn.mockClear();
		log.mockClear();
		await runGatewayChangeRecordSealer(
			{
				DB: facade,
				CHANGE_RECORD_SIGNING_KEY: pkcs8,
			} as unknown as CloudflareEnv,
			NOW,
		);
		expect(warn).not.toHaveBeenCalled();
		// Neither the secret nor the key appears in any log line.
		expect(JSON.stringify(log.mock.calls)).not.toContain(pkcs8.slice(20, 60));
		const stored = await checkpoints("org-a");
		expect(stored.map((cp) => cp.keyId)).toEqual([null, key.fingerprint]);
		// The unsigned first checkpoint verifies only when unsigned ones are allowed.
		expect(
			await verifyChain({
				records: export_("org-a"),
				checkpoints: stored,
				publicKey: key.publicKey,
				allowUnsigned: true,
			}),
		).toMatchObject({ ok: true, recordsVerified: 2, checkpointsVerified: 2 });

		await expect(
			runGatewayChangeRecordSealer(
				{
					DB: facade,
					CHANGE_RECORD_SIGNING_KEY: "bm90LWEta2V5",
				} as unknown as CloudflareEnv,
				NOW,
			),
		).rejects.toThrow(/not a base64 PKCS#8 Ed25519 private key/);
	});
});
