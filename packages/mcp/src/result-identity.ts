import { isRecord } from "@tedix/api-contract/utils/is-record";

const RESULT_IDENTITY_KEY_RE =
	/(?:^id$|Id$|^status$|^revision$|Slug$|^executionEpoch$)/;
const RESULT_IDENTITY_MAX_DEPTH = 4;
const RESULT_IDENTITY_MAX_OBJECTS = 64;
const RESULT_IDENTITY_MAX_STRING_CHARS = 256;
const UI_RESULT_PROJECTION_BYTE_CAP = 24_000;
const UI_RESULT_PROJECTION_DEPTH_CAP = 8;
const UI_RESULT_PROJECTION_COLLECTION_CAP = 100;
const UI_RESULT_PROJECTION_STRING_CAP = 4_096;
const MCP_APP_RESOURCE_URI =
	/^ui:\/\/widgets\/mcp-app\/[a-z][a-z0-9-]{1,63}\/r\/.+/;
const MCP_APP_RENDER_RESOURCE_URI =
	/^ui:\/\/widgets\/mcp-app\/([a-z][a-z0-9-]{1,63})\/r\/([a-zA-Z0-9_-]+)\.html$/;
const SENSITIVE_UI_RESULT_KEYS = new Set([
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"cookie",
	"credential",
	"credentials",
	"password",
	"refresh_token",
	"secret",
	"set-cookie",
	"token",
	"access_token",
]);

export type McpAppRenderProjection = {
	appSlug: string;
	layoutId: string;
	layoutSpec?: Record<string, unknown>;
	resourceUri: string;
	toolInput?: Record<string, unknown>;
	toolResult: Record<string, unknown>;
};

/** Parse the bounded json-render/generated-app resource route shared by chat hosts. */
export function parseMcpAppRenderResourceUri(
	value: unknown,
): Pick<McpAppRenderProjection, "appSlug" | "layoutId" | "resourceUri"> | null {
	if (typeof value !== "string") return null;
	const resourceUri = value.trim();
	const match = MCP_APP_RENDER_RESOURCE_URI.exec(resourceUri);
	if (!match) return null;
	return { appSlug: match[1]!, layoutId: match[2]!, resourceUri };
}

/**
 * Find a renderable MCP App projection in either a live tool result or the
 * durable `{ resourceUri, toolInput, toolResult }` transcript envelope.
 */
export function findMcpAppRenderProjections(
	value: unknown,
): McpAppRenderProjection[] {
	let visited = 0;
	const seen = new Set<unknown>();
	const seenUris = new Set<string>();
	const projections: McpAppRenderProjection[] = [];
	const visit = (candidate: unknown, depth = 0): void => {
		if (
			depth > 6 ||
			!candidate ||
			typeof candidate !== "object" ||
			seen.has(candidate) ||
			visited >= UI_RESULT_PROJECTION_COLLECTION_CAP ||
			projections.length >= 3
		) {
			return;
		}
		seen.add(candidate);
		visited += 1;
		if (Array.isArray(candidate)) {
			for (const child of candidate.slice(
				0,
				UI_RESULT_PROJECTION_COLLECTION_CAP,
			)) {
				visit(child, depth + 1);
			}
			return;
		}

		const record = candidate as Record<string, unknown>;
		const durableToolResult = isRecord(record.toolResult)
			? record.toolResult
			: null;
		const meta = isRecord(record._meta) ? record._meta : null;
		const ui = isRecord(meta?.ui) ? meta.ui : null;
		const target = parseMcpAppRenderResourceUri(
			record.resourceUri ?? ui?.resourceUri,
		);
		if (target && !seenUris.has(target.resourceUri)) {
			const rawToolResult = durableToolResult ?? record;
			const toolResult =
				structuredUiResultProjection(rawToolResult) ?? rawToolResult;
			const layoutSpec = isRecord(toolResult.layoutSpec)
				? toolResult.layoutSpec
				: isRecord(record.layoutSpec)
					? record.layoutSpec
					: undefined;
			seenUris.add(target.resourceUri);
			projections.push({
				...target,
				...(layoutSpec ? { layoutSpec } : {}),
				...(isRecord(record.toolInput) ? { toolInput: record.toolInput } : {}),
				toolResult,
			});
			return;
		}

		for (const child of Object.values(record).slice(
			0,
			UI_RESULT_PROJECTION_COLLECTION_CAP,
		)) {
			visit(child, depth + 1);
		}
	};
	visit(value);
	return projections;
}

/**
 * Preserve a bounded identity projection for a structured result whose full
 * value may be clipped before it reaches a durable event ledger.
 *
 * Arrays and non-identity leaves are omitted deliberately: callers retain the
 * identifiers needed to join status, run, revision, and skill records without
 * duplicating the full result or leaking arbitrary payload content.
 */
