import { CAPABILITY_SCOPES, TEDI_MCP_SCOPES } from "./scopes";

/** Human consent presets are bounded by the resource's offered permissions. */
export type HumanConsentPreset = "read" | "all" | "custom";
export const CONSENT_PROTOCOL_SCOPES = [
	"openid",
	"offline_access",
	"profile",
	"email",
] as const;
/** Optional human Connect choices, not the permissions selected or issued. */
export const HUMAN_CONNECT_CONSENT_SCOPES: readonly string[] = [
	...CAPABILITY_SCOPES,
	"connections.read",
	"connections.execute",
	"connections.admin",
];

/** Gateways may support fewer capabilities; never request unknown authority. */
export function selectConnectConsentRequestScopes(
	supported: readonly string[],
	platformAdministration = false,
): string[] {
	const known = new Set<string>(HUMAN_CONNECT_CONSENT_SCOPES);
	if (platformAdministration) known.add("platform:admin");
	return [...new Set(supported)].filter((scope) => known.has(scope));
}
const readScopes = new Set<string>([
	...CAPABILITY_SCOPES.filter((scope) => scope.endsWith(".read")),
	...TEDI_MCP_SCOPES.filter((scope) => scope.endsWith(".read")),
	"connections.read",
	...CONSENT_PROTOCOL_SCOPES,
]);
export function isReadConsentScope(scope: string): boolean {
	return readScopes.has(scope);
}
export function selectConsentPreset(
	offered: readonly { name: string; required?: boolean }[],
	preset: Exclude<HumanConsentPreset, "custom">,
): string[] {
	return [
		...new Set(
			offered
				.filter(
					(scope) =>
						scope.required ||
						preset === "all" ||
						isReadConsentScope(scope.name),
				)
				.map((scope) => scope.name),
		),
	];
}
export function isReadOnlyConsentSelection(scopes: readonly string[]): boolean {
	return scopes.every(isReadConsentScope);
}
