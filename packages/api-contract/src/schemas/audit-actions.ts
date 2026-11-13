/** Known settings actions; custom and historical audit actions remain valid filters. */
export const SETTINGS_AUDIT_ACTIONS = {
	secretSet: "organization.secret.set",
	secretDeleted: "organization.secret.deleted",
	apiKeyCreated: "organization.api_key.created",
	apiKeyRevoked: "organization.api_key.revoked",
	apiKeyDeleted: "organization.api_key.deleted",
	apiKeyRotated: "organization.api_key.rotated",
	roleCreated: "organization.role_template.created",
	roleCopied: "organization.role_template.copied",
	roleApplied: "organization.role_template.applied",
	domainBegun: "organization.domain.begun",
	domainVerified: "organization.domain.verified",
	domainRemoved: "organization.domain.removed",
	residencySet: "organization.residency.set",
	providerPublished: "organization.residency_provider.published",
	mcpDisabled: "organization.mcp_authorization.disabled",
	mcpStaged: "organization.mcp_consent.staged",
	mcpRevoked: "organization.mcp_consent.revoked",
	pushSubscribed: "organization.web_push.subscribed",
	pushUnsubscribed: "organization.web_push.unsubscribed",
	pushPreferencesSet: "organization.web_push.preferences_set",
	pushVisibilitySet: "organization.web_push.visibility_set",
} as const;

export type SettingsAuditAction =
	(typeof SETTINGS_AUDIT_ACTIONS)[keyof typeof SETTINGS_AUDIT_ACTIONS];
