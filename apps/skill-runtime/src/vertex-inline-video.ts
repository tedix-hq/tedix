const VIDEO_FIELD = /"bytesBase64Encoded"\s*:\s*"/;
const VIDEO_FIELD_TAIL_BYTES = 64;

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

const JSON_SIMPLE_ESCAPES: Record<string, string> = {
	'"': '"',
	"\\": "\\",
	"/": "/",
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "\t",
};
const JSON_STRING_SPECIAL = /["\\]/g;
// Whitespace that base64 decoding (atob) skips.
const BASE64_WHITESPACE = /[\t\n\f\r ]/g;

/**
 * Read a JSON string value chunk by chunk, resolving escapes such as `\/` even
 * when one straddles a chunk boundary. Returns the base64 text of each chunk
 * with the whitespace atob ignores removed, up to the closing quote.
 */
class JsonBase64StringReader {
	#pending = "";
	closed = false;

	read(chunk: string): string {
		const input = this.#pending + chunk;
		this.#pending = "";
		let out = "";
		let from = 0;
		while (from < input.length) {
			JSON_STRING_SPECIAL.lastIndex = from;
			const at = JSON_STRING_SPECIAL.exec(input)?.index;
			if (at === undefined) {
				out += input.slice(from);
				break;
			}
			out += input.slice(from, at);
			if (input[at] === '"') {
				this.closed = true;
				break;
			}
			const kind = input[at + 1];
			if (kind === undefined || (kind === "u" && input.length < at + 6)) {
				this.#pending = input.slice(at);
				break;
			}
			if (kind === "u") {
				const hex = input.slice(at + 2, at + 6);
				if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
					throw new Error("Vertex video string has an invalid escape");
				}
				out += String.fromCharCode(Number.parseInt(hex, 16));
				from = at + 6;
				continue;
			}
			const simple = JSON_SIMPLE_ESCAPES[kind];
			if (simple === undefined) {
				throw new Error("Vertex video string has an invalid escape");
			}
			out += simple;
			from = at + 2;
		}
		return out.replace(BASE64_WHITESPACE, "");
	}
}

/**
 * Decode Vertex's inline base64 video field without materializing the complete
 * JSON response or MP4 in Worker memory. The field is base64 ASCII, so it can
 * be safely located and decoded incrementally while the rest of the operation
 * response is ignored.
 */
export function vertexInlineVideoStream(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): { readable: ReadableStream<Uint8Array>; completed: Promise<void> } {
	const transform = new TransformStream<Uint8Array, Uint8Array>();
	const reader = body.getReader();
	const writer = transform.writable.getWriter();
	const decoder = new TextDecoder();
	let searchTail = "";
	let base64Tail = "";
	const field = new JsonBase64StringReader();
	let found = false;
	let sizeBytes = 0;

	// Canceling the readable side errors the writable; propagate that into
	// upstream cancellation so a consumer that abandons the decoded video
	// also stops the response body read.
	void writer.closed.catch(() => reader.cancel().catch(() => undefined));

	const writeBase64 = async (value: string, final = false): Promise<void> => {
		base64Tail += value;
		const length = final
			? base64Tail.length
			: base64Tail.length - (base64Tail.length % 4);
		if (length === 0) return;
		const encoded = base64Tail.slice(0, length);
		base64Tail = base64Tail.slice(length);
		if (encoded.length % 4 !== 0) {
			throw new Error("Vertex video base64 was not padded to complete groups");
		}
		for (let start = 0; start < encoded.length; start += 65_536) {
			const bytes = base64ToBytes(encoded.slice(start, start + 65_536));
			sizeBytes += bytes.byteLength;
			if (sizeBytes > maxBytes) {
				throw new Error(`Vertex video exceeds ${maxBytes} byte limit`);
			}
			await writer.write(bytes);
		}
	};

	const completed = (async () => {
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				let text = decoder.decode(value, { stream: true });
				if (!found) {
					const combined = searchTail + text;
					const field = VIDEO_FIELD.exec(combined);
					if (!field || field.index === undefined) {
						searchTail = combined.slice(-VIDEO_FIELD_TAIL_BYTES);
						continue;
					}
					found = true;
					text = combined.slice(field.index + field[0].length);
				}
				const encoded = field.read(text);
				if (field.closed) {
					await writeBase64(encoded, true);
					break;
				}
				await writeBase64(encoded);
			}
			if (!found || !field.closed || base64Tail.length > 0) {
				throw new Error(
					"Vertex operation did not contain a complete inline video",
				);
			}
			await writer.close();
		} catch (error) {
			await writer.abort(error);
			throw error;
		} finally {
			try {
				await reader.cancel();
			} catch {
				// Preserve the decode outcome if upstream cancellation also fails.
			}
			reader.releaseLock();
		}
	})();

	return { readable: transform.readable, completed };
}

