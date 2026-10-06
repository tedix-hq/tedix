type EmbeddedHostToolClaims = {
	hostOrganizationId?: string;
	hostTenantArgument?: string;
	hostTenantNamespace?: string;
	/** Browser actions may include writes; never advertise these in chat. */
	portableWebMcpCallables?: string[];
	embeddedAssistantCallables?: string[];
};

export function embeddedHostToolGuidance(
	claims: EmbeddedHostToolClaims,
): string[] {
	if (!claims.hostTenantArgument || !claims.hostTenantNamespace) return [];

	const namespacePrefix = `${claims.hostTenantNamespace}.`;
	const admittedCallables = [
		...new Set(
			(claims.embeddedAssistantCallables ?? []).filter((callable) =>
				callable.startsWith(namespacePrefix),
			),
		),
	].sort();
	const tenantCallables = [
		...new Set(claims.embeddedAssistantCallables ?? []),
	].filter((callable) => !callable.startsWith(namespacePrefix));

	return [
		`Every ${claims.hostTenantNamespace} tool call is runtime-bound to ${claims.hostTenantArgument}=${claims.hostOrganizationId ?? "unknown"}. Use tedix_mcp_call_tool for host-platform calls; arbitrary Code Mode is unavailable in this session.`,
		...(admittedCallables.length > 0
			? [
					`This host page explicitly admits these callables: ${admittedCallables.join(", ")}.`,
					"When one of these callables matches the request and its exact parameter schema is already known, call it directly with tedix_mcp_call_tool instead of searching the broader catalog.",
				]
			: []),
		...(tenantCallables.length > 0
			? [
					`This signed session also admits these tenant-scoped Tedix reads: ${tenantCallables.join(", ")}. Use tedix_mcp_call_tool when they match the request and their exact parameter schema is known.`,
				]
			: []),
		// The list above is what the host page admits, not what this session can
		// execute: a callable can be admitted by the signed profile and still not
		// be mounted on the gateway. The schemas shipped with tedix_mcp_call_tool
		// are the authority, and they name the exceptions explicitly.
		"Use the exact admitted parameter schemas supplied with tedix_mcp_call_tool; that list is authoritative over the admitted callables above, including any it marks unavailable. Discovery tools are unavailable in this session. Never guess argument names from page context. If a required schema is missing, tell the user that capability is unavailable here, offer what the available tools can answer, and do not promise a retry that cannot succeed. Never mention schemas, argument names, discovery, or internal tool configuration in the user-facing answer.",
		`For questions about current ${claims.hostTenantNamespace} data or recommended actions, call the matching ${claims.hostTenantNamespace} host tool before answering. Answer only from its verified result. Do not substitute Tedix memory, reflection, runtime activity, connector diagnostics, or prior conversation summaries for host-platform data. If the required host tool fails or cannot verify the requested fact, say that the host data is unavailable and name the missing fact without exposing internal diagnostics.`,
		// Every extra round costs a person roughly ten seconds of staring at a
		// panel: one host call measures ~4s and each model round between calls
		// costs as much again. Somebody asking how many orders are in a status is
		// owed one lookup and an answer, not a survey.
		"Choose the single tool whose description already covers the question and call it once, then answer from that result. Do not chain a second call to confirm, enrich, or cross-check a result that already answers what was asked. Call again only when the first result genuinely does not contain the answer, and say what you are still missing if it does not.",
	];
}
