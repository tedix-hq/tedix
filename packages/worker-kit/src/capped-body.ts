/**
 * Read a request body as text, stopping once it passes `maxBytes`. Returns
 * null for an oversized body: a declared Content-Length is refused before any
 * read, and an undeclared or understated one is cut off mid-stream instead of
 * being buffered whole.
 */
export async function readTextCapped(
	request: Request,
	maxBytes: number,
): Promise<string | null> {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!request.body) return "";
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
