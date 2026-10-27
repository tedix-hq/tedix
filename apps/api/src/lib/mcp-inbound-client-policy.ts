import type { DbQueryClient } from "@tedix/db/query-client";
import { classifyMcpClientRegistrationMethod } from "@tedix/auth/oauth-client-registration";
import { isReadOnlyConsentSelection } from "@tedix/mcp-shared/auth/consent-scopes";
import { recordMcpInboundClientAttempt } from "@tedix/db/queries/mcp-consent";
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
	client: { mcpServerId: string; clientId: string; scopes?: readonly string[] },
	now = Date.now(),
): InboundClientVerdict {
	const needsException =
		classifyMcpClientRegistrationMethod({
			authType: "oauth",
			clientId: client.clientId,
		}) === "dcr" &&
		client.scopes !== undefined &&
		!isReadOnlyConsentSelection(client.scopes);
	if (stored === undefined || stored === null)
		return { mode: "none", listed: false, allowed: !needsException };
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
		allowed: listed || (parsed.data.mode === "audit" && !needsException),
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

/** A repeated identical decision inside this window writes no inventory row. */
const INVENTORY_REFRESH_SECONDS = 300;

/**
 * One content-light audit line per organization and decision point, plus the
 * admin inventory row. Consent staging always records; a grant check runs on
 * every Connect request and records policy decisions and default denials,
 * persisting only clients the allowlist does not admit. The inventory is best
 * effort: a failed write never changes the decision. `defer` keeps the write off the
 * request path when the caller can extend the request lifetime.
 */
export async function recordInboundClientVerdict(
	db: DbQueryClient,
	stage: "consent" | "grant",
	organizationId: string,
	client: { mcpServerId: string; clientId: string; clientName?: string | null },
	verdict: InboundClientVerdict,
	defer?: (promise: Promise<unknown>) => void,
): Promise<void> {
	if (verdict.mode === "none" && stage === "grant" && verdict.allowed) return;
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
	if (stage === "grant" && verdict.listed) return;
	const write = recordMcpInboundClientAttempt(db, {
		organizationId,
		mcpServerId: client.mcpServerId,
		clientId: client.clientId,
		clientName: client.clientName?.slice(0, 200) || null,
		stage,
		mode: verdict.mode,
		listed: verdict.listed,
		allowed: verdict.allowed,
		at: new Date().toISOString(),
		minIntervalSeconds: INVENTORY_REFRESH_SECONDS,
	}).catch(() => {
		console.error("[mcp-inbound-client-policy] Inventory write failed");
	});
	if (defer) defer(write);
	else await write;
}
