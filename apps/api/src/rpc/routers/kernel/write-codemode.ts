/**
 * Code Mode transport helpers for Home's approved-write path.
 *
 * Aggregate MCP apps intentionally expose `code`, not thousands of raw tools.
 * Approval planning may use `discover.search` to obtain a bounded, schema-rich
 * catalog, but execution is still a single server-built call using only the
 * callable and arguments persisted in the approval payload.
 */

import {
	stripCodeModeExecutionEnvelope,
	unwrapCallToolResult,
} from "@tedix/mcp-shared/tool-result";

export const CODE_MODE_TOOL_NAME = "code";

export type KernelWriteTransport = "direct" | "codemode";

export interface CodeModeCatalogTool {
	name: string;
	description?: string;
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
	inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface CodeModeDiscoveryEntry {
	callable?: unknown;
	description?: unknown;
	annotations?: unknown;
	parameters?: unknown;
}

type ToolCallResult = {
	structuredContent?: unknown;
	content?: unknown;
	isError?: boolean;
};

const CALLABLE_RE = /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/;
const MAX_DISCOVERY_QUERY_LENGTH = 240;
const MAX_DISCOVERY_RESULTS = 12;
// Wide enough for create_work_items, whose projectId is its 16th property.
const MAX_DISCOVERY_PROPERTIES = 32;
const MAX_DISCOVERY_DESCRIPTION_LENGTH = 160;

function recordFrom(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseJson(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

export function isCodeModeCatalog(tools: Array<{ name: string }>): boolean {
	return tools.some((tool) => tool.name === CODE_MODE_TOOL_NAME);
}

/**
 * Prefer the deterministic route capability; user text is only a fallback.
 * Quoted text and UUIDs in that text are argument values, not intent; a
 * quoted Work title and a project id pushed create_work_items out of the
 * planner's cut.
 */
export function writeDiscoveryQuery(args: {
	capability: string | null;
	content: string;
}): string {
	const source =
		args.capability?.trim() ||
		args.content
			.replace(/"[^"]*"|“[^”]*”/g, " ")
			.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, " ")
			.trim();
	return source
		.replace(/[._/-]+/g, " ")
		.replace(/\s+/g, " ")
		.slice(0, MAX_DISCOVERY_QUERY_LENGTH);
}

export function codeModeDiscoveryParams(
	query: string,
): Record<string, unknown> {
	// Over-fetch: reads and skills are dropped before the planner's cut, so they
	// cannot crowd the matching write out of it.
	const input = {
		query,
		includeParameters: true,
		limit: MAX_DISCOVERY_RESULTS * 4,
	};
	return {
		name: CODE_MODE_TOOL_NAME,
		arguments: {
			// Return only the catalog fields consumed by the planner. Raw JSON Schema
			// for dozens of tools exceeds Code Mode's model-output budget and becomes
			// a deliberately truncated (therefore unparseable) string.
			code: `async () => { const page = await discover.search(${JSON.stringify(input)}); const hits = Array.isArray(page) ? page : page.results; return hits.filter((hit) => hit.callable && hit.annotations?.readOnlyHint !== true).slice(0, ${MAX_DISCOVERY_RESULTS}).map((hit) => ({ callable: hit.callable, description: String(hit.description || "").slice(0, ${MAX_DISCOVERY_DESCRIPTION_LENGTH}), annotations: hit.annotations, parameters: hit.parameters ? { properties: Object.fromEntries(Object.entries(hit.parameters.properties || {}).slice(0, ${MAX_DISCOVERY_PROPERTIES}).map(([name, schema]) => [name, { type: schema && typeof schema === "object" && "type" in schema ? schema.type : "any" }])), required: Array.isArray(hit.parameters.required) ? hit.parameters.required.slice(0, ${MAX_DISCOVERY_PROPERTIES}) : [] } : undefined })); }`,
		},
	};
}

/** Fetch one complete input contract after selection, without its output schema. */
export function codeModeDescribeParams(
	callable: string,
): Record<string, unknown> {
	if (!CALLABLE_RE.test(callable))
		throw new Error(`Invalid Code Mode callable: ${callable}`);
	return {
		name: CODE_MODE_TOOL_NAME,
		arguments: {
			code: `async () => { const hit = await discover.describe({ callable: ${JSON.stringify(callable)} }); return hit ? [{ callable: hit.callable, description: hit.description, annotations: hit.annotations, parameters: hit.parameters }] : []; }`,
		},
	};
}

/**
 * Fetch one known write primitive's complete input contract in a single Code
 * Mode call, skipping the catalog search. A bare tool name (no namespace) is
 * resolved to the first callable ending in `.<name>`, because the namespace
 * that projects it differs per aggregate (`kernel.` vs `home.`).
 */
export function codeModeCanonicalDescribeParams(
	name: string,
): Record<string, unknown> {
	if (!CALLABLE_RE.test(name) && !/^[A-Za-z_]\w*$/.test(name))
		throw new Error(`Invalid Code Mode tool name: ${name}`);
	const resolve = name.includes(".")
		? JSON.stringify(name)
		: `(() => { const hits = Array.isArray(page) ? page : page.results; return hits.find((hit) => typeof hit.callable === "string" && hit.callable.endsWith(${JSON.stringify(`.${name}`)}))?.callable ?? null; })()`;
	const search = name.includes(".")
		? ""
		: `const page = await discover.search(${JSON.stringify({ query: name, limit: 5 })}); `;
	return {
		name: CODE_MODE_TOOL_NAME,
		arguments: {
			code: `async () => { ${search}const callable = ${resolve}; if (!callable) return []; const hit = await discover.describe({ callable }); return hit ? [{ callable: hit.callable, description: hit.description, annotations: hit.annotations, parameters: hit.parameters }] : []; }`,
		},
	};
}

/** Parse the outer `code` tool result into the same shape as raw tools/list. */
export function parseCodeModeCatalog(result: unknown): CodeModeCatalogTool[] {
	let parsed: unknown;
	try {
		parsed = parseJson(
			stripCodeModeExecutionEnvelope(
				unwrapCallToolResult(result, CODE_MODE_TOOL_NAME),
			),
		);
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed)
		? parsed
		: Array.isArray(recordFrom(parsed)?.results)
			? (recordFrom(parsed)?.results as unknown[])
			: [];
	return entries.flatMap((value) => {
		const entry = recordFrom(value) as CodeModeDiscoveryEntry | null;
		if (!entry || typeof entry.callable !== "string") return [];
		if (!CALLABLE_RE.test(entry.callable)) return [];
		const annotations = recordFrom(entry.annotations);
		const parameters = recordFrom(entry.parameters);
		return [
			{
				name: entry.callable,
				...(typeof entry.description === "string"
					? { description: entry.description }
					: {}),
				...(annotations
					? {
							annotations: {
								...(typeof annotations.readOnlyHint === "boolean"
									? { readOnlyHint: annotations.readOnlyHint }
									: {}),
								...(typeof annotations.destructiveHint === "boolean"
									? { destructiveHint: annotations.destructiveHint }
									: {}),
							},
						}
					: {}),
				...(parameters ? { inputSchema: parameters } : {}),
			},
		];
	});
}

/** Build the only Code Mode source allowed to cross the approval boundary. */
export function codeModeExecutionParams(
	callable: string,
	args: Record<string, unknown>,
): Record<string, unknown> {
	if (!CALLABLE_RE.test(callable)) {
		throw new Error(`Invalid Code Mode callable: ${callable}`);
	}
	return {
		name: CODE_MODE_TOOL_NAME,
		arguments: {
			code: `async () => await ${callable}(${JSON.stringify(args)})`,
		},
	};
}

/** Unwrap the result of the outer `code` tool for transcript/evidence storage. */
export function codeModeResultData(result: ToolCallResult): unknown {
	const normalized = stripCodeModeExecutionEnvelope(
		unwrapCallToolResult(result, CODE_MODE_TOOL_NAME),
	);
	if (typeof normalized !== "string") return normalized;
	try {
		return JSON.parse(normalized);
	} catch {
		return normalized;
	}
}
