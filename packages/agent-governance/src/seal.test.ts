import { describe, expect, it } from "vite-plus/test";
import {
	CHECKPOINT_PREDICATE_TYPE,
	type CheckpointInput,
	chainHash,
	DSSE_PAYLOAD_TYPE,
	decodeBase64,
	encodeBase64,
	GENESIS_CHAIN_HASH,
	IN_TOTO_STATEMENT_TYPE,
	importSigningKey,
	importVerifyingKey,
	preAuthenticationEncoding,
	recordDigest,
	type SealedRecordInput,
	sealRun,
	type SigningKey,
	verifyChain,
	verifyCheckpoint,
} from "./seal";

const ORG = "org-1";

async function throwawayKey(): Promise<SigningKey> {
	const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
		"sign",
		"verify",
	])) as CryptoKeyPair;
	const pkcs8 = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey),
	);
	return importSigningKey(encodeBase64(pkcs8));
}

function content(sequence: number) {
	return {
		id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
		recordedAt: new Date(Date.UTC(2026, 10, 18, 10, 0, sequence)).toISOString(),
		resource: "tool:send_example",
		operation: "send_example",
		actor: { id: "user-1", kind: "user", organizationId: ORG },
		source: { surface: "mcp_gateway" },
		decision: {
			verdict: "allow",
			gate: "tool_scope",
			reason: "allowed",
			riskTier: "bounded_write",
			blastRadius: "single_resource",
		},
		outcome: "applied",
		argsHash: `hash-${sequence}`,
	};
}

/**
 * Seal `sequences` in runs of `runSize`, as the sealer does, and return the
 * export: records with their seal fields and the signed checkpoints.
 */
async function ledger(
	sequences: number[],
	runSize: number,
	key: SigningKey | null,
) {
	const records: SealedRecordInput[] = [];
	const checkpoints: CheckpointInput[] = [];
	let previousChainHash: string | null = null;
	let previousCheckpointDigest: string | null = null;
	for (let start = 0; start < sequences.length; start += runSize) {
		const run = sequences
			.slice(start, start + runSize)
			.map((sequence) => ({ ...content(sequence), sequence }));
		const { seals, checkpoint } = await sealRun({
			organizationId: ORG,
			records: run,
			previousChainHash,
			previousCheckpointDigest,
			sealedAt: new Date(Date.UTC(2026, 10, 18, 11, start)).toISOString(),
			signer: key ? { privateKey: key.privateKey, keyId: "key-1" } : undefined,
		});
		run.forEach((record, i) => {
			const seal = seals[i];
			if (!seal) throw new Error("missing seal");
			records.push({ ...record, ...seal });
		});
		const { digest, ...stored } = checkpoint;
		checkpoints.push(stored);
		previousChainHash = checkpoint.headChainHash;
		previousCheckpointDigest = digest;
	}
	return { records, checkpoints };
}

// Global sequences: other organizations' records sit between these.
const SEQUENCES = [3, 4, 7, 8, 9, 12, 15, 16, 20];

describe("record digest and chain hash", () => {
	it("hash exactly the documented bytes", async () => {
		const record = content(1);
		const expectedDigest = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(
						JSON.stringify(
							Object.fromEntries(
								Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)),
							),
							(_key, value: unknown) =>
								value && typeof value === "object" && !Array.isArray(value)
									? Object.fromEntries(
											Object.entries(value).sort(([a], [b]) =>
												a < b ? -1 : 1,
											),
										)
									: value,
						),
					),
				),
			),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
		// The seal fields never change the digest.
		expect(await recordDigest(record)).toBe(expectedDigest);
		expect(
			await recordDigest({
				...record,
				sequence: 9,
				recordDigest: "x",
				chainHash: "y",
			}),
		).toBe(expectedDigest);

		const layout = `tedix.change-record-chain.v1\n${GENESIS_CHAIN_HASH}\n7\n${expectedDigest}`;
		const expectedChain = Array.from(
			new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(layout)),
			),
			(b) => b.toString(16).padStart(2, "0"),
		).join("");
		expect(await chainHash(null, 7, expectedDigest)).toBe(expectedChain);
		expect(await chainHash(GENESIS_CHAIN_HASH, 7, expectedDigest)).toBe(
			expectedChain,
		);
		await expect(chainHash(null, 0, expectedDigest)).rejects.toThrow(TypeError);
		await expect(chainHash("abc", 1, expectedDigest)).rejects.toThrow(
			TypeError,
		);
	});
});

