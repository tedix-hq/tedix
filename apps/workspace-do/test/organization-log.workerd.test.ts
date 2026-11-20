import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import type { OrganizationLogStore } from "../src/organization-log";
import { expect, test } from "vite-plus/test";
import {
	type DayManifest,
	dayManifestKey,
	evidenceBundleKey,
} from "@tedix/agent-governance/evidence";
import { sealRun, verifyChain } from "@tedix/agent-governance/seal";
import type {
	OrganizationLogRecord,
	OrganizationLogRuntime,
} from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import type { GatewayChangeRecordCheckpointRow } from "@tedix/db/queries/gateway-change-records";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";

const ORG = "org_log_test";
const SUBJECT = "3f2b8c1e-6d4a-4f7b-9a2e-5c1d8e7f6a90";
const bindings = env as unknown as {
	ORGANIZATION_LOG: DurableObjectNamespace;
	R2_BUCKET: R2Bucket;
};

function store(organizationId = ORG) {
	return durableObjectStubByName(
		bindings.ORGANIZATION_LOG,
		env,
		`org:${organizationId}`,
	) as unknown as OrganizationLogRuntime & DurableObjectStub;
}

const id = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function body(n: number) {
	return {
		resource: "tool:send_example",
		operation: "send_example",
		actor: { id: "user-1", kind: "user", organizationId: ORG },
		source: { surface: "mcp_gateway" },
		decision: {
			verdict: "allow" as const,
			gate: "tool_scope" as const,
			reason: "allowed",
			riskTier: "bounded_write" as const,
			blastRadius: "single_resource" as const,
		},
		outcome: "applied" as const,
		argsHash: `hash-${n}`,
		...(n % 2 === 0
			? { subject: { kind: "work_item" as const, id: SUBJECT } }
			: {}),
	};
}

/** Main's sealed history: checkpoints over global sequences, bundles in R2. */
async function mainHistory(runs: number[][]) {
	const records: OrganizationLogRecord[] = [];
	const checkpoints: GatewayChangeRecordCheckpointRow[] = [];
	let previousChainHash: string | null = null;
	let previousCheckpointDigest: string | null = null;
	for (const run of runs) {
		const content = run.map((sequence) => ({
			...body(sequence),
			id: id(sequence),
			sequence,
			recordedAt: new Date(
				Date.UTC(2026, 10, 19, 10, 0, sequence),
			).toISOString(),
		}));
		const sealedAt = new Date(
			Date.UTC(2026, 10, 19, 11, run[0]!),
		).toISOString();
		const { seals, checkpoint } = await sealRun({
			organizationId: ORG,
			records: content,
			previousChainHash,
			previousCheckpointDigest,
			sealedAt,
		});
		const row: GatewayChangeRecordCheckpointRow = {
			id: crypto.randomUUID(),
			organizationId: ORG,
			firstSequence: checkpoint.firstSequence,
			lastSequence: checkpoint.lastSequence,
			recordCount: checkpoint.recordCount,
			headChainHash: checkpoint.headChainHash,
			previousCheckpointDigest: checkpoint.previousCheckpointDigest,
			previousChainHash: checkpoint.previousChainHash,
			checkpointDigest: checkpoint.digest,
			sealedAt,
			envelope: null,
			keyId: null,
			evidenceBundleKey: null,
		};
		row.evidenceBundleKey = evidenceBundleKey(row);
		await bindings.R2_BUCKET.put(
			row.evidenceBundleKey,
			JSON.stringify({ bundle: row.id }),
		);
		content.forEach((record, i) => records.push({ ...record, ...seals[i]! }));
		checkpoints.push(row);
		previousChainHash = checkpoint.headChainHash;
		previousCheckpointDigest = checkpoint.digest;
	}
	return { records, checkpoints };
}