export function structuredResultIdentity(
	value: unknown,
): Record<string, unknown> | null {
	let structured = value;
	if (typeof value === "string") {
		try {
			structured = JSON.parse(value) as unknown;
		} catch {
			return null;
		}
	}
	if (
		!structured ||
		typeof structured !== "object" ||
		Array.isArray(structured)
	) {
		return null;
	}

	let visitedObjects = 0;
	const project = (
		candidate: Record<string, unknown>,
		depth: number,
	): Record<string, unknown> | null => {
		if (depth > RESULT_IDENTITY_MAX_DEPTH) return null;
		visitedObjects += 1;
		if (visitedObjects > RESULT_IDENTITY_MAX_OBJECTS) return null;

		const result: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(candidate)) {
			if (
				RESULT_IDENTITY_KEY_RE.test(key) &&
				(typeof child === "string" ||
					typeof child === "number" ||
					typeof child === "boolean")
			) {
				result[key] =
					typeof child === "string"
						? child.slice(0, RESULT_IDENTITY_MAX_STRING_CHARS)
						: child;
				continue;
			}
			if (child && typeof child === "object" && !Array.isArray(child)) {
				const nested = project(child as Record<string, unknown>, depth + 1);
				if (nested && Object.keys(nested).length > 0) result[key] = nested;
			}
		}
		return Object.keys(result).length > 0 ? result : null;
	};

	return project(structured as Record<string, unknown>, 0);
}

function sanitizeUiProjection(value: unknown, depth = 0): unknown {
	if (depth > UI_RESULT_PROJECTION_DEPTH_CAP) return undefined;
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (typeof value === "string") {
		return value.slice(0, UI_RESULT_PROJECTION_STRING_CAP);
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, UI_RESULT_PROJECTION_COLLECTION_CAP)
			.map((entry) => sanitizeUiProjection(entry, depth + 1))
			.filter((entry) => entry !== undefined);
	}
	if (!value || typeof value !== "object") return undefined;
	const projected: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value).slice(
		0,
		UI_RESULT_PROJECTION_COLLECTION_CAP,
	)) {
		const normalizedKey = key.toLowerCase();
		if (
			SENSITIVE_UI_RESULT_KEYS.has(normalizedKey) ||
			(normalizedKey.endsWith("token") && normalizedKey !== "tokenscope")
		) {
			continue;
		}
		const sanitized = sanitizeUiProjection(child, depth + 1);
		if (sanitized !== undefined) projected[key] = sanitized;
	}
	return projected;
}

/**
 * Preserve a bounded initial MCP UI result beside a model-facing/truncated
 * Code Mode result. Only results carrying a valid MCP App resource URI qualify.
 */
export function structuredUiResultProjection(
	value: unknown,
): Record<string, unknown> | null {
	let visited = 0;
	const seen = new Set<unknown>();
	const findCandidate = (
		candidate: unknown,
		depth = 0,
	): Record<string, unknown> | null => {
		if (
			depth > UI_RESULT_PROJECTION_DEPTH_CAP ||
			!candidate ||
			typeof candidate !== "object" ||
			seen.has(candidate) ||
			visited >= UI_RESULT_PROJECTION_COLLECTION_CAP
		) {
			return null;
		}
		seen.add(candidate);
		visited += 1;
		if (Array.isArray(candidate)) {
			for (const child of candidate.slice(
				0,
				UI_RESULT_PROJECTION_COLLECTION_CAP,
			)) {
				const nested = findCandidate(child, depth + 1);
				if (nested) return nested;
			}
			return null;
		}

		const record = candidate as Record<string, unknown>;
		const meta = record._meta;
		const ui =
			meta && typeof meta === "object" && !Array.isArray(meta)
				? (meta as Record<string, unknown>).ui
				: null;
		const resourceUri =
			ui && typeof ui === "object" && !Array.isArray(ui)
				? (ui as Record<string, unknown>).resourceUri
				: null;
		if (
			typeof resourceUri === "string" &&
			MCP_APP_RESOURCE_URI.test(resourceUri)
		) {
			return record;
		}

		for (const child of Object.values(record).slice(
			0,
			UI_RESULT_PROJECTION_COLLECTION_CAP,
		)) {
			const nested = findCandidate(child, depth + 1);
			if (nested) return nested;
		}
		return null;
	};

	const record = findCandidate(value);
	if (!record) return null;
	const meta = record._meta;
	const ui =
		meta && typeof meta === "object" && !Array.isArray(meta)
			? (meta as Record<string, unknown>).ui
			: null;
	const resourceUri =
		ui && typeof ui === "object" && !Array.isArray(ui)
			? (ui as Record<string, unknown>).resourceUri
			: null;
	if (typeof resourceUri !== "string") return null;
	const sanitized = sanitizeUiProjection(record);
	if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
		return null;
	}
	try {
		return new TextEncoder().encode(JSON.stringify(sanitized)).byteLength <=
			UI_RESULT_PROJECTION_BYTE_CAP
			? (sanitized as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
