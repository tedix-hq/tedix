/**
 * JSON-RPC envelope reader for the Site Builder MCP endpoint.
 *
 * `apps/cms/src/index.ts` serves `/mcp` through `mountMcp()`, which runs the
 * SDK v2 `createMcpHandler` with `responseMode: "auto"`. The wire format is
 * therefore NEGOTIATED, not fixed: the same POST answers with
 * `application/json` or upgrades to `text/event-stream` the moment the handler
 * emits any related message before its result. A client that assumes flat JSON
 * turns a successful 200 into a parse error.
 *
 * This is a wire-level probe (mcp-surface-validate asserts the raw
 * `resultType` and fast-path headers), so it reads the envelope itself rather
 * than through an SDK client. The frame is picked by JSON-RPC id: taking the
 * FIRST parseable `data:` frame yields the request's result only as long as
 * the server emits no notification ahead of it. Site Builder tool calls may,
 * so the correct frame is selected explicitly.
 */

import { isRecord } from "@tedix/api-contract/utils/is-record";

export type SiteBuilderRpcEnvelope = {
	error?: { message: string };
	result?: unknown;
};

function errorMessage(value: unknown, fallback: string): string {
	if (isRecord(value) && typeof value.message === "string")
		return value.message;
	if (typeof value === "string" && value.length > 0) return value;
	return fallback;
}

/** Read one SSE field (`data`, `event`, ...) from a raw line, or null. */
function readSseField(line: string, field: string): string | null {
	const prefix = `${field}:`;
	if (!line.startsWith(prefix)) return null;
	const value = line.slice(prefix.length);
	return value.startsWith(" ") ? value.slice(1) : value;
}

/** Every parseable, non-`[DONE]` `data:` payload in an SSE body, in order. */
function sseFrames(text: string): unknown[] {
	const frames: unknown[] = [];
	for (const line of text.split("\n")) {
		const field = readSseField(line, "data");
		if (field === null) continue;
		const data = field.trim();
		if (!data || data === "[DONE]") continue;
		try {
			frames.push(JSON.parse(data));
		} catch {
			// Partial or non-JSON frames are not JSON-RPC responses; keep scanning.
		}
	}
	return frames;
}

/**
 * Select the JSON-RPC response for `requestId`. Falls back to the last frame
 * carrying `result`/`error` so a server that renumbers ids still resolves,
 * while notification frames (which carry `method`, not `result`) are skipped.
 */
function selectJsonRpcResponse(
	frames: unknown[],
	requestId: string | null,
): Record<string, unknown> | null {
	const responses = frames.filter(
		(frame): frame is Record<string, unknown> =>
			isRecord(frame) && ("result" in frame || "error" in frame),
	);
	if (requestId !== null) {
		const matched = responses.findLast((frame) => frame.id === requestId);
		if (matched) return matched;
	}
	return responses.at(-1) ?? null;
}

/**
 * Read a Site Builder MCP JSON-RPC envelope from either wire format.
 *
 * Never throws: transport and protocol failures come back as
 * `{ error: { message } }` so the caller reports one failure shape.
 */
export async function readSiteBuilderRpcEnvelope(
	response: Response,
	requestId: string | null = null,
): Promise<SiteBuilderRpcEnvelope> {
	const contentType = response.headers.get("content-type") ?? "";

	if (contentType.includes("text/event-stream")) {
		const text = await response.text();
		const selected = selectJsonRpcResponse(sseFrames(text), requestId);
		if (!selected) {
			return {
				error: {
					message: `no JSON-RPC response frame in SSE body: ${text.slice(0, 500) || response.statusText}`,
				},
			};
		}
		if ("error" in selected) {
			return { error: { message: errorMessage(selected.error, "MCP error") } };
		}
		return { result: selected.result };
	}

	let parsed: unknown;
	try {
		if (!contentType.includes("application/json")) {
			throw new Error(
				`Unexpected content-type from MCP server: ${contentType}`,
			);
		}
		parsed = await response.json();
	} catch (error) {
		return {
			error: {
				message: error instanceof Error ? error.message : String(error),
			},
		};
	}

	if (!isRecord(parsed)) {
		return {
			error: {
				message: `unexpected MCP response body: ${JSON.stringify(parsed) ?? response.statusText}`,
			},
		};
	}
	if ("error" in parsed) {
		return { error: { message: errorMessage(parsed.error, "MCP error") } };
	}
	if (!("result" in parsed)) {
		return {
			error: {
				message: `MCP response carried neither result nor error: ${JSON.stringify(parsed).slice(0, 500)}`,
			},
		};
	}
	return { result: parsed.result };
}
