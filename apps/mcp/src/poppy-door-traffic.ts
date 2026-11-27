import {
	PoppyDoorRequestSchema,
	type PoppyDoorRequest,
} from "@tedix/api-contract/schemas/audit";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { getApiClient } from "./lib/api-client";
import type { ResolvedApp } from "./resolution";

/** Inspect only bounded envelopes; never retain their content in the traffic row. */
async function envelope(
	body: Request | Response,
): Promise<Record<string, unknown> | null> {
	const reader = body.body?.getReader();
	if (!reader) return null;
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 4 * 1024 * 1024) return null;
			text += decoder.decode(value, { stream: true });
			if (body.headers.get("content-type")?.includes("text/event-stream")) {
				for (const event of text.split(/\r?\n\r?\n/).slice(0, -1)) {
					const data = event
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) continue;
					const parsed: unknown = JSON.parse(data);
					if (isRecord(parsed) && ("result" in parsed || "error" in parsed))
						return parsed;
				}
			}
		}
		const parsed: unknown = JSON.parse(text + decoder.decode());
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	} finally {
		// A tee's cancellation waits for its other branch; never hold up the caller.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

export interface PoppyDoorTraffic {
	identify(clientId: string): void;
	record(response: Response): Promise<void>;
}

export function startPoppyDoorRequest(input: {
	request: Request;
	resolvedApp: ResolvedApp;
	env: CloudflareEnv;
}): PoppyDoorTraffic {
	const { request, resolvedApp, env } = input;
	const time = new Date().toISOString();
	const operation =
		request.method === "POST"
			? envelope(request.clone())
			: Promise.resolve(null);
	let client_id = "unidentified";
	return {
		identify(clientId) {
			client_id = clientId;
		},
		async record(response) {
			// GET may be an indefinite event stream. Its HTTP result is the outcome.
			const reply =
				request.method === "POST"
					? envelope(response.clone())
					: Promise.resolve(null);
			try {
				const [call, result] = await Promise.all([operation, reply]);
				const parsedMethod = PoppyDoorRequestSchema.shape.method.safeParse(
					call?.method ?? request.headers.get("Mcp-Method") ?? request.method,
				);
				const method = parsedMethod.success ? parsedMethod.data : "unknown";
				const requestedTool = isRecord(call?.params)
					? call.params.name
					: request.headers.get("Mcp-Name");
				const tool =
					method === "tools/call"
						? (resolvedApp.tools.find((row) => row.toolId === requestedTool)
								?.toolId ?? null)
						: null;
				const parsedRefusal = PoppyDoorRequestSchema.shape.refused.safeParse(
					result?.error,
				);
				const refused =
					response.status === 429
						? "rate_limited"
						: parsedRefusal.success
							? parsedRefusal.data
							: [401, 403].includes(response.status)
								? "access_denied"
								: null;
				const outcome: PoppyDoorRequest["outcome"] = refused
					? "refused"
					: !response.ok ||
						  result?.error ||
						  (isRecord(result?.result) && result.result.isError === true)
						? "error"
						: response.status === 202
							? "accepted"
							: request.method !== "POST" ||
								  response.status === 204 ||
								  (result && "result" in result)
								? "success"
								: "unknown";
				await getApiClient({
					serviceFetch: env.API_SERVICE,
					orgId: resolvedApp.app.organizationId,
				}).audit.recordPoppyDoorRequest({
					appId: resolvedApp.app.id,
					time,
					client_id,
					method,
					tool,
					refused,
					outcome,
					httpStatus: response.status,
				});
			} catch {
				console.error(
					JSON.stringify({ event: "poppy_door_traffic_write_failed" }),
				);
			}
		},
	};
}
