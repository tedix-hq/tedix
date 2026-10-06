/**
 * Quality-friendly ceiling for one MCP JSON-RPC response. Workflow tools can
 * legitimately return substantial research evidence, but an upstream must not
 * be able to make the skill runtime buffer an unbounded body.
 */
export const MAX_MCP_JSON_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;

export class McpUpstreamResponseTooLargeError extends Error {
	readonly code = "MCP_UPSTREAM_RESPONSE_TOO_LARGE";
	readonly limitBytes: number;
	readonly declaredBytes?: number;
	readonly receivedBytes?: number;

	constructor(input: {
		limitBytes: number;
		declaredBytes?: number;
		receivedBytes?: number;
	}) {
		const detail =
			input.receivedBytes !== undefined
				? `received at least ${input.receivedBytes} bytes`
				: `upstream declared ${input.declaredBytes ?? "an unknown number of"} bytes`;
		super(
			`MCP_UPSTREAM_RESPONSE_TOO_LARGE: ${detail}; the response limit is ${input.limitBytes} bytes`,
		);
		this.name = "McpUpstreamResponseTooLargeError";
		this.limitBytes = input.limitBytes;
		this.declaredBytes = input.declaredBytes;
		this.receivedBytes = input.receivedBytes;
	}
}

function parseContentLength(value: string | null): number | undefined {
	if (value === null) return undefined;
	const normalized = value.trim();
	if (!/^\d+$/.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function cancelBody(
	body: ReadableStream<Uint8Array> | null,
	reason: string,
): Promise<void> {
	if (!body) return;
	try {
		await body.cancel(reason);
	} catch {
		// Best effort: the classified size error is more useful than a secondary
		// cancellation failure from an already-closed upstream stream.
	}
}

/**
 * Materialize an MCP response without trusting Content-Length. An honest
 * oversized declaration is rejected before reading; absent or dishonest
 * declarations are enforced while streaming and the upstream is cancelled as
 * soon as the finite boundary is crossed.
 */
export async function readBoundedMcpResponseText(
	response: Response,
	maxBytes = MAX_MCP_JSON_RPC_RESPONSE_BYTES,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new TypeError("maxBytes must be a positive safe integer");
	}

	const declaredBytes = parseContentLength(
		response.headers.get("content-length"),
	);
	if (declaredBytes !== undefined && declaredBytes > maxBytes) {
		await cancelBody(response.body, "MCP response exceeds size limit");
		throw new McpUpstreamResponseTooLargeError({
			limitBytes: maxBytes,
			declaredBytes,
		});
	}

	if (!response.body) return "";

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			const chunk =
				part.value instanceof Uint8Array
					? part.value
					: new Uint8Array(part.value);
			totalBytes += chunk.byteLength;
			if (totalBytes > maxBytes) {
				try {
					await reader.cancel("MCP response exceeds size limit");
				} catch {
					// Preserve the deterministic, classified boundary error.
				}
				throw new McpUpstreamResponseTooLargeError({
					limitBytes: maxBytes,
					declaredBytes,
					receivedBytes: totalBytes,
				});
			}
			chunks.push(chunk);
		}
	} catch (error) {
		if (!(error instanceof McpUpstreamResponseTooLargeError)) {
			try {
				await reader.cancel("MCP response materialization failed");
			} catch {
				// Preserve the original stream/read failure.
			}
		}
		throw error;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A released or errored reader needs no further cleanup.
		}
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** Read one SSE field (`data`, `event`, ...) from a raw line, or null. */
function readSseField(line: string, field: string): string | null {
	const prefix = `${field}:`;
	if (!line.startsWith(prefix)) return null;
	const value = line.slice(prefix.length);
	return value.startsWith(" ") ? value.slice(1) : value;
}

/** Decode only declared SSE framing; JSON tool values may themselves contain data:. */
export function unwrapMcpResponseBody(
	text: string,
	contentType: string | null,
): string {
	if (
		contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "text/event-stream"
	) {
		return text;
	}
	const data: string[] = [];
	for (const line of text.split(/\r\n|\r|\n/)) {
		if (line === "" && data.length > 0) return data.join("\n");
		const field = readSseField(line, "data");
		if (field !== null) data.push(field);
	}
	return data.length > 0 ? data.join("\n") : text;
}
