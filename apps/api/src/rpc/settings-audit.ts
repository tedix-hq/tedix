import {
	SETTINGS_AUDIT_ACTIONS as actions,
	type SettingsAuditAction,
} from "@tedix/api-contract/schemas/audit-actions";
import type { OsAuditFrame, OsAuditRegistry, OsAuditSpec } from "./os-audit";

const text = (value: unknown) =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const inputId =
	(key: string) =>
	({ input }: OsAuditFrame) =>
		text(input[key]);
const outputId = ({ output }: OsAuditFrame) => text(output.id);
const userId = ({ context }: OsAuditFrame) =>
	context?.userId ?? context?.user?.sub;
const organizationId = ({ input, context }: OsAuditFrame) =>
	context?.organizationId ?? text(input.organizationId);
// Consent can be changed without an active organization in the browser. Its
// verified MCP resource owns the trail, regardless of the currently selected org.
async function mcpOrganizationId({ input, context }: OsAuditFrame) {
	if (!context) return undefined;
	const { getMcpConsentResource } =
		await import("@tedix/db/queries/mcp-consent");
	const mcpServerId = text(input.mcpServerId);
	const resourceUrl = text(input.resourceUrl);
	const resource = mcpServerId
		? { mcpServerId }
		: resourceUrl
			? { resourceUrl }
			: undefined;
	if (!resource) return undefined;
	return (
		(await getMcpConsentResource(context.db, resource))?.organizationId ??
		undefined
	);
}
function entry(
	action: SettingsAuditAction,
	resourceType: string,
	resourceId: OsAuditSpec["resourceId"],
): OsAuditSpec {
	return { action, resourceType, resourceId, organizationId };
}

// No raw input/output metadata: these handlers carry credentials, consent,
// subscription endpoints and key material. Only stable resource identifiers leave them.
export const ORGANIZATION_SECRETS_AUDIT: OsAuditRegistry = {
	set: entry(actions.secretSet, "organization_secret", outputId),
	delete: entry(
		actions.secretDeleted,
		"organization_secret",
		inputId("secretId"),
	),
};
export const ROLE_TEMPLATES_AUDIT: OsAuditRegistry = {
	create: entry(actions.roleCreated, "role_template", outputId),
	copyPlatform: entry(actions.roleCopied, "role_template", outputId),
	apply: entry(actions.roleApplied, "tedi", inputId("tediId")),
};
export const ORGANIZATION_SETTINGS_AUDIT: OsAuditRegistry = {
	createApiKey: {
		...entry(actions.apiKeyCreated, "api_key", ({ output }) =>
			text((output.apiKey as { id?: unknown } | undefined)?.id),
		),
		organizationId: inputId("organizationId"),
	},
	revokeApiKey: {
		...entry(actions.apiKeyRevoked, "api_key", inputId("keyId")),
		organizationId: inputId("organizationId"),
	},
	deleteApiKey: {
		...entry(actions.apiKeyDeleted, "api_key", inputId("keyId")),
		organizationId: inputId("organizationId"),
	},
	rotateApiKey: {
		...entry(actions.apiKeyRotated, "api_key", inputId("keyId")),
		organizationId: inputId("organizationId"),
	},
	beginCustomDomain: entry(
		actions.domainBegun,
		"organization_domain",
		({ output }) => text(output.claimId),
	),
	verifyCustomDomain: entry(
		actions.domainVerified,
		"organization_domain",
		inputId("claimId"),
	),
	removeCustomDomain: entry(
		actions.domainRemoved,
		"organization_domain",
		inputId("claimId"),
	),
	setDataResidency: {
		...entry(actions.residencySet, "organization", organizationId),
		metadata: ({ output }) => ({
			mode: output.mode,
			revision: output.revision,
		}),
	},
	publishResidencyProviderVersion: entry(
		actions.providerPublished,
		"residency_provider",
		inputId("memberKey"),
	),
	disableMcpAuthorization: {
		...entry(actions.mcpDisabled, "mcp_authorization", inputId("mcpServerId")),
		organizationId: mcpOrganizationId,
	},
	stageMultiOrgMcpConsent: {
		...entry(actions.mcpStaged, "mcp_consent", userId),
		organizationId: mcpOrganizationId,
	},
	revokeMultiOrgMcpConsent: {
		...entry(actions.mcpRevoked, "mcp_consent", userId),
		organizationId: mcpOrganizationId,
	},
};
export const WEB_PUSH_AUDIT: OsAuditRegistry = {
	subscribe: {
		...entry(actions.pushSubscribed, "web_push", userId),
		resourceId: (frame) =>
			frame.output.enabled === false ? [] : userId(frame),
	},
	unsubscribe: entry(actions.pushUnsubscribed, "web_push", userId),
	setPreferences: entry(actions.pushPreferencesSet, "web_push", userId),
	setVisibility: entry(actions.pushVisibilitySet, "web_push", userId),
};

export const SETTINGS_AUDIT_NON_EMITTING: Readonly<Record<string, string>> = {
	"organizations.verifyMultiOrgMcpGrant":
		"Internal grant verification and lazy activation; human consent changes are audited at stage and revoke.",
};
