import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import type { OrganizationLogStore } from "../src/organization-log";
import { expect, test, vi } from "vite-plus/test";
import {
	type DayManifest,
	type EvidenceBundle,
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
			recordedAt: new Date(Date.now() - 31 * 86_400_000).toISOString(),
		});
		expect(appended.status).toBe("stored");
		await unkeyed.alarm();
		expect(
			await unkeyed.organizationLogCheckpoints(organizationId, { limit: 10 }),
		).toEqual({ status: "live", value: [] });
		expect(
			await unkeyed.organizationLogGet(organizationId, id(1)),
		).toMatchObject({ status: "live", value: { sequence: 1 } });
	});
});

test("retention keeps the whole day until its archive verifies, then exposes manifests and preserves checkpoints", async () => {
	const organizationId = "org_log_retention";
	const log = store(organizationId);
	await runInDurableObject(log, async (instance) => {
		const own = instance as unknown as OrganizationLogStore;
		const dayMs = 86_400_000;
		const now = Date.now();
		const future = now + 2 * dayMs;
		const cutoff = new Date(future - 30 * dayMs).toISOString();
		await own.organizationLogAppend(organizationId, {
			...body(1),
			id: id(1),
			recordedAt: new Date(now - 29 * dayMs).toISOString(),
		});
		await own.alarm();
		await own.organizationLogAppend(organizationId, {
			...body(2),
			id: id(2),
			recordedAt: cutoff,
		});
		await own.alarm();
		const checkpoints = await own.organizationLogCheckpoints(organizationId, {
			limit: 10,
		});
		if (checkpoints.status !== "live") throw new Error("not live");
		expect(checkpoints.value).toHaveLength(2);
		const last = checkpoints.value[1]!;
		const manifestKey = dayManifestKey(
			organizationId,
			last.sealedAt.slice(0, 10),
		);
		const manifestBody = await (await bindings.R2_BUCKET.get(
			manifestKey,
		))!.text();
		const bundleKey = last.evidenceBundleKey!;
		const bundleBody = await (await bindings.R2_BUCKET.get(bundleKey))!.text();
		const clock = vi.spyOn(Date, "now").mockReturnValue(future);
		try {
			const retained = async () =>
				expect(
					await own.organizationLogGet(organizationId, id(1)),
				).toMatchObject({ status: "live", value: { sequence: 1 } });
			await bindings.R2_BUCKET.delete(manifestKey);
			await expect(own.alarm()).rejects.toThrow("manifest is missing");
			await retained();
			await bindings.R2_BUCKET.put(manifestKey, manifestBody);
			await bindings.R2_BUCKET.delete(bundleKey);
			await expect(own.alarm()).rejects.toThrow("bundle is missing");
			await retained();
			// A matching object hash is insufficient: the records must verify too.
			const tampered = JSON.parse(bundleBody) as EvidenceBundle;
			tampered.records[0]!.argsHash = "changed";
			const badBody = JSON.stringify(tampered);
			await bindings.R2_BUCKET.put(bundleKey, badBody);
			await expect(own.alarm()).rejects.toThrow("digest does not match");
			await retained();
			const manifest = JSON.parse(manifestBody) as DayManifest;
			const hash = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(badBody),
			);
			manifest.checkpoints[1]!.bundleSha256 = Array.from(
				new Uint8Array(hash),
				(b) => b.toString(16).padStart(2, "0"),
			).join("");
			await bindings.R2_BUCKET.put(manifestKey, JSON.stringify(manifest));
			await expect(own.alarm()).rejects.toThrow("does not verify");
			await retained();
			await bindings.R2_BUCKET.put(bundleKey, bundleBody);
			await bindings.R2_BUCKET.put(manifestKey, manifestBody);
			await own.alarm();
			expect(await own.organizationLogGet(organizationId, id(1))).toEqual({
				status: "live",
				value: null,
			});
			expect(await own.organizationLogGet(organizationId, id(2))).toMatchObject(
				{ status: "live", value: { sequence: 2 } },
			);
			expect(
				await own.organizationLogRange(
					organizationId,
					{ from: new Date(now - 31 * dayMs).toISOString(), until: cutoff },
					{ limit: 10 },
				),
			).toEqual({
				status: "live",
				value: {
					records: [],
					count: 0,
					archivedBefore: cutoff,
					manifestKeys: [manifestKey],
				},
			});
			expect(
				await own.organizationLogRange(
					organizationId,
					{ from: cutoff, until: new Date(future).toISOString() },
					{ limit: 10 },
				),
			).toMatchObject({ status: "live", value: { count: 1 } });
			expect(
				await own.organizationLogCheckpoints(organizationId, { limit: 10 }),
			).toEqual(checkpoints);
			const restoredManifest = JSON.parse(manifestBody) as DayManifest;
			const archived = await Promise.all(
				restoredManifest.checkpoints.map(
					async (c) =>
						(await (await bindings.R2_BUCKET.get(
							c.bundleKey,
						))!.json()) as EvidenceBundle,
				),
			);
			const key = await importSigningKey(bindings.CHANGE_RECORD_SIGNING_KEY);
			expect(
				await verifyChain({
					records: archived.flatMap((b) => b.records) as never,
					checkpoints: archived.map((b) => b.checkpoint),
					publicKey: key.publicKey,
				}),
			).toMatchObject({ ok: true, recordsVerified: 2, checkpointsVerified: 2 });
			// The next append and checkpoint continue the chain after pruning.
			await own.organizationLogAppend(organizationId, {
				...body(3),
				id: id(3),
				recordedAt: new Date(future).toISOString(),
			});
			await own.alarm();
			const after = await own.organizationLogCheckpoints(organizationId, {
				limit: 10,
			});
			expect(after.status === "live" && after.value[2]).toMatchObject({
				firstSequence: 3,
				previousChainHash: last.headChainHash,
				previousCheckpointDigest: last.checkpointDigest,
			});
		} finally {
			clock.mockRestore();
		}
	});
});
