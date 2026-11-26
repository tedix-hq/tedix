/**
 * Tamper evidence for an append-only change ledger, using existing open
 * formats so a third party can check an export offline with a public key.
 *
 * - Every record gets a digest of its content and a chain hash that links it
 *   to the record before it in the same organization's ledger.
 * - A checkpoint covers a contiguous run of records. It is an in-toto
 *   Statement v1 whose subject digest is the chain hash of the run's last
 *   record:
 *   https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md
 * - A checkpoint is signed in a DSSE envelope with Ed25519. The signature is
 *   over the DSSE pre-authentication encoding (PAE):
 *   https://github.com/secure-systems-lab/dsse/blob/master/protocol.md
 *   https://github.com/secure-systems-lab/dsse/blob/master/envelope.md
 *
 * Plain TypeScript and Web Crypto only.
 */

import { serializeGovernanceValue } from "./hash.js";

/** Fields that describe a record's place in the chain, never its content. */
export const SEAL_FIELDS = ["sequence", "recordDigest", "chainHash"] as const;

/**
 * The "previous chain hash" of the first record of an organization's ledger:
 * 64 zero hex digits.
 */
export const GENESIS_CHAIN_HASH = "0".repeat(64);

/** First line of the bytes hashed by `chainHash`; versions the layout. */
export const CHAIN_HASH_DOMAIN = "tedix.change-record-chain.v1";

/** https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1";

/**
 * The predicate type of a checkpoint. Tedix owns this URI; version 1 holds
 * exactly the fields of `CheckpointPredicate`.
 */
export const CHECKPOINT_PREDICATE_TYPE =
	"https://tedix.dev/attestations/change-record-checkpoint/v1";

/** The DSSE payload type for an in-toto Statement. */
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

/** Prefix of a checkpoint's subject name; the organization id follows it. */
export const CHECKPOINT_SUBJECT_PREFIX = "gateway-change-records/";

const HEX_64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

/**
 * UTF-8 bytes in a fresh ArrayBuffer. Copying keeps the type
 * `Uint8Array<ArrayBuffer>` under every runtime's type definitions, which Web
 * Crypto requires.
 */
const utf8 = {
	encode(text: string): Uint8Array<ArrayBuffer> {
		const view = encoder.encode(text);
		const out = new Uint8Array(view.length);
		out.set(view);
		return out;
	},
};

