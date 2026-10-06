/** Legacy per-tedi profile naming retained only for bounded operator inspection
 * and hard-purge cleanup. Canonical writes and recall use the API memory-graph
 * router: apps/api/src/rpc/routers/memory-graph/retrieval-learning.ts (learn)
 * and memory-graph/graph-operations.ts (search). */
export function agentMemoryProfileName(orgId: string, tediId: string): string {
	return `org-${orgId}-tedi-${tediId}`;
}

export async function deleteAgentMemoryProfile(
	namespace: AgentMemoryNamespace,
	orgId: string,
	tediId: string,
): Promise<string> {
	const profile = agentMemoryProfileName(orgId, tediId);
	await namespace.deleteProfile(profile);
	return profile;
}

export async function handleAgentMemoryProfileDelete(
	request: Request,
	namespace: AgentMemoryNamespace,
	orgId: string,
	tediId: string,
): Promise<Response> {
	if (request.method !== "POST") {
		return new Response("Method Not Allowed", { status: 405 });
	}
	const profile = await deleteAgentMemoryProfile(namespace, orgId, tediId);
	return Response.json({ ok: true, profile });
}
