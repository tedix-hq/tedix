const TRACE_ID =
	/^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;

/** Correlation is diagnostic only. Never retain arbitrary header content. */
export function requestTraceId(headers: Headers): string {
	const parent = /^00-([a-f0-9]{32})-[a-f0-9]{16}-[a-f0-9]{2}$/.exec(
		headers.get("traceparent") ?? "",
	)?.[1];
	const parentId =
		parent && !/^0+$/.test(parent)
			? parent.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5")
			: undefined;
	const inbound =
		parentId ?? headers.get("X-Tedix-Trace-Id") ?? headers.get("X-Trace-Id");
	return inbound && TRACE_ID.test(inbound) ? inbound : crypto.randomUUID();
}

export function correlatedRequest(request: Request): {
	request: Request;
	traceId: string;
} {
	const headers = new Headers(request.headers);
	const traceId = requestTraceId(headers);
	headers.set("X-Tedix-Trace-Id", traceId);
	headers.set("X-Trace-Id", traceId);
	return { request: new Request(request, { headers }), traceId };
}

/** Keep error bodies and HTTP status intact while making support references portable. */
export async function correlatedErrorResponse(
	response: Response,
	traceId: string,
	includeOrpcData = true,
): Promise<Response> {
	if (response.status < 400) return response;
	const headers = new Headers(response.headers);
	const existingTraceId = headers.get("X-Tedix-Trace-Id");
	if (existingTraceId && TRACE_ID.test(existingTraceId))
		traceId = existingTraceId;
	headers.set("X-Tedix-Trace-Id", traceId);
	headers.delete("content-length");
	if (
		includeOrpcData &&
		headers.get("content-type")?.includes("application/json")
	) {
		try {
			const body = (await response.clone().json()) as Record<string, unknown>;
			if (body && typeof body === "object" && !Array.isArray(body)) {
				if (typeof body.traceId === "string" && TRACE_ID.test(body.traceId)) {
					traceId = body.traceId;
					headers.set("X-Tedix-Trace-Id", traceId);
				}
				const envelope = body.json as Record<string, unknown> | undefined;
				if (
					envelope &&
					typeof envelope === "object" &&
					typeof envelope.code === "string"
				) {
					if (
						!envelope.data ||
						(typeof envelope.data === "object" && !Array.isArray(envelope.data))
					)
						envelope.data = { ...(envelope.data as object), traceId };
				}
				return new Response(JSON.stringify(body), {
					status: response.status,
					statusText: response.statusText,
					headers,
				});
			}
		} catch {
			/* Non-JSON upstream failures still carry the response header. */
		}
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