function toHex(bytes: ArrayBuffer): string {
	return Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Standard base64 (with padding). */
export function encodeBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

/**
 * Standard or URL-safe base64, padded or not: DSSE verifiers must accept
 * both encodings.
 */
export function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
	const standard = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * SHA-256 hex of a record's content.
 *
 * The content is the record as a reader gets it back with the seal fields
 * removed: every field except `sequence`, `recordDigest` and `chainHash`.
 * For a gateway change record that is the stored change record body
 * (`resource`, `operation`, `actor`, `source`, `decision`, `outcome`,
 * `argsHash`, and `before`, `after`, `approval`, `undo`, `subject` when
 * present) plus `id` and `recordedAt`. `sequence` is left out because the chain hash binds
 * it. The bytes hashed are the UTF-8 of `serializeGovernanceValue(content)`:
 * sorted-key JSON, `undefined` members dropped.
 */
export async function recordDigest(
	record: Readonly<Record<string, unknown>>,
): Promise<string> {
	const content: Record<string, unknown> = { ...record };
	for (const field of SEAL_FIELDS) delete content[field];
	return sha256Hex(utf8.encode(serializeGovernanceValue(content)));
}

/**
 * SHA-256 hex over the UTF-8 bytes of these four lines joined by "\n"
 * (0x0A), with no trailing newline:
 *
 *     tedix.change-record-chain.v1
 *     <previous chain hash: 64 lowercase hex, or GENESIS_CHAIN_HASH>
 *     <sequence: decimal, no sign, no leading zeros>
 *     <record digest: 64 lowercase hex>
 *
 * The hex fields have a fixed length and the sequence has no newline, so the
 * layout is unambiguous.
 */
export async function chainHash(
	previousChainHash: string | null,
	sequence: number,
	digest: string,
): Promise<string> {
	const previous = previousChainHash ?? GENESIS_CHAIN_HASH;
	if (!HEX_64.test(previous))
		throw new TypeError("previousChainHash must be 64 lowercase hex digits");
	if (!HEX_64.test(digest))
		throw new TypeError("recordDigest must be 64 lowercase hex digits");
	if (!Number.isSafeInteger(sequence) || sequence < 1)
		throw new TypeError("sequence must be a positive integer");
	return sha256Hex(
		utf8.encode(
			`${CHAIN_HASH_DOMAIN}\n${previous}\n${String(sequence)}\n${digest}`,
		),
	);
}

/** What a checkpoint states, besides its head chain hash (the subject). */
export interface CheckpointPredicate {
	organizationId: string;
	/** Sequence of the first record the checkpoint covers. */
	firstSequence: number;
	/** Sequence of the last record; its chain hash is the subject digest. */
	lastSequence: number;
	/** How many of the organization's records lie in the range. */
	recordCount: number;
	/** `checkpointDigest` of the organization's previous checkpoint. */
	previousCheckpointDigest: string | null;
	/**
	 * Chain hash of the record just before `firstSequence` (null for the
	 * ledger's first record). Lets a verifier check the range's first record
	 * after older records were deleted by retention.
	 */
	previousChainHash: string | null;
	/** When the checkpoint was made, as `Date.prototype.toISOString()`. */
	sealedAt: string;
}

export interface CheckpointStatement {
	_type: typeof IN_TOTO_STATEMENT_TYPE;
	subject: [{ name: string; digest: { sha256: string } }];
	predicateType: typeof CHECKPOINT_PREDICATE_TYPE;
	predicate: CheckpointPredicate;
}

/** https://github.com/secure-systems-lab/dsse/blob/master/envelope.md */
export interface DsseEnvelope {
	payloadType: string;
	/** Base64 of the serialized statement. */
	payload: string;
	signatures: Array<{ keyid: string; sig: string }>;
}

/** Build the in-toto Statement v1 for a checkpoint. */
export function checkpointStatement(
	input: CheckpointPredicate & { headChainHash: string },
): CheckpointStatement {
	const { headChainHash, ...predicate } = input;
	if (!HEX_64.test(headChainHash))
		throw new TypeError("headChainHash must be 64 lowercase hex digits");
	return {
		_type: IN_TOTO_STATEMENT_TYPE,
		subject: [
			{
				name: `${CHECKPOINT_SUBJECT_PREFIX}${predicate.organizationId}`,
				digest: { sha256: headChainHash },
			},
		],
		predicateType: CHECKPOINT_PREDICATE_TYPE,
		predicate: {
			organizationId: predicate.organizationId,
			firstSequence: predicate.firstSequence,
			lastSequence: predicate.lastSequence,
			recordCount: predicate.recordCount,
			previousCheckpointDigest: predicate.previousCheckpointDigest,
			previousChainHash: predicate.previousChainHash,
			sealedAt: predicate.sealedAt,
		},
	};
}

/** The DSSE payload bytes: UTF-8 of the sorted-key JSON of the statement. */
export function serializeCheckpointStatement(
	statement: CheckpointStatement,
): Uint8Array<ArrayBuffer> {
	return utf8.encode(serializeGovernanceValue(statement));
}

/**
 * SHA-256 hex of the payload bytes. The next checkpoint names it as
 * `previousCheckpointDigest`. Signed or not, it is computed the same way.
 */
export async function checkpointDigest(
	statement: CheckpointStatement,
): Promise<string> {
	return sha256Hex(serializeCheckpointStatement(statement));
}

/**
 * DSSE v1 pre-authentication encoding:
 * "DSSEv1" SP LEN(type) SP type SP LEN(body) SP body, where LEN is the ASCII
 * decimal byte length with no leading zeros.
 */
export function preAuthenticationEncoding(
	payloadType: string,
	body: Uint8Array,
): Uint8Array<ArrayBuffer> {
	const type = utf8.encode(payloadType);
	const head = utf8.encode(
		`DSSEv1 ${type.length} ${payloadType} ${body.length} `,
	);
	const out = new Uint8Array(head.length + body.length);
	out.set(head, 0);
	out.set(body, head.length);
	return out;
}

const ED25519 = { name: "Ed25519" } as const;

export interface SigningKey {
	privateKey: CryptoKey;
	publicKey: CryptoKey;
	/** Base64 of the public key in SubjectPublicKeyInfo (SPKI) DER form. */
	publicKeySpki: string;
	/** "sha256:" + SHA-256 hex of the SPKI bytes. */
	fingerprint: string;
}

/** Import an Ed25519 private key given as base64 PKCS#8 DER. */
export async function importSigningKey(
	pkcs8Base64: string,
): Promise<SigningKey> {
	const privateKey = await crypto.subtle.importKey(
		"pkcs8",
		decodeBase64(pkcs8Base64.trim()),
		ED25519,
		true,
		["sign"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", privateKey);
	if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x)
		throw new TypeError("The signing key is not an Ed25519 key");
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "OKP", crv: "Ed25519", x: jwk.x },
		ED25519,
		true,
		["verify"],
	);
	const spki = new Uint8Array(
		(await crypto.subtle.exportKey("spki", publicKey)) as ArrayBuffer,
	);
	return {
		privateKey,
		publicKey,
		publicKeySpki: encodeBase64(spki),
		fingerprint: `sha256:${await sha256Hex(spki)}`,
	};
}

