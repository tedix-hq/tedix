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
	let found = false;
	let finished = false;
	let sizeBytes = 0;

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
				const end = text.indexOf('"');
				if (end >= 0) {
					await writeBase64(text.slice(0, end), true);
					finished = true;
					break;
				}
				await writeBase64(text);
			}
			if (!found || !finished || base64Tail.length > 0) {
				throw new Error(
					"Vertex operation did not contain a complete inline video",
				);
			}
			await writer.close();
		} catch (error) {
			await writer.abort(error);
			throw error;
		} finally {
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
	let found = false;
	let finished = false;
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
			const end = text.indexOf('"');
			const encoded = end < 0 ? text : text.slice(0, end);
			base64Length += encoded.length;
			base64Suffix = (base64Suffix + encoded).slice(-2);
			if (end >= 0) {
				finished = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (!found || !finished || base64Length % 4 !== 0) {
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
	let tail = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return false;
			const text = tail + decoder.decode(value, { stream: true });
			const state = /"done"\s*:\s*(true|false)/.exec(text)?.[1];
			if (state === "true") {
				await reader.cancel();
				return true;
			}
			if (state === "false") return false;
			// Google APIs commonly pretty-print JSON, and the field can straddle
			// arbitrary chunks. Retain enough context for whitespace around done.
			tail = text.slice(-32);
		}
	} finally {
		reader.releaseLock();
	}
}
