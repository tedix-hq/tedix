import {
	claimTediArtifact,
	getTediArtifact,
	markTediArtifactPublished,
	type TediArtifactRow,
} from "@tedix/db/queries/cognitive-runtime";
import type { DbClient } from "@tedix/db/client";
import { inspectArtifactUriOwnership } from "../lib/artifact-uri-ownership";
import { sha256Hex } from "@tedix/worker-kit/crypto";

export const MAX_REDACTED_ARTIFACT_BYTES = 50 * 1024;
const BUCKET_NAME = "tedix-tedi-production";

async function readBoundedBody(
	object: R2ObjectBody,
	limit: number,
): Promise<Uint8Array> {
	const reader = object.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > limit) {
				await reader.cancel();
				throw new Error("Artifact body exceeds review limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return body;
}

export async function readVerifiedPrivateTextArtifact(
	bucket: R2Bucket,
	artifact: TediArtifactRow,
): Promise<{ bytes: Uint8Array; text: string }> {
	if (
		artifact.accessClassification !== "runtime_private" ||
		artifact.publicationState !== "ready" ||
		!artifact.uri ||
		!artifact.contentDigest ||
		!/^[a-f0-9]{64}$/.test(artifact.contentDigest) ||
		artifact.metadata?.bundle === true ||
		!artifact.mimeType ||
		!/^text\/(?:plain|markdown)(?:\s*;\s*charset=utf-8)?$/i.test(
			artifact.mimeType,
		)
	)
		throw new Error("Artifact is not a reviewable private text body");
	const ownership = inspectArtifactUriOwnership(artifact);
	if (ownership.kind !== "owned-r2")
		throw new Error("Artifact body is not owned storage");
	const key = ownership.key;
	const head = await bucket.head(key);
	if (
		!head ||
		head.size > MAX_REDACTED_ARTIFACT_BYTES ||
		head.size !== artifact.sizeBytes
	)
		throw new Error("Artifact body size is unavailable");
	const object = await bucket.get(key);
	if (!object) throw new Error("Artifact body is unavailable");
	const bytes = await readBoundedBody(object, MAX_REDACTED_ARTIFACT_BYTES);
	if (
		bytes.byteLength !== artifact.sizeBytes ||
		(await sha256Hex(bytes)) !== artifact.contentDigest
	)
		throw new Error("Artifact body changed after review claim");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		throw new Error("Artifact body is not valid UTF-8");
	}
	return { bytes, text };
}

export async function publishImmutablePrivateTextArtifact(input: {
	db: DbClient;
	bucket: R2Bucket;
	id: string;
	organizationId: string;
	tediId: string;
	conversationId?: string | null;
	runId?: string | null;
	messageId?: string | null;
	kind: TediArtifactRow["kind"];
	name: string;
	content: string;
	createdAt: string;
}): Promise<TediArtifactRow> {
	const bytes = new TextEncoder().encode(input.content);
	if (!bytes.length || bytes.byteLength > MAX_REDACTED_ARTIFACT_BYTES)
		throw new Error("Redaction candidate must be 1-50 KiB of UTF-8 text");
	const digest = await sha256Hex(bytes);
	const key = `${input.tediId}/artifacts/redacted/${digest}/${input.id}.txt`;
	const uri = `r2://${BUCKET_NAME}/${key}`;
	const claim = await claimTediArtifact(input.db, {
		id: input.id,
		organizationId: input.organizationId,
		tediId: input.tediId,
		conversationId: input.conversationId,
		runId: input.runId,
		messageId: input.messageId,
		kind: input.kind,
		name: input.name,
		mimeType: "text/plain; charset=utf-8",
		uri,
		sizeBytes: bytes.byteLength,
		metadata: { releaseRole: "redaction_candidate", contentSha256: digest },
		accessClassification: "runtime_private",
		contentDigest: digest,
		producerExecutionId: null,
		accessEnvelope: null,
		publicationState: "pending",
		createdAt: input.createdAt,
	});
	if (claim.artifact.publicationState !== "ready") {
		const written = await input.bucket.put(key, bytes, {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: "text/plain; charset=utf-8" },
			customMetadata: {
				sha256: digest,
				sizeBytes: String(bytes.byteLength),
				producer: "artifact_release_review",
			},
		});
		if (!written) {
			const stored = await input.bucket.get(key);
			if (
				!stored ||
				(await sha256Hex(
					await readBoundedBody(stored, MAX_REDACTED_ARTIFACT_BYTES),
				)) !== digest
			)
				throw new Error("Stored redaction candidate conflicts");
		}
		const ready = await markTediArtifactPublished(input.db, {
			id: input.id,
			organizationId: input.organizationId,
			tediId: input.tediId,
			contentDigest: digest,
		});
		if (ready) return ready;
		const concurrent = await getTediArtifact(input.db, {
			organizationId: input.organizationId,
			artifactId: input.id,
		});
		if (
			concurrent?.publicationState === "ready" &&
			concurrent.contentDigest === digest
		)
			return concurrent;
		throw new Error("Redaction candidate publication did not settle");
	}
	return claim.artifact;
}
