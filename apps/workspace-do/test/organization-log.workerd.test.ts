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
import {
	importSigningKey,
	recordDigest,
	verifyChain,
} from "@tedix/agent-governance/seal";
import { GatewayChangeRecordSchema } from "@tedix/api-contract/schemas/audit";
import type { OrganizationLogRuntime } from "@tedix/db/queries/durable-sqlite/organization-log-rpc";
import { durableObjectStubByName } from "@tedix/worker-kit/durable-objects";

const ORG = "org_log_test";
const SUBJECT = "3f2b8c1e-6d4a-4f7b-9a2e-5c1d8e7f6a90";
const bindings = env as unknown as {
	ORGANIZATION_LOG: DurableObjectNamespace;
	R2_BUCKET: R2Bucket;
	CHANGE_RECORD_SIGNING_KEY: string;
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

test("a new organization's store is live from its first append and seals it", async () => {
	const log = store();
	const append = (n: number) =>
		log.organizationLogAppend(ORG, {
			...body(n),
			id: id(n),
			recordedAt: new Date(Date.UTC(2026, 10, 20, 9, 0, n)).toISOString(),
		});

	// No history and no move: the first append is chained at sequence 1.
	const first = await append(1);
	if (first.status !== "stored") throw new Error("not stored");
	expect(first.record.sequence).toBe(1);
	expect((await log.organizationLogStatus(ORG)).state).toBe("live");
	// A retry of the same id returns the stored record.
	expect(await append(1)).toEqual(first);

	// A stored record reads back with the digest its content hashes to.
	const read = await log.organizationLogGet(ORG, id(1));
	if (read.status !== "live" || !read.value) throw new Error("not stored");
	const {
		recordDigest: storedDigest,
		chainHash: _chain,
		...content
	} = read.value;
	expect(await recordDigest(GatewayChangeRecordSchema.parse(content))).toBe(
		storedDigest,
	);

	// Concurrent appends chain one after another.
	const [a, b] = await Promise.all([append(2), append(3)]);
	expect([a.status, b.status]).toEqual(["stored", "stored"]);
	const range = await log.organizationLogRange(
		ORG,
		{ from: "2026-11-19T00:00:00.000Z", until: "2026-11-21T00:00:00.000Z" },
		{ limit: 100 },
	);
	if (range.status !== "live") throw new Error("not live");
	expect(range.value.records.map((r) => r.sequence)).toEqual([1, 2, 3]);
	expect(range.value.count).toBe(3);
	const bySubject = await log.organizationLogRange(
		ORG,
		{
			from: "2026-11-19T00:00:00.000Z",
			until: "2026-11-21T00:00:00.000Z",
			subjectId: SUBJECT,
		},
		{ limit: 100 },
	);
	expect(bySubject.status === "live" && bySubject.value.count).toBe(1);

	// The alarm closes a signed genesis checkpoint and archives it.
	expect(await runDurableObjectAlarm(log)).toBe(true);
	const checkpoints = await log.organizationLogCheckpoints(ORG, { limit: 10 });
	if (checkpoints.status !== "live") throw new Error("not live");
	expect(checkpoints.value).toHaveLength(1);
	const own = checkpoints.value[0]!;
	expect(own).toMatchObject({
		firstSequence: 1,
		lastSequence: 3,
		previousChainHash: null,
		previousCheckpointDigest: null,
	});
	expect(own.evidenceBundleKey).toBe(evidenceBundleKey(own));
	const manifest = (await (await bindings.R2_BUCKET.get(
		dayManifestKey(ORG, own.sealedAt.slice(0, 10)),
	))!.json()) as DayManifest;
	expect(manifest.checkpoints.map((c) => c.lastSequence)).toEqual([3]);

	const key = await importSigningKey(bindings.CHANGE_RECORD_SIGNING_KEY);
	expect(own.keyId).toBe(key.fingerprint);
	expect(
		await verifyChain({
			records: range.value.records as never,
			checkpoints: checkpoints.value.map((c) => ({
				...c,
				envelope: c.envelope ? JSON.parse(c.envelope) : null,
			})),
			publicKey: key.publicKey,
		}),
	).toMatchObject({ ok: true, recordsVerified: 3, checkpointsVerified: 1 });
});

test("without a signing key the store chains records but writes no checkpoint", async () => {
	const organizationId = "org_log_no_key";
	const log = store(organizationId);
	await runInDurableObject(log, async (instance) => {
		const unkeyed = instance as unknown as {
			env: Record<string, unknown>;
		} & OrganizationLogStore;
		unkeyed.env = { ...unkeyed.env, CHANGE_RECORD_SIGNING_KEY: undefined };
		const appended = await unkeyed.organizationLogAppend(organizationId, {
			...body(1),
			id: id(1),
			recordedAt: "2026-11-20T09:00:01.000Z",
		});
		expect(appended.status).toBe("stored");
		await unkeyed.alarm();
		expect(
			await unkeyed.organizationLogCheckpoints(organizationId, { limit: 10 }),
		).toEqual({ status: "live", value: [] });
	});
});