/** Import an Ed25519 public key given as base64 SPKI DER. */
export async function importVerifyingKey(
	spkiBase64: string,
): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"spki",
		decodeBase64(spkiBase64.trim()),
		ED25519,
		true,
		["verify"],
	);
}

export interface InTotoStatement {
	_type: typeof IN_TOTO_STATEMENT_TYPE;
	subject: Array<{ name: string; digest: { sha256: string } }>;
	predicateType: string;
	predicate: object;
}

/** The same DSSE signer serves individual changes and ledger checkpoints. */
export async function signStatement(
	statement: InTotoStatement,
	privateKey: CryptoKey,
	keyId: string,
): Promise<DsseEnvelope> {
	const payload = utf8.encode(serializeGovernanceValue(statement));
	const signature = await crypto.subtle.sign(
		ED25519,
		privateKey,
		preAuthenticationEncoding(DSSE_PAYLOAD_TYPE, payload),
	);
	return {
		payloadType: DSSE_PAYLOAD_TYPE,
		payload: encodeBase64(payload),
		signatures: [
			{ keyid: keyId, sig: encodeBase64(new Uint8Array(signature)) },
		],
	};
}

/** Sign a checkpoint statement into a DSSE envelope with one signature. */
export async function signCheckpoint(
	statement: CheckpointStatement,
	privateKey: CryptoKey,
	keyId: string,
): Promise<DsseEnvelope> {
	return signStatement(statement, privateKey, keyId);
}