describe("DSSE checkpoint envelopes", () => {
	it("encodes PAE as the DSSE specification's test vector", () => {
		expect(
			new TextDecoder().decode(
				preAuthenticationEncoding(
					"http://example.com/HelloWorld",
					new TextEncoder().encode("hello world"),
				),
			),
		).toBe("DSSEv1 29 http://example.com/HelloWorld 11 hello world");
	});

	it("signs an in-toto statement and verifies it with the public key alone", async () => {
		const key = await throwawayKey();
		const { checkpoints } = await ledger(SEQUENCES.slice(0, 3), 3, key);
		const envelope = checkpoints[0]?.envelope;
		if (!envelope) throw new Error("unsigned");
		expect(envelope.payloadType).toBe(DSSE_PAYLOAD_TYPE);
		expect(envelope.signatures).toEqual([
			{ keyid: "key-1", sig: expect.any(String) },
		]);
		const statement = JSON.parse(
			new TextDecoder().decode(decodeBase64(envelope.payload)),
		);
		expect(statement).toEqual({
			_type: IN_TOTO_STATEMENT_TYPE,
			subject: [
				{
					name: `gateway-change-records/${ORG}`,
					digest: { sha256: checkpoints[0]?.headChainHash },
				},
			],
			predicateType: CHECKPOINT_PREDICATE_TYPE,
			predicate: {
				organizationId: ORG,
				firstSequence: 3,
				lastSequence: 7,
				recordCount: 3,
				previousCheckpointDigest: null,
				previousChainHash: null,
				sealedAt: "2026-11-18T11:00:00.000Z",
			},
		});
		const publicKey = await importVerifyingKey(key.publicKeySpki);
		expect(await verifyCheckpoint(envelope, publicKey)).toMatchObject({
			ok: true,
		});
		// URL-safe base64 must be accepted too.
		const urlSafe = {
			...envelope,
			payload: envelope.payload.replaceAll("+", "-").replaceAll("/", "_"),
		};
		expect((await verifyCheckpoint(urlSafe, publicKey)).ok).toBe(true);
		const other = await throwawayKey();
		expect(await verifyCheckpoint(envelope, other.publicKey)).toMatchObject({
			ok: false,
		});
		expect(key.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("optional subject", () => {
	const subject = {
		kind: "work_item",
		id: "3f2b8c1e-6d4a-4f7b-9a2e-5c1d8e7f6a90",
	};

	it("leaves the digest of a record without it unchanged", async () => {
		const record = content(1);
		const digest = await recordDigest(record);
		expect(await recordDigest({ ...record, subject: undefined })).toBe(digest);
		expect(await recordDigest({ ...record, subject })).not.toBe(digest);
	});

	it("verifies a chain mixing records with and without it", async () => {
		const key = await throwawayKey();
		const run = [1, 2, 3].map((sequence) => ({
			...content(sequence),
			...(sequence === 2 ? { subject } : {}),
			sequence,
		}));
		const { seals, checkpoint } = await sealRun({
			organizationId: ORG,
			records: run,
			previousChainHash: null,
			previousCheckpointDigest: null,
			sealedAt: new Date(Date.UTC(2026, 10, 18, 11)).toISOString(),
			signer: { privateKey: key.privateKey, keyId: "key-1" },
		});
		const { digest: _digest, ...stored } = checkpoint;
		const result = await verifyChain({
			records: run.map((record, i) => ({ ...record, ...seals[i]! })),
			checkpoints: [stored],
			publicKey: key.publicKey,
		});
		expect(result).toMatchObject({ ok: true, recordsVerified: 3 });
	});
});

describe("verifyChain", () => {
	it("verifies a clean chain", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		expect(checkpoints).toHaveLength(3);
		expect(
			await verifyChain({ records, checkpoints, publicKey: key.publicKey }),
		).toEqual({
			ok: true,
			recordsVerified: 9,
			checkpointsVerified: 3,
			headChainHash: checkpoints[2]?.headChainHash,
			uncheckpointedRecords: 0,
			unsealedRecords: 0,
		});
	});

	it("fails at the record whose field was altered", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const altered = records.map((record) =>
			record.sequence === 8 ? { ...record, outcome: "denied" } : record,
		);
		expect(
			await verifyChain({
				records: altered,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "digest", sequence: 8 });

		// Re-sealing the altered record and everything after it still fails:
		// the chain no longer reaches the signed head.
		const resealed = [...altered];
		let previous = resealed[2]?.chainHash ?? null;
		for (let i = 3; i < resealed.length; i += 1) {
			const record = resealed[i] as SealedRecordInput;
			const digest = await recordDigest(record);
			const link = await chainHash(previous, record.sequence, digest);
			resealed[i] = { ...record, recordDigest: digest, chainHash: link };
			previous = link;
		}
		expect(
			await verifyChain({
				records: resealed,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "checkpoint", sequence: 8 });
	});

	it("reports a deleted record as a gap", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const withoutMiddle = records.filter((record) => record.sequence !== 9);
		expect(
			await verifyChain({
				records: withoutMiddle,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "gap", sequence: 12 });
		const withoutLast = records.filter((record) => record.sequence !== 8);
		expect(
			await verifyChain({
				records: withoutLast,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "gap", sequence: 8 });
		const withoutFirst = records.filter((record) => record.sequence !== 3);
		expect(
			await verifyChain({
				records: withoutFirst,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "gap", sequence: 4 });
	});

	it("rejects reordered records", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const swapped = [...records];
		[swapped[1], swapped[2]] = [
			swapped[2] as SealedRecordInput,
			swapped[1] as SealedRecordInput,
		];
		expect(
			await verifyChain({
				records: swapped,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "order", sequence: 4 });

		// Swapping two records' sequence numbers keeps the order ascending but
		// breaks the chain at the first of them.
		const renumbered = records.map((record) =>
			record.sequence === 4
				? { ...(records[2] as SealedRecordInput), sequence: 4 }
				: record.sequence === 7
					? { ...(records[1] as SealedRecordInput), sequence: 7 }
					: record,
		);
		expect(
			await verifyChain({
				records: renumbered,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "link", sequence: 4 });
	});

	it("rejects a checkpoint signed with another key", async () => {
		const key = await throwawayKey();
		const other = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const forged = await ledger(SEQUENCES, 4, other);
		const mixed = [
			checkpoints[0] as CheckpointInput,
			forged.checkpoints[1] as CheckpointInput,
			checkpoints[2] as CheckpointInput,
		];
		expect(
			await verifyChain({
				records,
				checkpoints: mixed,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "signature", sequence: 9 });
		// Unsigned checkpoints are refused unless the caller allows them.
		const unsigned = await ledger(SEQUENCES, 4, null);
		expect(
			await verifyChain({ ...unsigned, publicKey: key.publicKey }),
		).toMatchObject({ ok: false, reason: "signature", sequence: 3 });
		expect(
			await verifyChain({ ...unsigned, publicKey: null, allowUnsigned: true }),
		).toMatchObject({ ok: true, recordsVerified: 9 });
		// A stored column that disagrees with its signed statement fails.
		const tampered = checkpoints.map((checkpoint, i) =>
			i === 1 ? { ...checkpoint, recordCount: 5 } : checkpoint,
		);
		expect(
			await verifyChain({
				records,
				checkpoints: tampered,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "checkpoint", sequence: 9 });
	});

	it("verifies a mid-chain export with its previous checkpoint", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const tail = records.slice(4);
		expect(
			await verifyChain({
				records: tail,
				checkpoints,
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: true, recordsVerified: 5, checkpointsVerified: 3 });
		// Without the earlier checkpoint the signed previousChainHash suffices.
		expect(
			await verifyChain({
				records: tail,
				checkpoints: checkpoints.slice(1),
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: true, recordsVerified: 5 });
		// A wrong starting hash, or an export starting inside a checkpoint, fails.
		expect(
			await verifyChain({
				records: tail,
				checkpoints: checkpoints.slice(1),
				publicKey: key.publicKey,
				startingChainHash: GENESIS_CHAIN_HASH,
			}),
		).toMatchObject({ ok: false, reason: "checkpoint" });
		expect(
			await verifyChain({
				records: records.slice(5),
				checkpoints: checkpoints.slice(1),
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "gap", sequence: 12 });
		// A missing checkpoint between two given ones is caught.
		expect(
			await verifyChain({
				records: [],
				checkpoints: [
					checkpoints[0] as CheckpointInput,
					checkpoints[2] as CheckpointInput,
				],
				publicKey: key.publicKey,
			}),
		).toMatchObject({ ok: false, reason: "checkpoint", sequence: 20 });
	});

	it("links sealed records after the last checkpoint and counts unsealed ones", async () => {
		const key = await throwawayKey();
		const { records, checkpoints } = await ledger(SEQUENCES, 4, key);
		const pending = [
			...records,
			{
				...content(21),
				sequence: 21,
				recordDigest: null,
				chainHash: null,
			},
		];
		expect(
			await verifyChain({
				records: pending,
				checkpoints: checkpoints.slice(0, 2),
				publicKey: key.publicKey,
			}),
		).toMatchObject({
			ok: true,
			recordsVerified: 9,
			uncheckpointedRecords: 1,
			unsealedRecords: 1,
		});
	});
});
