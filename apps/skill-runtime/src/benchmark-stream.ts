const MAX_LINE_BYTES = 1024 * 1024;

/** Read the benchmark reply without waiting for the upstream stream to close. */
export async function readBenchmarkTurnStream(
	stream: ReadableStream<Uint8Array>,
): Promise<{
	assistant: string;
	runId: string | null;
	errMsg: string | null;
}> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let lineBytes = 0;
	let assistant = "";
	let runId: string | null = null;
	let errMsg: string | null = null;
	let finished = false;
	try {
		while (!finished) {
			const { value, done: streamDone } = await reader.read();
			if (streamDone) break;
			let offset = 0;
			while (offset < value.byteLength) {
				const nl = value.indexOf(10, offset);
				const end = nl < 0 ? value.byteLength : nl;
				lineBytes += end - offset;
				// Check bytes before decoding or appending even a single large chunk.
				if (lineBytes > MAX_LINE_BYTES) {
					errMsg = `Benchmark SSE line exceeds ${MAX_LINE_BYTES} bytes`;
					finished = true;
					break;
				}
				const next = nl < 0 ? end : end + 1;
				buf += decoder.decode(value.subarray(offset, next), { stream: true });
				offset = next;
				if (nl < 0) break;
				const line = buf.trim();
				buf = "";
				lineBytes = 0;
				if (!line.startsWith("data:")) continue;
				try {
					const frame = JSON.parse(line.slice(5).trim());
					if (frame.kind === "done") {
						assistant = typeof frame.text === "string" ? frame.text : assistant;
						runId = frame.runId ?? frame.sessionKey ?? runId;
						finished = true;
					} else if (frame.kind === "error") {
						errMsg = frame.message ?? "error";
						finished = true;
					}
				} catch {
					/* skip non-JSON data lines */
				}
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { assistant, runId, errMsg };
}