export type CheckpointVerification =
	| { ok: true; statement: CheckpointStatement; digest: string }
	| { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatement(value: unknown): CheckpointStatement | null {
	if (!isRecord(value)) return null;
	if (value._type !== IN_TOTO_STATEMENT_TYPE) return null;
	if (value.predicateType !== CHECKPOINT_PREDICATE_TYPE) return null;
	const subject = value.subject;
	const predicate = value.predicate;
	if (!Array.isArray(subject) || subject.length !== 1 || !isRecord(predicate))
		return null;
	const [only] = subject as unknown[];
	if (!isRecord(only) || !isRecord(only.digest)) return null;
	const head = only.digest.sha256;
	const integer = (field: unknown) =>
		typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
	const hexOrNull = (field: unknown) =>
		field === null || (typeof field === "string" && HEX_64.test(field));
	if (
		typeof head !== "string" ||
		!HEX_64.test(head) ||
		typeof predicate.organizationId !== "string" ||
		only.name !== `${CHECKPOINT_SUBJECT_PREFIX}${predicate.organizationId}` ||
		!integer(predicate.firstSequence) ||
		!integer(predicate.lastSequence) ||
		!integer(predicate.recordCount) ||
		!hexOrNull(predicate.previousCheckpointDigest) ||
		!hexOrNull(predicate.previousChainHash) ||
		typeof predicate.sealedAt !== "string"
	)
		return null;
	return checkpointStatement({
		organizationId: predicate.organizationId,
		firstSequence: predicate.firstSequence as number,
		lastSequence: predicate.lastSequence as number,
		recordCount: predicate.recordCount as number,
		previousCheckpointDigest: predicate.previousCheckpointDigest as
			| string
			| null,
		previousChainHash: predicate.previousChainHash as string | null,
		sealedAt: predicate.sealedAt,
		headChainHash: head,
	});
}

/**
 * Verify a DSSE envelope with an Ed25519 public key and return the statement
 * parsed from exactly the bytes that were verified (DSSE forbids re-parsing
 * the envelope after verification). Any one valid signature is enough; the
 * unauthenticated `keyid` is not used to decide.
 */
export async function verifyCheckpoint(
	envelope: DsseEnvelope,
	publicKey: CryptoKey,
): Promise<CheckpointVerification> {
	if (
		!isRecord(envelope) ||
		typeof envelope.payload !== "string" ||
		!Array.isArray(envelope.signatures)
	)
		return { ok: false, message: "The envelope is malformed" };
	if (envelope.payloadType !== DSSE_PAYLOAD_TYPE)
		return {
			ok: false,
			message: "The envelope's payload type is not supported",
		};
	let payload: Uint8Array<ArrayBuffer>;
	try {
		payload = decodeBase64(envelope.payload);
	} catch {
		return { ok: false, message: "The envelope's payload is not base64" };
	}
	const signed = preAuthenticationEncoding(envelope.payloadType, payload);
	let verified = false;
	for (const signature of envelope.signatures) {
		if (!isRecord(signature) || typeof signature.sig !== "string") continue;
		try {
			if (
				await crypto.subtle.verify(
					ED25519,
					publicKey,
					decodeBase64(signature.sig),
					signed,
				)
			) {
				verified = true;
				break;
			}
		} catch {
			// A malformed signature is simply not a valid one.
		}
	}
	if (!verified)
		return { ok: false, message: "No signature verifies with the public key" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return { ok: false, message: "The payload is not JSON" };
	}
	const statement = parseStatement(parsed);
	if (!statement)
		return { ok: false, message: "The payload is not a checkpoint statement" };
	return { ok: true, statement, digest: await sha256Hex(payload) };
}

export interface SealRunParams {
	organizationId: string;
	/** The next records of the ledger, in ascending sequence order. */
	records: ReadonlyArray<
		Readonly<Record<string, unknown>> & { sequence: number }
	>;
	/** Chain hash of the record before the first one; null at the start. */
	previousChainHash: string | null;
	/** Digest of the organization's latest checkpoint; null for the first. */
	previousCheckpointDigest: string | null;
	sealedAt: string;
	/** Sign the checkpoint when given; otherwise it is left unsigned. */
	signer?: { privateKey: CryptoKey; keyId: string };
}

export interface SealRunResult {
	seals: Array<{ sequence: number; recordDigest: string; chainHash: string }>;
	checkpoint: CheckpointInput & { digest: string };
}

/**
 * Seal the next run of an organization's records: digest and chain each one
 * from `previousChainHash`, then build (and, with a signer, sign) the one
 * checkpoint that covers the run.
 */
export async function sealRun(params: SealRunParams): Promise<SealRunResult> {
	const first = params.records[0];
	const last = params.records.at(-1);
	if (!first || !last) throw new TypeError("A run needs at least one record");
	const seals: SealRunResult["seals"] = [];
	let previous = params.previousChainHash;
	for (const record of params.records) {
		const digest = await recordDigest(record);
		const link = await chainHash(previous, record.sequence, digest);
		seals.push({
			sequence: record.sequence,
			recordDigest: digest,
			chainHash: link,
		});
		previous = link;
	}
	const predicate: CheckpointPredicate & { headChainHash: string } = {
		organizationId: params.organizationId,
		firstSequence: first.sequence,
		lastSequence: last.sequence,
		recordCount: params.records.length,
		previousCheckpointDigest: params.previousCheckpointDigest,
		previousChainHash: params.previousChainHash,
		sealedAt: params.sealedAt,
		headChainHash: previous as string,
	};
	const statement = checkpointStatement(predicate);
	return {
		seals,
		checkpoint: {
			...predicate,
			envelope: params.signer
				? await signCheckpoint(
						statement,
						params.signer.privateKey,
						params.signer.keyId,
					)
				: null,
			digest: await checkpointDigest(statement),
		},
	};
}

/** A record as an export returns it: content plus the seal fields. */
export interface SealedRecordInput {
	sequence: number;
	recordDigest: string | null;
	chainHash: string | null;
	[field: string]: unknown;
}

/** A checkpoint as an export returns it. */
export interface CheckpointInput extends CheckpointPredicate {
	headChainHash: string;
	/** The signed statement, or null when the checkpoint was not signed. */
	envelope: DsseEnvelope | null;
}

export type ChainFailureReason =
	/** Records are not in strictly ascending sequence order. */
	| "order"
	/** A record's content does not match its stored digest. */
	| "digest"
	/** A record's chain hash does not follow from the record before it. */
	| "link"
	/** A checkpoint says more records lie in its range than the export has. */
	| "gap"
	/** A checkpoint is unsigned, or its signature does not verify. */
	| "signature"
	/** Checkpoints do not link up, or disagree with the records they cover. */
	| "checkpoint"
	/** A record a checkpoint covers carries no seal. */
	| "unsealed";

export type ChainVerification =
	| {
			ok: true;
			/** Records whose digest and link were checked. */
			recordsVerified: number;
			/** Checkpoints whose signature (or, if allowed, statement) was checked. */
			checkpointsVerified: number;
			/** Chain hash of the last sealed record, if any. */
			headChainHash: string | null;
			/** Sealed records after the last checkpoint: linked, not yet signed. */
			uncheckpointedRecords: number;
			/** Records at the end of the export that are not sealed yet. */
			unsealedRecords: number;
	  }
	| {
			ok: false;
			reason: ChainFailureReason;
			/**
			 * Where verification stopped. For a gap, the first record whose link
			 * is broken by the missing record, or the checkpoint's last sequence
			 * when the missing records end the range.
			 */
			sequence: number | null;
			message: string;
	  };

export interface VerifyChainParams {
	/** One organization's records, in ascending sequence order. */
	records: readonly SealedRecordInput[];
	/**
	 * Checkpoints covering the records, in any order. Checkpoints that end
	 * before the first record (for example the one just before a mid-chain
	 * export) are checked for signature and linkage only.
	 */
	checkpoints: readonly CheckpointInput[];
	/**
	 * The Ed25519 public key the checkpoints must be signed with. Obtain it
	 * out of band: a key read from the same place as the export proves
	 * nothing about who signed it.
	 */
	publicKey: CryptoKey | null;
	/**
	 * Chain hash of the record just before the first exported record. Needed
	 * only when no checkpoint gives it; when one does, they must agree.
	 */
	startingChainHash?: string | null;
	/** Accept unsigned checkpoints (envelope null) for chain-only checks. */
	allowUnsigned?: boolean;
}

function fail(
	reason: ChainFailureReason,
	sequence: number | null,
	message: string,
): ChainVerification {
	return { ok: false, reason, sequence, message };
}

function samePredicate(
	statement: CheckpointStatement,
	checkpoint: CheckpointInput,
): boolean {
	const p = statement.predicate;
	return (
		p.organizationId === checkpoint.organizationId &&
		p.firstSequence === checkpoint.firstSequence &&
		p.lastSequence === checkpoint.lastSequence &&
		p.recordCount === checkpoint.recordCount &&
		p.previousCheckpointDigest === checkpoint.previousCheckpointDigest &&
		p.previousChainHash === checkpoint.previousChainHash &&
		p.sealedAt === checkpoint.sealedAt &&
		statement.subject[0].digest.sha256 === checkpoint.headChainHash
	);
}

/**
 * Verify an exported run of one organization's records against its
 * checkpoints. Checks, in sequence order: each checkpoint's signature and its
 * link to the previous checkpoint; that each checkpoint from the first record
 * on has exactly `recordCount` records in its range; each record's digest and
 * chain link; and that the last record of each checkpoint has the signed head
 * chain hash. Returns the first failure.
 */
export async function verifyChain(
	params: VerifyChainParams,
): Promise<ChainVerification> {
	const { records } = params;
	for (let i = 1; i < records.length; i += 1) {
		const current = records[i] as SealedRecordInput;
		const previous = records[i - 1] as SealedRecordInput;
		if (current.sequence <= previous.sequence)
			return fail(
				"order",
				current.sequence,
				`Record ${current.sequence} follows record ${previous.sequence}`,
			);
	}

	const checkpoints = [...params.checkpoints].sort(
		(a, b) => a.lastSequence - b.lastSequence,
	);
	let index = 0;
	let chain: string | null | undefined;
	let recordsVerified = 0;
	let checkpointsVerified = 0;
	let previousCheckpoint:
		| { statement: CheckpointStatement; digest: string }
		| undefined;

	const verifyRecord = async (
		record: SealedRecordInput,
		previousChain: string | null,
		short: boolean,
	): Promise<ChainVerification | string> => {
		if (record.recordDigest === null || record.chainHash === null)
			return fail(
				"unsealed",
				record.sequence,
				`Record ${record.sequence} is covered by a checkpoint but not sealed`,
			);
		const digest = await recordDigest(record);
		if (digest !== record.recordDigest)
			return fail(
				"digest",
				record.sequence,
				`Record ${record.sequence} does not match its digest`,
			);
		const link = await chainHash(previousChain, record.sequence, digest);
		if (link !== record.chainHash)
			return short
				? fail(
						"gap",
						record.sequence,
						`A record is missing before record ${record.sequence}`,
					)
				: fail(
						"link",
						record.sequence,
						`Record ${record.sequence} does not link to the record before it`,
					);
		recordsVerified += 1;
		return link;
	};

	for (const checkpoint of checkpoints) {
		let statement: CheckpointStatement;
		let digest: string;
		if (checkpoint.envelope) {
			if (!params.publicKey)
				return fail(
					"signature",
					checkpoint.firstSequence,
					"No public key was given to check signed checkpoints",
				);
			const verified = await verifyCheckpoint(
				checkpoint.envelope,
				params.publicKey,
			);
			if (!verified.ok)
				return fail(
					"signature",
					checkpoint.firstSequence,
					`Checkpoint ending at ${checkpoint.lastSequence}: ${verified.message}`,
				);
			statement = verified.statement;
			digest = verified.digest;
			if (!samePredicate(statement, checkpoint))
				return fail(
					"checkpoint",
					checkpoint.firstSequence,
					`Checkpoint ending at ${checkpoint.lastSequence} differs from its signed statement`,
				);
		} else {
			if (!params.allowUnsigned)
				return fail(
					"signature",
					checkpoint.firstSequence,
					`Checkpoint ending at ${checkpoint.lastSequence} is not signed`,
				);
			statement = checkpointStatement(checkpoint);
			digest = await checkpointDigest(statement);
		}
		const p = statement.predicate;
		const head = statement.subject[0].digest.sha256;
		if (p.firstSequence > p.lastSequence || p.recordCount < 1)
			return fail(
				"checkpoint",
				p.firstSequence,
				`Checkpoint ending at ${p.lastSequence} has an impossible range`,
			);
		if (previousCheckpoint) {
			const before = previousCheckpoint.statement;
			if (
				p.organizationId !== before.predicate.organizationId ||
				p.firstSequence <= before.predicate.lastSequence ||
				p.previousCheckpointDigest !== previousCheckpoint.digest ||
				p.previousChainHash !== before.subject[0].digest.sha256
			)
				return fail(
					"checkpoint",
					p.firstSequence,
					`Checkpoint ending at ${p.lastSequence} does not follow the checkpoint ending at ${before.predicate.lastSequence}`,
				);
		}
		checkpointsVerified += 1;
		previousCheckpoint = { statement, digest };

		// Context: a checkpoint that ends before the first exported record.
		const first = records[0];
		if (index === 0 && (!first || p.lastSequence < first.sequence)) continue;

		if (chain === undefined) {
			if (
				params.startingChainHash !== undefined &&
				params.startingChainHash !== p.previousChainHash
			)
				return fail(
					"checkpoint",
					p.firstSequence,
					"The starting chain hash disagrees with the first checkpoint",
				);
			chain = p.previousChainHash;
		}
		const covered: SealedRecordInput[] = [];
		while (index < records.length) {
			const record = records[index] as SealedRecordInput;
			if (record.sequence > p.lastSequence) break;
			if (record.sequence < p.firstSequence)
				return fail(
					"checkpoint",
					record.sequence,
					`Record ${record.sequence} is not covered by any checkpoint`,
				);
			covered.push(record);
			index += 1;
		}
		if (covered.length > p.recordCount)
			return fail(
				"checkpoint",
				p.lastSequence,
				`Checkpoint ending at ${p.lastSequence} covers ${p.recordCount} records but ${covered.length} were exported`,
			);
		const short = covered.length < p.recordCount;
		for (const record of covered) {
			const result = await verifyRecord(record, chain, short);
			if (typeof result !== "string") return result;
			chain = result;
		}
		// Every link held, so the missing records end the range.
		if (short)
			return fail(
				"gap",
				p.lastSequence,
				`Checkpoint ending at ${p.lastSequence} covers ${p.recordCount} records but ${covered.length} were exported`,
			);
		if (chain !== head)
			return fail(
				"checkpoint",
				p.lastSequence,
				`The chain does not reach the signed head of the checkpoint ending at ${p.lastSequence}`,
			);
	}

	// Records after the last checkpoint: sealed ones still link; unsealed ones
	// must all come after the sealed ones.
	let uncheckpointedRecords = 0;
	let unsealedRecords = 0;
	if (chain === undefined)
		chain =
			params.startingChainHash !== undefined
				? params.startingChainHash
				: previousCheckpoint
					? previousCheckpoint.statement.subject[0].digest.sha256
					: null;
	for (; index < records.length; index += 1) {
		const record = records[index] as SealedRecordInput;
		if (record.chainHash === null && record.recordDigest === null) {
			unsealedRecords += 1;
			continue;
		}
		if (unsealedRecords > 0)
			return fail(
				"unsealed",
				record.sequence,
				`Record ${record.sequence} is sealed after a record that is not`,
			);
		const result = await verifyRecord(record, chain, false);
		if (typeof result !== "string") return result;
		chain = result;
		uncheckpointedRecords += 1;
	}
	return {
		ok: true,
		recordsVerified,
		checkpointsVerified,
		headChainHash: chain ?? null,
		uncheckpointedRecords,
		unsealedRecords,
	};
}
