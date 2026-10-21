import { tool, type ToolSet } from "ai";
import * as z from "zod";
import { normalizePortablePath } from "./portable-path";
import {
	createDeliverableArtifactTools,
	type DeliverableArtifactReaderDependencies,
} from "./deliverable-artifact-reader";

interface ObjectStoreDependencies extends DeliverableArtifactReaderDependencies {
	getSlug(): string | null | undefined;
	recordArtifact(input: {
		name?: string;
		content?: string;
		mimeType?: string;
		kind?: string;
		description?: string;
	}): Promise<unknown>;
}

const OBJECT_STORE_MAX_TEXT_CHARS = 200_000;
export const OBJECT_STORE_PREFIX = "objects/";

function clampPositiveInt(
	value: unknown,
	defaultValue: number,
	maxValue: number,
): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return defaultValue;
	return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

export function createObjectStoreTools(deps: ObjectStoreDependencies): ToolSet {
	function objectStoreKey(path: unknown): string | null {
		const normalized = normalizePortablePath(path);
		if (!normalized) return null;
		const tediId = deps.getTediId();
		if (!tediId) return null;
		return `${tediId}/${OBJECT_STORE_PREFIX}${normalized}`;
	}

	async function listObjectStoreTool(input: {
		prefix?: string;
		limit?: number;
		cursor?: string;
	}): Promise<unknown> {
		await deps.ensureIdentity();
		const tediId = deps.getTediId();
		if (!tediId) return { ok: false, error: "Tedi identity is not resolved" };
		const prefix =
			typeof input.prefix === "string" && input.prefix.trim()
				? normalizePortablePath(input.prefix)
				: "";
		if (prefix === null) {
			return { ok: false, error: "prefix must be a safe object path" };
		}
		const limit = clampPositiveInt(input.limit, 100, 500);
		const root = `${tediId}/${OBJECT_STORE_PREFIX}`;
		const result = await deps.bucket.list({
			prefix: `${root}${prefix}`,
			limit,
			...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
		});
		return {
			ok: true,
			prefix,
			root,
			objects: result.objects.map((object) => ({
				path: object.key.slice(root.length),
				size: object.size,
				uploaded: object.uploaded?.toISOString?.() ?? null,
			})),
			truncated: result.truncated,
			cursor: result.truncated ? result.cursor : null,
		};
	}

	async function readObjectStoreTool(input: {
		path?: string;
		maxChars?: number;
	}): Promise<unknown> {
		await deps.ensureIdentity();
		const key = objectStoreKey(input.path);
		if (!key) return { ok: false, error: "path must be a safe object path" };
		const maxChars = clampPositiveInt(
			input.maxChars,
			OBJECT_STORE_MAX_TEXT_CHARS,
			OBJECT_STORE_MAX_TEXT_CHARS,
		);
		const object = await deps.bucket.get(key);
		if (!object) return { ok: false, error: "not_found", key };
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

	async function writeObjectStoreTool(input: {
		path?: string;
		content?: string;
		contentType?: string;
	}): Promise<unknown> {
		await deps.ensureIdentity();
		const key = objectStoreKey(input.path);
		if (!key) return { ok: false, error: "path must be a safe object path" };
		if (typeof input.content !== "string") {
			return { ok: false, error: "content must be a string" };
		}
		const result = await deps.bucket.put(key, input.content, {
			httpMetadata: {
				contentType:
					typeof input.contentType === "string" && input.contentType
						? input.contentType
						: "text/plain; charset=utf-8",
			},
			customMetadata: {
				producer: "tedi-runtime",
				slug: deps.getSlug() ?? "",
			},
		});
		return {
			ok: true,
			key,
			etag: result.etag,
			version: result.version,
			size: new TextEncoder().encode(input.content).byteLength,
		};
	}

	return {
		object_store_list: tool({
			description:
				"List durable R2 text objects under your per-tedi object store. Use this for large generated artifacts or scratch outputs that do not belong in canonical Artifacts/Git history.",
			inputSchema: z.object({
				prefix: z.string().optional(),
				limit: z.number().int().positive().max(500).optional(),
				cursor: z
					.string()
					.optional()
					.describe(
						"Opaque cursor from a previous listing; reuse the same prefix.",
					),
			}),
			execute: async (input) => listObjectStoreTool(input),
		}),
		object_store_read_text: tool({
			description:
				"Read a UTF-8 text object from your per-tedi R2 object store.",
			inputSchema: z.object({
				path: z.string().min(1),
				maxChars: z
					.number()
					.int()
					.positive()
					.max(OBJECT_STORE_MAX_TEXT_CHARS)
					.optional(),
			}),
			execute: async (input) => readObjectStoreTool(input),
		}),
		object_store_write_text: tool({
			description:
				"Write a UTF-8 text object to your per-tedi R2 object store. This is for durable generated artifacts, not canonical memory or identity files.",
			inputSchema: z.object({
				path: z.string().min(1),
				content: z.string(),
				contentType: z.string().optional(),
			}),
			execute: async (input) => writeObjectStoreTool(input),
		}),
		...createDeliverableArtifactTools(deps),
		record_artifact: tool({
			description:
				"Publish a finished text deliverable (report, summary, CSV/markdown) as a durable artifact in R2, registered in the artifact ledger and linked to this run. Return the result's actual name and artifactId to the user; read it with artifact_read_file(path: artifactId). The requested name is normalized to a filename, not a repository path, and the r2:// uri is not a browser URL. A missing uri means the body was not saved. Use for finished work products, not scratch text (object_store_write_text) or canonical memory/identity.",
			inputSchema: z.object({
				name: z
					.string()
					.min(1)
					.describe("File name, e.g. 'weekly-trend-report.md'"),
				content: z.string().min(1).describe("UTF-8 text body"),
				mimeType: z.string().optional(),
				kind: z
					.enum([
						"document",
						"spreadsheet",
						"presentation",
						"file",
						"link",
						"image",
						"widget",
						"other",
					])
					.optional(),
				description: z.string().optional(),
			}),
			execute: async (input) => deps.recordArtifact(input),
		}),
	};
}
