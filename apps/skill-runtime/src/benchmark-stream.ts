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
	let assistant = "";
	let runId: string | null = null;
	let errMsg: string | null = null;
	let finished = false;
	try {
		while (!finished) {
			const { value, done: streamDone } = await reader.read();
			if (streamDone) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
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
