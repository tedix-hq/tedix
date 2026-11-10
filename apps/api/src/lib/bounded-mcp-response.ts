/** Bound upstream JSON and SSE bytes before the SDK parses vendor data. */
export const MAX_MCP_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function boundMcpResponse(response: Response): Promise<Response> {
	if (!response.body) return response;
	const tooLarge = () =>
		new Error(`MCP response exceeds ${MAX_MCP_RESPONSE_BYTES} bytes`);
	if (Number(response.headers.get("Content-Length")) > MAX_MCP_RESPONSE_BYTES) {
		await response.body.cancel();
		throw tooLarge();
	}
	const reader = response.body.getReader();
	let bytes = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await reader.read();
				if (next.done) {
					controller.close();
					return;
				}
				bytes += next.value.byteLength;
				if (bytes > MAX_MCP_RESPONSE_BYTES) {
					await reader.cancel();
					controller.error(tooLarge());
					return;
				}
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
