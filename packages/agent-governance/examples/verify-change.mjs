import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const payloadType = "application/vnd.in-toto+json";
const predicateType = "https://tedix.dev/attestations/change-record/v1";

function base64(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value))
		throw new Error("Invalid base64");
	const bytes = Buffer.from(value, "base64");
	if (
		bytes.toString("base64url") !==
		value.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
	)
		throw new Error("Invalid base64");
	return bytes;
}

// Matches the record format's sorted-key JSON for language-neutral JSON values.
function sortedJson(value) {
	return JSON.stringify(value, (_key, inner) =>
		inner && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.keys(inner)
						.sort()
						.map((key) => [key, inner[key]]),
				)
			: inner,
	);
}

function equal(a, b) {
	if (sortedJson(a) !== sortedJson(b))
		throw new Error("Inconsistent change mapping");
}

/** The caller supplies a trusted key, never one selected by the envelope. */
export function verifyChange(envelope, publicKeySpki) {
	if (envelope.payloadType !== payloadType)
		throw new Error("Unsupported payload type");
	const payload = base64(envelope.payload);
	const key = createPublicKey({
		key: base64(publicKeySpki.trim()),
		format: "der",
		type: "spki",
	});
	if (key.asymmetricKeyType !== "ed25519")
		throw new Error("Expected Ed25519 key");
	const type = Buffer.from(payloadType);
	const pae = Buffer.concat([
		Buffer.from(`DSSEv1 ${type.length} `),
		type,
		Buffer.from(` ${payload.length} `),
		payload,
	]);
	if (
		!Array.isArray(envelope.signatures) ||
		!envelope.signatures.some(({ sig }) => {
			try {
				return verify(null, pae, key, base64(sig));
			} catch {
				return false;
			}
		})
	)
		throw new Error("Signature verification failed");
	const statement = JSON.parse(
		new TextDecoder("utf-8", { fatal: true }).decode(payload),
	);
	if (
		statement._type !== "https://in-toto.io/Statement/v1" ||
		statement.predicateType !== predicateType
	)
		throw new Error("Unsupported statement profile");
	const p = statement.predicate;
	const record = p.record;
	for (const field of [
		"id",
		"resource",
		"operation",
		"recordedAt",
		"argsHash",
		"outcome",
	])
		if (typeof record[field] !== "string" || !record[field])
			throw new Error(`Missing record ${field}`);
	if (!record.actor?.id || !record.actor?.kind || !record.source?.surface)
		throw new Error("Missing actor or cause");
	if (!Number.isFinite(Date.parse(record.recordedAt)))
		throw new Error("Invalid record time");
	const content = { ...record };
	for (const field of ["sequence", "recordDigest", "chainHash"])
		delete content[field];
	const digest = createHash("sha256").update(sortedJson(content)).digest("hex");
	equal(statement.subject, [
		{ name: `change-record/${record.id}`, digest: { sha256: digest } },
	]);
	equal(p.subjectKind, "change_record");
	equal(p.actor, record.actor);
	equal(p.cause, {
		operation: record.operation,
		source: record.source,
		task: record.subject ?? null,
		parent: record.parent ?? null,
	});
	equal(p.approval, record.approval ?? null);
	equal(p.environment, record.environment ?? null);
	equal(p.onBehalfOf, null);
	equal(p.time, {
		recordedAt: record.recordedAt,
		source: "recorder_clock",
		trustedTime: null,
	});
	const missing = ["onBehalfOf", "trustedTime"];
	if (!record.subject) missing.push("task");
	if (!record.parent || !Object.keys(record.parent).length)
		missing.push("parent");
	if (!record.environment || !Object.keys(record.environment).length)
		missing.push("environment");
	if (!record.environment?.policyDigest && !record.approval?.policy?.revisionId)
		missing.push("policyVersion");
	if (!record.approval) missing.push("approval");
	if (!record.decision) missing.push("decision");
	if (
		!Array.isArray(p.openFields) ||
		!missing.every((field) =>
			p.openFields.some(
				(entry) =>
					entry.field === field &&
					typeof entry.reason === "string" &&
					entry.reason.trim(),
			),
		)
	)
		throw new Error("Missing field explanation");
	return statement;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	try {
		if (process.argv.length !== 4)
			throw new Error(
				"Usage: node verify-change.mjs envelope.json trusted-key.spki",
			);
		const statement = verifyChange(
			JSON.parse(readFileSync(process.argv[2], "utf8")),
			readFileSync(process.argv[3], "utf8"),
		);
		console.log(`VALID ${statement.subject[0].name}`);
	} catch (error) {
		console.error(`INVALID: ${error.message}`);
		process.exitCode = 1;
	}
}