/**
 * Determine the decoded inline-video length without retaining the response.
 * R2 requires its streamed write to declare an exact length; the subsequent
 * fetch pass is decoded directly into a fixed-length stream.
 */
export async function vertexInlineVideoByteLength(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<number> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let searchTail = "";
	let base64Length = 0;
	let base64Suffix = "";
	const field = new JsonBase64StringReader();
	let found = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let text = decoder.decode(value, { stream: true });
			if (!found) {
				const combined = searchTail + text;
				const field = VIDEO_FIELD.exec(combined);
				if (!field || field.index === undefined) {
					searchTail = combined.slice(-VIDEO_FIELD_TAIL_BYTES);
					continue;
				}
				found = true;
				text = combined.slice(field.index + field[0].length);
			}
			const encoded = field.read(text);
			base64Length += encoded.length;
			base64Suffix = (base64Suffix + encoded).slice(-2);
			// Allow the final group's padding, but never wait for an oversized
			// response to close its JSON string before rejecting it.
			if (base64Length > Math.ceil(maxBytes / 3) * 4) {
				throw new Error("Vertex video exceeds " + maxBytes + " byte limit");
			}
			if (field.closed) break;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Preserve the size outcome if upstream cancellation also fails.
		}
		reader.releaseLock();
	}
	if (!found || !field.closed || base64Length % 4 !== 0) {
		throw new Error("Vertex operation did not contain a complete inline video");
	}
	const padding = base64Suffix.endsWith("==")
		? 2
		: base64Suffix.endsWith("=")
			? 1
			: 0;
	const sizeBytes = (base64Length / 4) * 3 - padding;
	if (sizeBytes > maxBytes) {
		throw new Error("Vertex video exceeds " + maxBytes + " byte limit");
	}
	return sizeBytes;
}

/**
 * Read only the operation state from a Vertex response. A completed operation
 * can append a multi-megabyte inline MP4 after its `done` field; cancel as soon
 * as the state is known so Workflow callers never receive that response.
 */
export async function vertexOperationDone(
	body: ReadableStream<Uint8Array>,
): Promise<boolean> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	// Scan the JSON incrementally so only the root object's `done` member counts:
	// nested `metadata.done` or a string containing `"done":true` must not end
	// polling early, and any token may straddle a chunk boundary.
	let depth = 0;
	let inString = false;
	let escaped = false;
	let expectKey = false;
	let key = "";
	let lastKey = "";
	let readingDone = false;
	let literal = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return false;
			for (const char of decoder.decode(value, { stream: true })) {
				if (inString) {
					if (escaped) escaped = false;
					else if (char === "\\") escaped = true;
					else if (char === '"') {
						inString = false;
						if (depth === 1 && expectKey) {
							lastKey = key;
							expectKey = false;
						}
					} else if (depth === 1 && expectKey && key.length <= 4) key += char;
					continue;
				}
				if (readingDone) {
					if (char >= "a" && char <= "z") {
						literal += char;
						continue;
					}
					if (literal === "true") return true;
					if (literal === "false") return false;
					// Whitespace before the value; any other token is not a boolean.
					if (literal !== "" || !/\s/.test(char)) readingDone = false;
					if (readingDone) continue;
				}
				if (char === '"') {
					inString = true;
					key = "";
				} else if (char === "{" || char === "[") {
					depth += 1;
					expectKey = depth === 1 && char === "{";
				} else if (char === "}" || char === "]") {
					depth -= 1;
				} else if (depth === 1 && char === ",") {
					expectKey = true;
					lastKey = "";
				} else if (depth === 1 && char === ":" && lastKey === "done") {
					readingDone = true;
					literal = "";
				}
			}
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// Preserve the polled state if upstream cancellation also fails.
		}
		reader.releaseLock();
	}
}
