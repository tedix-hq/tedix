import {
	isClientIdMetadataDocumentUrl,
	McpInboundClientPolicySchema,
} from "@tedix/api-contract/schemas/mcp-grant";

export interface InboundClientVerdict {
	/** "none": no policy stored; "invalid": a stored policy that does not parse. */
	mode: "none" | "audit" | "enforce" | "invalid";
	/** Whether an unexpired entry names this exact server and client. */
	listed: boolean;
	allowed: boolean;
}

/**
 * Judge one verified client against an organization's stored inbound client
 * policy. Matching is exact on the MCP server and canonical client ID; the
 * client's own shape never earns an exemption. A stored policy that does not
 * parse admits nothing until an admin rewrites it.
 */
export function evaluateInboundClientPolicy(
	stored: unknown,
	client: { mcpServerId: string; clientId: string },
	now = Date.now(),
): InboundClientVerdict {
	if (stored === undefined || stored === null)
		return { mode: "none", listed: false, allowed: true };
	const parsed = McpInboundClientPolicySchema.safeParse(stored);
	if (!parsed.success)
		return { mode: "invalid", listed: false, allowed: false };
	const listed = parsed.data.entries.some(
		(entry) =>
			entry.mcpServerId === client.mcpServerId &&
			entry.clientId === client.clientId &&
			(entry.expiresAt === undefined || Date.parse(entry.expiresAt) > now),
	);
	return {
		mode: parsed.data.mode,
		listed,
		allowed: parsed.data.mode === "audit" || listed,
	};
}

/** Parse the JSON text the membership query returns; unreadable text is invalid. */
export function parseStoredInboundClientPolicy(json: string | null): unknown {
	if (json === null) return null;
	try {
		return JSON.parse(json) as unknown;
	} catch {
		return { unreadable: true };
	}
}

/**
 * One content-light audit line per organization and decision point. These
 * lines are the inventory an admin reviews before switching to enforce. With
 * no policy stored, only consent staging is recorded: grant checks run on
 * every Connect request.
 */
export function recordInboundClientVerdict(
	stage: "consent" | "grant",
	organizationId: string,
	client: { mcpServerId: string; clientId: string },
	verdict: InboundClientVerdict,
) {
	if (verdict.mode === "none" && stage === "grant") return;
	console.log(
		JSON.stringify({
			_tr: "mcp_inbound_client_policy",
			stage,
			organizationId,
			mcpServerId: client.mcpServerId,
			clientId: client.clientId,
			clientKind: isClientIdMetadataDocumentUrl(client.clientId)
				? "cimd"
				: "opaque",
			mode: verdict.mode,
			listed: verdict.listed,
			allowed: verdict.allowed,
		}),
	);
}
