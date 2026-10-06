import { wrapUntrustedInput } from "./untrusted-input";

/** Read-only operator inspection for the legacy per-tedi profile. Canonical
 * projection and recall are owned by apps/api. */
export async function handleAgentMemoryProjectionInspect(
	request: Request,
	resolveProfile: () => Promise<AgentMemoryProfile | null>,
): Promise<Response> {
	if (request.method !== "GET") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const url = new URL(request.url);
	const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
	if (!sessionId || sessionId.length > 64) {
		return Response.json({ error: "invalid_session" }, { status: 400 });
	}
	const profile = await resolveProfile();
	if (!profile) {
		return Response.json({ error: "not_configured" }, { status: 503 });
	}
	const listed = await profile.list({ sessionId, limit: 20 });
	return Response.json({
		ok: true,
		sessionId,
		memories: listed.memories.map((memory) => ({
			...memory,
			summary: wrapUntrustedInput(memory.summary, "agent_memory"),
		})),
	});
}
