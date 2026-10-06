import type { TediArtifact } from "@tedix/api-contract/schemas/cognitive-runtime";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { TEDIX_ARTIFACTS_R2_BUCKET_NAME } from "./artifacts-contract";
import type { PlatformClient } from "./brain/platform-client";
import { tool, type ToolSet } from "ai";
import * as z from "zod";

const MAX_TEXT_CHARS = 200_000;
const DELIVERABLE_STORE_PREFIX = "artifacts/";

export interface DeliverableArtifactReaderDependencies {
	bucket: R2Bucket;
	ensureIdentity(): Promise<void>;
	getTediId(): string | null | undefined;
	getPlatformClient(): Promise<Pick<
		PlatformClient,
		"getArtifact" | "listArtifacts"
	> | null>;
}

function artifactObjectKey(artifact: TediArtifact): string | null {
	if (!artifact.tediId || typeof artifact.uri !== "string") return null;
	const uriPrefix = `r2://${TEDIX_ARTIFACTS_R2_BUCKET_NAME}/`;
	if (!artifact.uri.startsWith(uriPrefix)) return null;
	const key = artifact.uri.slice(uriPrefix.length);
	const segments = key.split("/");
	if (
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		return null;
	}
	const isDeliverable =
		segments[0] === artifact.tediId && segments[1] === "artifacts";
	const isDirectWorkstationArtifact =
		segments[0] === "tedis" &&
		segments[1] === artifact.tediId &&
		segments[2] === "workstations";
	const isOrganizationWorkstationArtifact =
		segments[0] === "orgs" &&
		Boolean(segments[1]) &&
		segments[2] === "tedis" &&
		segments[3] === artifact.tediId &&
		segments[4] === "workstations";
	if (
		!isDeliverable &&
		!isDirectWorkstationArtifact &&
		!isOrganizationWorkstationArtifact
	) {
		return null;
	}
	return key;
}

function normalizePortablePath(path: unknown): string | null {
	if (typeof path !== "string") return null;
	const trimmed = path.trim().replace(/^\/+/, "");
	if (
		!trimmed ||
		trimmed.length > 1024 ||
		trimmed.includes("\0") ||
		trimmed.split("/").some((part) => !part || part === "." || part === "..")
	) {
		return null;
	}
	return trimmed;
}

async function listDeliverables(
	deps: DeliverableArtifactReaderDependencies,
	input: { prefix?: string; limit?: number },
): Promise<Record<string, unknown>> {
	await deps.ensureIdentity();
	const tediId = deps.getTediId();
	if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
	const prefix =
		typeof input.prefix === "string" && input.prefix.trim()
			? (normalizePortablePath(input.prefix) ?? "")
			: "";
	const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
	const root = `${tediId}/${DELIVERABLE_STORE_PREFIX}`;
	const result = await deps.bucket.list({ prefix: `${root}${prefix}`, limit });
	return {
		ok: true,
		prefix,
		root,
		objects: result.objects.map((object) => ({
			path: object.key.slice(root.length),
			size: object.size,
			uploaded: object.uploaded?.toISOString?.() ?? null,
		})),
	};
}

async function readDeliverablePath(
	deps: DeliverableArtifactReaderDependencies,
	input: { path?: string; maxChars?: number },
): Promise<Record<string, unknown>> {
	await deps.ensureIdentity();
	const tediId = deps.getTediId();
	if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
	const path = normalizePortablePath(input.path);
	if (!path) return { ok: false, error: "path must be a safe object path" };
	const key = `${tediId}/${DELIVERABLE_STORE_PREFIX}${path}`;
	const object = await deps.bucket.get(key);
	if (!object) return { ok: false, error: "not_found", key };
	const maxChars = Math.min(
		MAX_TEXT_CHARS,
		Math.max(1, Math.floor(input.maxChars ?? MAX_TEXT_CHARS)),
	);
	const content = await object.text();
	return {
		ok: true,
		key,
		content: content.slice(0, maxChars),
		chars: content.length,
		truncated: content.length > maxChars,
		httpMetadata: object.httpMetadata ?? null,
		customMetadata: object.customMetadata ?? null,
	};
}

export async function readDeliverableArtifact(
	deps: DeliverableArtifactReaderDependencies,
	input: { artifactId?: string; maxChars?: number },
): Promise<Record<string, unknown>> {
	await deps.ensureIdentity();
	const tediId = deps.getTediId();
	if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
	if (typeof input.artifactId !== "string" || !input.artifactId.trim()) {
		return { ok: false, error: "artifactId is required" };
	}
	const platform = await deps.getPlatformClient();
	if (!platform) return { ok: false, error: "platform client unavailable" };

	let artifact: TediArtifact;
	try {
		({ artifact } = await platform.getArtifact({
			artifactId: input.artifactId.trim(),
		}));
	} catch (error) {
		return {
			ok: false,
			error: "artifact_lookup_failed",
			detail: error instanceof Error ? error.message : String(error),
		};
	}
	return readRecordedArtifactBody(deps, artifact, input.maxChars);
}

