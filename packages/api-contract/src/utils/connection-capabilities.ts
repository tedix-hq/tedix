import type {
	ConnectionCapability,
	ConnectionInventoryRow,
} from "../schemas/connections";

export function buildConnectionSetupUrl(input: {
	providerId: string;
	scope?: "tenant" | "user";
	scopes?: readonly string[];
	connectionInstanceId?: string;
	capabilityId?: string;
}): string {
	const params = new URLSearchParams({ connect: input.providerId });
	if (input.scopes?.length) params.set("scopes", input.scopes.join(","));
	if (input.connectionInstanceId)
		params.set("connectionInstanceId", input.connectionInstanceId);
	if (input.capabilityId) params.set("capability", input.capabilityId);
	return `${input.scope === "user" ? "/account" : "/admin"}/connections?${params}`;
}

/** Projects configured scope groups, never provider-name heuristics or execution authority. */
export function projectConnectionCapabilities(
	row: Pick<
		ConnectionInventoryRow,
		| "provider"
		| "scope"
		| "accountState"
		| "connection"
		| "connectionInstanceId"
	>,
): ConnectionCapability[] {
	const { provider, connection, accountState, scope } = row;
	const groups = provider.credentialProfile?.scopeGroups;
	const definitions = groups?.length
		? groups
		: [
				{
					id: "access",
					label: "Access",
					scopes: provider.credentialProfile?.defaultScopes ?? [],
				},
			];
	return definitions.map((group) => {
		const verified =
			accountState !== "unknown" && accountState !== "restricted";
		const supported =
			provider.enabled && provider.supportedScopes.includes(scope);
		const state: ConnectionCapability["state"] = !supported
			? "not_supported"
			: accountState === "expired" ||
				  connection?.status === "reconnect_needed" ||
				  connection?.status === "revoked"
				? "needs_reauth"
				: accountState === "present" && connection?.status === "connected"
					? group.scopes.every((required) =>
							connection.scopes.includes(required),
						)
						? "connected"
						: "not_configured"
					: "not_configured";
		return {
			id: group.id,
			label: group.label,
			...("description" in group ? { description: group.description } : {}),
			requiredScopes: [...group.scopes],
			state,
			verified,
			setupUrl: buildConnectionSetupUrl({
				providerId: provider.appId,
				scope,
				scopes: group.scopes,
				connectionInstanceId: row.connectionInstanceId,
				capabilityId: group.id,
			}),
		};
	});
}
