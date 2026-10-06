/**
 * Artifact bridge for tenant skill workflows.
 *
 * The dispatch shim runs in a tenant-loaded Worker and must not see D1, R2,
 * bearer tokens, or a self-fetch endpoint. It receives `__ARTIFACT_BRIDGE__`,
 * a loopback `WorkerEntrypoint` stub specialized with `runId` in `ctx.props`.
 * Each `step.*` wrapper calls `record(payload)`; this bridge persists to D1
 * inline or spills to R2.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import {
	INLINE_THRESHOLD_BYTES,
	recordRunArtifact,
	sha256HexSafe,
} from "@tedix/db/queries/skill-run-artifacts";
import * as z from "zod";
import { recordArtifactOnceForRun } from "./artifact-immutability";

const ArtifactRecordSchema = z.object({
	path: z.string().min(1),
	value: z.unknown().optional(),
	mimeType: z.string().optional(),
	outcome: z.enum(["pending", "success", "failure"]).optional(),
	attempt: z.number().int().min(1).optional(),
});

type ArtifactRecordInput = z.infer<typeof ArtifactRecordSchema>;

/** Raw-bytes artifact write (binary media), base64 over the loopback bridge. */
const ArtifactBlobSchema = z.object({
	path: z.string().min(1),
	base64: z.string().min(1).describe("Base64-encoded raw bytes"),
	mimeType: z.string().min(1).describe("e.g. image/png, video/mp4"),
});

type ArtifactBlobInput = z.infer<typeof ArtifactBlobSchema>;

export interface ArtifactBridgeEnv {
	DB: D1Database;
	SKILL_ARTIFACTS: R2Bucket;
}

export interface ArtifactBridgeProps {
	runId: string;
}

async function recordArtifactForRun(
	env: ArtifactBridgeEnv,
	runId: string,
	input: ArtifactRecordInput,
): Promise<{
	ok: true;
	id: string;
	sizeBytes: number;
	storage: "inline" | "r2";
	sha256: string | null;
}> {
	const { path, value, mimeType, outcome, attempt } = input;
	// Serialize once to decide inline vs R2.
	const effectiveMime = mimeType ?? "application/json";
	const serialized =
		effectiveMime === "application/json"
			? JSON.stringify(value ?? null)
			: typeof value === "string"
				? value
				: JSON.stringify(value ?? null);
	const sizeBytes = new TextEncoder().encode(serialized).byteLength;
	// Digest the bytes here, in the trusted bridge — never in the tenant shim.
	// The shim hands us a value; we hash what we actually store, so a workflow
	// cannot present a digest that disagrees with its own evidence.
	const sha256 = await sha256HexSafe(serialized);

	if (sizeBytes > INLINE_THRESHOLD_BYTES) {
		// Spill to R2, then record metadata-only row in D1. Object key includes
		// the runId prefix so per-run lifecycle (revoke, list) can use R2's
		// prefix-scoped operations later. The digest also rides along on the R2
		// object so the bytes stay verifiable if D1 and R2 are ever compared.
		const r2Key = `${runId}/${path}`;
		await env.SKILL_ARTIFACTS.put(r2Key, serialized, {
			httpMetadata: { contentType: effectiveMime },
			customMetadata: {
				runId,
				path,
				outcome: outcome ?? "success",
				...(sha256 ? { sha256 } : {}),
			},
		});
		const { createDbClient } = await import("@tedix/db/client");
		const db = createDbClient(env.DB);
		const row = await recordRunArtifact(db, {
			runId,
			path,
			value: null,
			mimeType: effectiveMime,
			outcome: outcome ?? "success",
			attempt,
			r2Key,
			sizeBytes,
			...(sha256 ? { sha256 } : {}),
		});
		return { ok: true, id: row.id, sizeBytes, storage: "r2", sha256 };
	}

	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(env.DB);
	const row = await recordRunArtifact(db, {
		runId,
		path,
		value: value ?? null,
		mimeType: effectiveMime,
		outcome: outcome ?? "success",
		attempt,
		...(sha256 ? { sha256 } : {}),
	});
	return { ok: true, id: row.id, sizeBytes, storage: "inline", sha256 };
}

/**
 * Persist raw binary bytes as a content-typed R2 artifact (never inline,
 * never base64-in-JSON). Used for generated media — the bytes land at
 * `${runId}/${path}` in SKILL_ARTIFACTS with the real `image/png` /
 * `video/mp4` content type, so `getRunArtifact` streams a real file and a
 * signed-URL read mode can serve it directly.
 */
async function recordBlobForRun(
	env: ArtifactBridgeEnv,
	runId: string,
	input: ArtifactBlobInput,
): Promise<{
	ok: true;
	id: string;
	path: string;
	mimeType: string;
	sizeBytes: number;
	sha256: string | null;
}> {
	const { path, base64, mimeType } = input;
	// Base64 → bytes. atob is available in the Workers runtime.
	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const sizeBytes = bytes.byteLength;
	// Content-address the decoded bytes — the thing actually stored and served —
	// not the base64 transport encoding.
	const sha256 = await sha256HexSafe(bytes);
	const r2Key = `${runId}/${path}`;
	await env.SKILL_ARTIFACTS.put(r2Key, bytes, {
		httpMetadata: { contentType: mimeType },
		customMetadata: {
			runId,
			path,
			outcome: "success",
			...(sha256 ? { sha256 } : {}),
		},
	});
	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(env.DB);
	const row = await recordRunArtifact(db, {
		runId,
		path,
		value: null,
		mimeType,
		outcome: "success",
		r2Key,
		sizeBytes,
		...(sha256 ? { sha256 } : {}),
	});
	return { ok: true, id: row.id, path, mimeType, sizeBytes, sha256 };
}

export class ArtifactBridge extends WorkerEntrypoint<
	ArtifactBridgeEnv,
	ArtifactBridgeProps
> {
	async record(payload: unknown): Promise<true> {
		const parsed = ArtifactRecordSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`ARTIFACT_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		await recordArtifactForRun(this.env, this.ctx.props.runId, parsed.data);
		return true;
	}

	/** First writer wins; replays cannot alter immutable admission/config proof. */
	async recordOnce(payload: unknown): Promise<true> {
		const parsed = ArtifactRecordSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`ARTIFACT_INVALID_REQUEST: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		await recordArtifactOnceForRun(
			this.env.DB,
			this.ctx.props.runId,
			parsed.data,
			this.env.SKILL_ARTIFACTS,
		);
		return true;
	}

	/** Write raw binary bytes (base64) as a content-typed R2 artifact. */
	async writeBlob(payload: unknown): Promise<{
		ok: true;
		runId: string;
		path: string;
		mimeType: string;
		sizeBytes: number;
		sha256: string | null;
	}> {
		const parsed = ArtifactBlobSchema.safeParse(payload);
		if (!parsed.success) {
			throw new Error(
				`ARTIFACT_BLOB_INVALID: ${JSON.stringify(parsed.error.issues)}`,
			);
		}
		const runId = this.ctx.props.runId;
		const r = await recordBlobForRun(this.env, runId, parsed.data);
		return {
			ok: true,
			runId,
			path: r.path,
			mimeType: r.mimeType,
			sizeBytes: r.sizeBytes,
			sha256: r.sha256,
		};
	}
}
