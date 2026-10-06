/** Default fail-closed request-body ceiling. Runaway ~320K-token prompts are
 * well above this bound; normal ~65K-token turns remain below it. */
export const DEFAULT_MAX_AI_REQUEST_BYTES = 750_000;

export class AiRequestTooLargeError extends Error {
	constructor(
		readonly bytes: number,
		readonly limit: number,
	) {
		super(`AI request body exceeds cost guardrail (${bytes}/${limit} bytes)`);
		this.name = "AiRequestTooLargeError";
	}
}

export function resolveMaxAiRequestBytes(configured?: string): number {
	const parsed = Number(configured);
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: DEFAULT_MAX_AI_REQUEST_BYTES;
}

export function assertAiRequestSize(
	body: BodyInit | null | undefined,
	configuredLimit?: string,
): void {
	if (body == null) return;
	let bytes: number | null = null;
	if (typeof body === "string")
		bytes = new TextEncoder().encode(body).byteLength;
	else if (body instanceof URLSearchParams) bytes = body.toString().length;
	else if (body instanceof Blob) bytes = body.size;
	else if (body instanceof ArrayBuffer) bytes = body.byteLength;
	else if (ArrayBuffer.isView(body)) bytes = body.byteLength;
	if (bytes == null) return;
	const limit = resolveMaxAiRequestBytes(configuredLimit);
	if (bytes > limit) throw new AiRequestTooLargeError(bytes, limit);
}