/** Read one ledger-recorded artifact's R2 body, bounded by {@link MAX_TEXT_CHARS}. */
async function readRecordedArtifactBody(
	deps: DeliverableArtifactReaderDependencies,
	artifact: TediArtifact,
	requestedMaxChars: number | undefined,
): Promise<Record<string, unknown>> {
	const key = artifactObjectKey(artifact);
	if (!key) {
		return {
			ok: false,
			error: "artifact_content_unavailable",
			artifactId: artifact.id,
		};
	}
	const object = await deps.bucket.get(key);
	if (!object) {
		return {
			ok: false,
			error: "artifact_content_not_found",
			artifactId: artifact.id,
		};
	}
	const maxChars = Math.min(
		MAX_TEXT_CHARS,
		Math.max(1, Math.floor(requestedMaxChars ?? MAX_TEXT_CHARS)),
	);
	const body = await object.arrayBuffer();
	const content = new TextDecoder().decode(body);
	return {
		ok: true,
		artifactId: artifact.id,
		name: artifact.name,
		mimeType: artifact.mimeType ?? null,
		content: content.slice(0, maxChars),
		chars: content.length,
		truncated: content.length > maxChars,
		sha256: await sha256Hex(body),
		byteLength: body.byteLength,
	};
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeArtifactId(ref: string): boolean {
	return ref.includes(":artifact:") || UUID_PATTERN.test(ref);
}

/**
 * Resolve a run artifact the ledger recorded — by its exact recorded `name`
 * (`workstation_process/<id>/stdout.log`, `deliverable/report.md`) or by its
 * artifact id — and read its R2 body. Returns `null` when the ledger holds no
 * such artifact, so the caller can fall back to another store (the tedi's git
 * Artifacts repo). The lookup is the `tedi_artifacts` index `artifact.created`
 * already populates; no second index is kept.
 */
export async function readRecordedArtifact(
	deps: DeliverableArtifactReaderDependencies,
	input: { ref: string; maxChars?: number },
): Promise<Record<string, unknown> | null> {
	const ref = input.ref.trim();
	if (!ref) return null;
	const platform = await deps.getPlatformClient();
	if (!platform) return null;
	let artifact: TediArtifact | null = null;
	try {
		const { artifacts } = await platform.listArtifacts({
			name: ref,
			limit: 20,
		});
		// Newest first (the route orders by createdAt desc); the exact-name
		// filter also verifies that the returned artifact matches the requested name.
		artifact = artifacts.find((candidate) => candidate.name === ref) ?? null;
	} catch (error) {
		console.warn(
			"[deliverable-artifact-reader] artifact name lookup failed:",
			error instanceof Error ? error.message : error,
		);
	}
	// Recorded ids are `<runId>:artifact:<subKind>:...` or server UUIDs; a repo
	// path is neither, so it skips the id round-trip and falls through.
	if (!artifact && looksLikeArtifactId(ref)) {
		try {
			({ artifact } = await platform.getArtifact({ artifactId: ref }));
		} catch {
			artifact = null;
		}
	}
	if (!artifact) return null;
	return {
		source: "artifact_ledger",
		...(await readRecordedArtifactBody(deps, artifact, input.maxChars)),
	};
}

export function createDeliverableArtifactTools(
	deps: DeliverableArtifactReaderDependencies,
): ToolSet {
	return {
		deliverable_list: tool({
			description:
				"List your finished deliverable artifacts (the things record_artifact published), e.g. prefix 'deliverable/' for reports and 'turn_summary/' for per-turn records. Use this to find work you or a previous run already produced BEFORE redoing it.",
			inputSchema: z.object({
				prefix: z.string().optional(),
				limit: z.number().int().positive().max(500).optional(),
			}),
			execute: async (input) => listDeliverables(deps, input),
		}),
		deliverable_read_text: tool({
			description:
				"Read back one of your own published deliverables as UTF-8 text, e.g. path 'deliverable/quarterly-plan.md'. This is how you recover prior work instead of starting cold — record_artifact writes here, and object_store_read_text does NOT reach it.",
			inputSchema: z.object({
				path: z.string().min(1),
				maxChars: z.number().int().positive().max(MAX_TEXT_CHARS).optional(),
			}),
			execute: async (input) => readDeliverablePath(deps, input),
		}),
		deliverable_read_artifact: tool({
			description:
				"Read the UTF-8 body of a durable artifact by artifactId. The tenant-scoped artifact ledger resolves the owning tedi and R2 object, allowing an assigned independent reviewer to inspect same-organization evidence without constructing a storage path.",
			inputSchema: z.object({
				artifactId: z.string().min(1),
				maxChars: z.number().int().positive().max(MAX_TEXT_CHARS).optional(),
			}),
			execute: async (input) => readDeliverableArtifact(deps, input),
		}),
	};
}
