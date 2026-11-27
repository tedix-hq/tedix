import type {
	PersonalAgentAttribution,
	PersonalAgentVisitor,
} from "../schemas/personal-agent-session";

/** The verified agent behind a visitor; unidentified visitors have none. */
export function verifiedPersonalAgent(
	visitor: PersonalAgentVisitor | undefined,
): PersonalAgentAttribution | undefined {
	return visitor && !("kind" in visitor) ? visitor : undefined;
}

export function personalAgentAuditMetadata(
	identity: unknown,
): Record<string, string> {
	const metadata: Record<string, string> = { sessionType: "signed_out" };
	if (typeof identity !== "object" || identity === null) return metadata;
	if ((identity as { kind?: unknown }).kind === "unidentified") {
		metadata.attribution = "unidentified";
		return metadata;
	}
	const claims = identity as PersonalAgentAttribution;
	if (typeof claims.clientId === "string") metadata.client_id = claims.clientId;
	if (typeof claims.agentId === "string") metadata.agentId = claims.agentId;
	if (typeof claims.sessionId === "string") metadata.sid = claims.sessionId;
	return metadata;
}
