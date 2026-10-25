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

function isEventStream(contentType: string | null): boolean {
	return (
		contentType?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream"
	);
}

/**
 * Incrementally frames SSE lines so a reader can stop once the JSON-RPC
 * response event is complete. Streamable HTTP servers may keep the stream
 * open after the response, so waiting for EOF can hang until a timeout.
 */
class SseResponseDetector {
	private readonly decoder = new TextDecoder();
	private pending = "";
	private scanFrom = 0;
	private data: string[] = [];

	/** Returns true once a complete non-request event has been seen. */
	feed(chunk: Uint8Array): boolean {
		this.pending += this.decoder.decode(chunk, { stream: true });
		while (true) {
			const lineEnd = this.pending.slice(this.scanFrom).search(/[\r\n]/);
			if (lineEnd === -1) {
				this.scanFrom = this.pending.length;
				return false;
			}
			const index = this.scanFrom + lineEnd;
			let next = index + 1;
			if (this.pending[index] === "\r") {
				// A trailing CR may be the first half of CRLF; wait for more.
				if (next === this.pending.length) {
					this.scanFrom = index;
					return false;
				}
				if (this.pending[next] === "\n") next += 1;
			}
			const line = this.pending.slice(0, index);
			this.pending = this.pending.slice(next);
			this.scanFrom = 0;
			if (this.completesResponse(line)) return true;
		}
	}

	private completesResponse(line: string): boolean {
		if (line === "") {
			if (this.data.length === 0) return false;
			const body = this.data.join("\n");
			this.data = [];
			try {
				const message = JSON.parse(body) as Record<string, unknown> | null;
				return !(message && typeof message.method === "string");
			} catch {
				// Malformed data cannot become valid later; let unwrapping report
				// it instead of waiting for EOF.
				return true;
			}
		}
		const field = readSseField(line, "data");
		if (field !== null) this.data.push(field);
		return false;
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
	const sse = isEventStream(response.headers.get("content-type"))
		? new SseResponseDetector()
		: null;
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
			if (sse?.feed(chunk)) {
				try {
					await reader.cancel("MCP SSE response received");
				} catch {
					// The response is complete; a cancellation failure is irrelevant.
				}
				break;
			}
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
	if (!isEventStream(contentType)) return text;
	const data: string[] = [];
	let skippedRequest = false;
	for (const line of [...text.split(/\r\n|\r|\n/), ""]) {
		if (line === "" && data.length > 0) {
			const body = data.join("\n");
			const message = JSON.parse(body) as Record<string, unknown> | null;
			// Streamable HTTP allows notifications and server requests before
			// the response; neither can stand in for the tool's result.
			if (message && typeof message.method === "string") {
				skippedRequest = true;
				data.length = 0;
				continue;
			}
			return body;
		}
		const field = readSseField(line, "data");
		if (field !== null) data.push(field);
	}
	if (skippedRequest) {
		throw new Error("MCP SSE stream ended without a JSON-RPC response");
	}
	return text;
}