test("an organization moves from main into its store and keeps one verifiable chain", async () => {
	const log = store();
	const append = (n: number) =>
		log.organizationLogAppend(ORG, {
			...body(n),
			id: id(n),
			recordedAt: new Date(Date.UTC(2026, 10, 20, 9, 0, n)).toISOString(),
		});

	// Before its move, appends go to main and reads are main's.
	expect(await append(100)).toEqual({ status: "forward" });
	expect(await log.organizationLogList(ORG, { limit: 10 })).toEqual({
		status: "not_live",
	});

	// Sealed history is copied while writes still go to main.
	const history = await mainHistory([[3, 5, 8], [9, 12], [14]]);
	const page = (from: number, to: number) => ({
		records: history.records.filter((r) => {
			const c = history.checkpoints.slice(from, to);
			return c.some(
				(cp) => r.sequence >= cp.firstSequence && r.sequence <= cp.lastSequence,
			);
		}),
		checkpoints: history.checkpoints.slice(from, to),
	});
	await log.organizationLogImport(ORG, page(0, 1));
	// A page that does not continue the chain is refused.
	await runInDurableObject(log, (instance) =>
		expect(
			(instance as OrganizationLogStore).organizationLogImport(ORG, page(2, 3)),
		).rejects.toThrow(/do not continue/),
	);

	// Cutover: appends are held; a retry of a record main also got is dropped.
	await log.organizationLogBeginCutover(ORG);
	expect((await append(101)).status).toBe("held");
	expect(
		(
			await log.organizationLogAppend(ORG, {
				...body(14),
				id: id(14),
				recordedAt: history.records.at(-1)!.recordedAt,
			})
		).status,
	).toBe("held");
	await log.organizationLogImport(ORG, page(1, 3));
	await runInDurableObject(log, (instance) =>
		expect(
			(instance as OrganizationLogStore).organizationLogFinishCutover(ORG, {
				sequence: 12,
				chainHash: null,
			}),
		).rejects.toThrow(/not copied everything/),
	);
	expect(
		await log.organizationLogFinishCutover(ORG, {
			sequence: 14,
			chainHash: history.checkpoints.at(-1)!.headChainHash,
		}),
	).toEqual({ chained: 1, dropped: 1 });

	// Live: concurrent appends chain one after another.
	const [a, b] = await Promise.all([append(102), append(103)]);
	expect([a.status, b.status]).toEqual(["stored", "stored"]);
	const range = await log.organizationLogRange(
		ORG,
		{ from: "2026-11-19T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" },
		{ limit: 100 },
	);
	if (range.status !== "live") throw new Error("not live");
	expect(range.value.records.map((r) => r.sequence)).toEqual([
		3, 5, 8, 9, 12, 14, 15, 16, 17,
	]);
	expect(range.value.count).toBe(9);
	const bySubject = await log.organizationLogRange(
		ORG,
		{
			from: "2026-11-19T00:00:00.000Z",
			until: "2026-11-21T00:00:00.000Z",
			subjectId: SUBJECT,
		},
		{ limit: 100 },
	);
	expect(bySubject.status === "live" && bySubject.value.count).toBe(4);

	// The alarm closes a checkpoint over the new records and archives it.
	expect(await runDurableObjectAlarm(log)).toBe(true);
	const checkpoints = await log.organizationLogCheckpoints(ORG, { limit: 10 });
	if (checkpoints.status !== "live") throw new Error("not live");
	const own = checkpoints.value.at(-1)!;
	expect(own).toMatchObject({
		firstSequence: 15,
		lastSequence: 17,
		previousChainHash: history.checkpoints.at(-1)!.headChainHash,
		previousCheckpointDigest: history.checkpoints.at(-1)!.checkpointDigest,
	});
	expect(own.evidenceBundleKey).toBe(evidenceBundleKey(own));
	const manifest = (await (await bindings.R2_BUCKET.get(
		dayManifestKey(ORG, own.sealedAt.slice(0, 10)),
	))!.json()) as DayManifest;
	expect(manifest.checkpoints.map((c) => c.lastSequence)).toContain(17);

	expect(
		await verifyChain({
			records: range.value.records as never,
			checkpoints: checkpoints.value.map((c) => ({ ...c, envelope: null })),
			publicKey: null,
			allowUnsigned: true,
		}),
	).toMatchObject({ ok: true, recordsVerified: 9, checkpointsVerified: 4 });
});
