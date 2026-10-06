#!/usr/bin/env bun

import { fileURLToPath } from "node:url";

/**
 * Optional bootstrap/reconciliation of the connection_providers D1 table.
 * This bundled seed supplies provider templates for a new installation or an
 * explicitly selected repair; existing D1 configuration remains authoritative.
 * Review the diff before applying: this snapshot can overwrite later edits.
 * Run from the repository root with bun run connections:seed-providers.
 *
 * Dry-run by default. Pass --apply to mutate the configured remote D1
 * database. Idempotent/safe to re-run: existing rows are diffed and only
 * updated when their stored shape actually differs from the seed. Pass
 * `--only provider-a,provider-b` to reconcile an exact subset without touching
 * unrelated provider rows.
 */

import type { ConnectionProviderTemplate } from "@tedix/api-contract/schemas/connection-provider-templates";

const D1_DB = "DB";
/**
 * Public origin of the installation's assets bucket. Mirrors the Worker's
 * `ASSETS_URL` var: every installation hosts its own logos, so an unset value
 * is a configuration error rather than a reason to point at another bucket.
 */
const ASSETS_URL = (() => {
	const value = process.env.ASSETS_URL?.trim();
	if (!value) {
		throw new Error(
			"ASSETS_URL is not configured: set the public assets origin in the environment or a gitignored .env",
		);
	}
	return value.replace(/\/$/, "");
})();
const APPLY = process.argv.includes("--apply");

function selectedProviderIds(): Set<string> | null {
	const onlyIndex = process.argv.indexOf("--only");
	if (onlyIndex === -1) return null;

	const value = process.argv[onlyIndex + 1];
	if (!value || value.startsWith("--")) {
		throw new Error("--only requires a comma-separated provider id list");
	}

	const ids = value
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	if (ids.length === 0) {
		throw new Error("--only requires at least one provider id");
	}
	return new Set(ids);
}

interface D1Result<T> {
	results?: T[];
	success?: boolean;
	error?: string;
}

interface ConnectionProviderRow {
	id: string;
	name: string;
	description: string;
	icon: string;
	category: string;
	type: string;
	descope_app_id: string | null;
	descope_app_aliases: string | null;
	sort_order: number;
	recommended_scope: string;
	supported_scopes: string;
	required_scopes: string;
	credential_profile: string | null;
	oauth_config: string | null;
}

// =============================================================================
// SEED DATA — frozen snapshot of the CONNECTION_PROVIDERS entries.
// Order matters: it becomes sort_order, preserving today's array-order /
// first-match semantics.
// =============================================================================

export const CONNECTION_PROVIDER_SEEDS: ConnectionProviderTemplate[] = [
	{
		id: "google-analytics",
		name: "Google Analytics",
		description: "Read-only Google Analytics Data and Admin API connection",
		icon: "https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg",
		category: "analytics",
		type: "oauth",
		requiredScopes: ["https://www.googleapis.com/auth/analytics.readonly"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "tenant",
		descopeAppId: "google-analytics",
		credentialProfile: {
			helpText:
				"Connect a Google account that can read the target GA4 property. This connection is read-only.",
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/analytics.readonly",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "analytics-readonly",
					label: "Google Analytics read-only",
					description:
						"Read GA4 Data and Admin API reports without changing Analytics settings.",
					scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
		},
	},
	{
		id: "google-gmail",
		name: "Google Gmail",
		description: "Official Gmail MCP API OAuth connection",
		icon: "https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_512dp.png",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"https://www.googleapis.com/auth/gmail.readonly",
			"https://www.googleapis.com/auth/gmail.compose",
			"https://www.googleapis.com/auth/gmail.modify",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-gmail",
		credentialProfile: {
			helpText:
				"Connect Gmail separately for the official Gmail MCP server. Google requires gmail.readonly, gmail.compose, and gmail.modify for this MCP surface.",
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/gmail.readonly",
				"https://www.googleapis.com/auth/gmail.compose",
				"https://www.googleapis.com/auth/gmail.modify",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "gmail-mcp",
					label: "Gmail MCP",
					description:
						"Search threads, manage labels and mailbox state, and create drafts.",
					scopes: [
						"https://www.googleapis.com/auth/gmail.readonly",
						"https://www.googleapis.com/auth/gmail.compose",
						"https://www.googleapis.com/auth/gmail.modify",
					],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://gmailmcp.googleapis.com/mcp" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://gmailmcp.googleapis.com/mcp" },
			],
		},
	},
	{
		id: "google-calendar",
		name: "Google Calendar",
		description: "Official Google Calendar MCP API OAuth connection",
		icon: "https://ssl.gstatic.com/calendar/images/dynamiclogo_2020q4/calendar_31_2x.png",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
			"https://www.googleapis.com/auth/calendar.events.freebusy",
			"https://www.googleapis.com/auth/calendar.events.readonly",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-calendar",
		credentialProfile: {
			helpText:
				"Connect Calendar separately for the official Google Calendar MCP server.",
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
				"https://www.googleapis.com/auth/calendar.events.freebusy",
				"https://www.googleapis.com/auth/calendar.events.readonly",
				"https://www.googleapis.com/auth/calendar.events",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "calendar-mcp",
					label: "Calendar MCP",
					description: "Read calendars, check free/busy, and read events.",
					scopes: [
						"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
						"https://www.googleapis.com/auth/calendar.events.freebusy",
						"https://www.googleapis.com/auth/calendar.events.readonly",
					],
				},
				{
					id: "calendar-events-write",
					label: "Calendar event writes",
					description:
						"Create, move and delete events. Google Calendar MCP requires this for create_event, update_event and delete_event.",
					scopes: ["https://www.googleapis.com/auth/calendar.events"],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://calendarmcp.googleapis.com/mcp/v1" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://calendarmcp.googleapis.com/mcp/v1" },
			],
		},
	},
	{
		id: "google-drive",
		name: "Google Drive",
		description: "Official Google Drive MCP API OAuth connection",
		icon: "https://ssl.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png",
		category: "storage",
		type: "oauth",
		requiredScopes: [
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/drive.file",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-drive",
		credentialProfile: {
			helpText:
				"Connect Drive separately for the official Google Drive MCP server.",
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/drive.readonly",
				"https://www.googleapis.com/auth/drive.file",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "drive-mcp",
					label: "Drive MCP",
					description: "Search, read, download, create, and copy Drive files.",
					scopes: [
						"https://www.googleapis.com/auth/drive.readonly",
						"https://www.googleapis.com/auth/drive.file",
					],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://drivemcp.googleapis.com/mcp" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://drivemcp.googleapis.com/mcp" },
			],
		},
	},
	{
		id: "google-sheets",
		name: "Google Sheets",
		description: "Official Google Sheets MCP API OAuth connection",
		icon: "https://ssl.gstatic.com/docs/spreadsheets/favicon_jfk2.png",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/spreadsheets.readonly",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-sheets",
		credentialProfile: {
			helpText:
				"Connect Sheets separately for the official Google Sheets MCP server. Google requires drive.readonly and spreadsheets.readonly for this MCP surface.",
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/drive.readonly",
				"https://www.googleapis.com/auth/spreadsheets.readonly",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "sheets-mcp",
					label: "Sheets MCP",
					description: "Find and read spreadsheets via Drive and Sheets.",
					scopes: [
						"https://www.googleapis.com/auth/drive.readonly",
						"https://www.googleapis.com/auth/spreadsheets.readonly",
					],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://sheetsmcp.googleapis.com/mcp/v1" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://sheetsmcp.googleapis.com/mcp/v1" },
			],
		},
	},
	{
		id: "google-chat",
		name: "Google Chat",
		description: "Official Google Chat MCP API OAuth connection",
		icon: "https://www.gstatic.com/images/branding/product/2x/chat_2020q4_512dp.png",
		category: "communication",
		type: "oauth",
		requiredScopes: [
			"https://www.googleapis.com/auth/chat.spaces.readonly",
			"https://www.googleapis.com/auth/chat.memberships.readonly",
			"https://www.googleapis.com/auth/chat.messages.readonly",
			"https://www.googleapis.com/auth/chat.messages.create",
			"https://www.googleapis.com/auth/chat.users.readstate.readonly",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-chat",
		credentialProfile: {
			defaultScopes: [
				"openid",
				"email",
				"profile",
				"https://www.googleapis.com/auth/userinfo.profile",
				"https://www.googleapis.com/auth/chat.spaces.readonly",
				"https://www.googleapis.com/auth/chat.memberships.readonly",
				"https://www.googleapis.com/auth/chat.messages.readonly",
				"https://www.googleapis.com/auth/chat.messages.create",
				"https://www.googleapis.com/auth/chat.users.readstate.readonly",
			],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: [
						"openid",
						"email",
						"profile",
						"https://www.googleapis.com/auth/userinfo.profile",
					],
				},
				{
					id: "chat-mcp",
					label: "Chat MCP",
					scopes: [
						"https://www.googleapis.com/auth/chat.spaces.readonly",
						"https://www.googleapis.com/auth/chat.memberships.readonly",
						"https://www.googleapis.com/auth/chat.messages.readonly",
						"https://www.googleapis.com/auth/chat.messages.create",
						"https://www.googleapis.com/auth/chat.users.readstate.readonly",
					],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
			tokenUrl: "https://oauth2.googleapis.com/token",
			discoveryUrl:
				"https://accounts.google.com/.well-known/openid-configuration",
			pkce: true,
			accessType: "offline",
			prompt: ["select_account", "consent"],
			authorizationUrlParams: [
				{ key: "resource", value: "https://chatmcp.googleapis.com/mcp" },
			],
			tokenUrlParams: [
				{ key: "resource", value: "https://chatmcp.googleapis.com/mcp" },
			],
		},
	},
	{
		id: "github",
		name: "GitHub",
		description: "Repositories, Issues, Pull Requests",
		icon: "https://github.githubassets.com/favicons/favicon.svg",
		category: "development",
		type: "oauth",
		requiredScopes: ["repo", "read:org"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		oauthConfig: {
			authorizationUrl: "https://github.com/login/oauth/authorize",
			tokenUrl: "https://github.com/login/oauth/access_token",
		},
	},
	{
		id: "slack",
		name: "Slack",
		description: "Messages, Channels, Files",
		icon: "https://a.slack-edge.com/80588/marketing/img/icons/icon_slack_hash_colored.png",
		category: "communication",
		type: "oauth",
		requiredScopes: ["chat:write", "channels:read"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		oauthConfig: {
			authorizationUrl: "https://slack.com/oauth/v2/authorize",
			tokenUrl: "https://slack.com/api/oauth.v2.access",
		},
	},
	{
		id: "notion",
		name: "Notion",
		description: "Official Notion MCP OAuth connection",
		icon: "https://www.notion.so/images/favicon.ico",
		category: "productivity",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "notion",
		credentialProfile: {
			helpText:
				"Notion is usually connected per user for personal workspace access, or tenant-scoped for shared company workspaces.",
		},
		oauthConfig: {
			authorizationUrl: "https://mcp.notion.com/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://mcp.notion.com/mcp" },
			],
			tokenUrl: "https://mcp.notion.com/token",
			tokenUrlParams: [
				{ key: "resource", value: "https://mcp.notion.com/mcp" },
			],
			pkce: true,
			useDcr: false,
		},
	},
	{
		id: "alpic",
		name: "Alpic",
		description: "MCP hosting, deployment debugging, and analytics",
		icon: `${ASSETS_URL}/app_catalog/logos/alpic.png`,
		category: "infrastructure",
		type: "oauth",
		requiredScopes: ["openid"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "alpic",
		credentialProfile: {
			defaultScopes: ["openid"],
			scopeGroups: [
				{
					id: "identity",
					label: "Identity",
					scopes: ["openid"],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://mcp.alpic.ai/oauth2/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://mcp.alpic.ai" },
			],
			tokenUrl: "https://mcp.alpic.ai/oauth2/token",
			tokenUrlParams: [{ key: "resource", value: "https://mcp.alpic.ai" }],
			pkce: true,
			useDcr: false,
		},
	},
	{
		id: "peec",
		name: "Peec",
		description: "AI search visibility and brand analytics",
		icon: `${ASSETS_URL}/app_catalog/logos/peec.png`,
		category: "analytics",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "peec",
		credentialProfile: {
			helpText:
				"Peec is usually connected per user for personal analytics access, or tenant-scoped for shared company workspaces.",
		},
		oauthConfig: {
			authorizationUrl: "https://api.peec.ai/mcp/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://api.peec.ai/mcp" },
			],
			tokenUrl: "https://api.peec.ai/mcp/token",
			tokenUrlParams: [{ key: "resource", value: "https://api.peec.ai/mcp" }],
			pkce: true,
			useDcr: false,
		},
	},
	{
		id: "salesforce",
		name: "Salesforce",
		description: "CRM data, Contacts, Opportunities",
		icon: "https://www.salesforce.com/favicon.ico",
		category: "crm",
		type: "oauth",
		requiredScopes: ["api", "refresh_token"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		oauthConfig: {
			authorizationUrl:
				"https://login.salesforce.com/services/oauth2/authorize",
			tokenUrl: "https://login.salesforce.com/services/oauth2/token",
		},
	},
	{
		id: "stripe",
		name: "Stripe",
		description: "Stripe MCP OAuth connection",
		icon: "https://stripe.com/favicon.ico",
		category: "commerce",
		type: "oauth",
		requiredScopes: ["mcp"],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "stripe",
		oauthConfig: {
			authorizationUrl: "https://connect.stripe.com/oauth/authorize",
			tokenUrl: "https://connect.stripe.com/oauth/token",
		},
	},
	{
		id: "hubspot",
		name: "HubSpot",
		description: "CRM, Marketing, Sales",
		icon: "https://www.hubspot.com/favicon.ico",
		category: "crm",
		type: "oauth",
		requiredScopes: ["crm.objects.contacts.read"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		oauthConfig: {
			authorizationUrl: "https://app.hubspot.com/oauth/authorize",
			tokenUrl: "https://api.hubapi.com/oauth/v1/token",
		},
	},
	{
		id: "shopify",
		name: "Shopify",
		description: "Products, Orders, Customers",
		icon: "https://www.shopify.com/favicon.ico",
		category: "commerce",
		type: "oauth",
		requiredScopes: ["read_products", "read_orders"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
	},
	{
		id: "anthropic",
		name: "Anthropic",
		description: "Claude API access",
		icon: "https://www.anthropic.com/favicon.ico",
		category: "development",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
	},
	{
		id: "openai",
		name: "OpenAI",
		description: "GPT, DALL-E, Whisper API access",
		icon: "https://cdn.openai.com/API/images/openai-logomark.png",
		category: "development",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
	},
	{
		id: "firecrawl",
		name: "Firecrawl",
		description: "Firecrawl v2 MCP account connection",
		icon: "https://www.firecrawl.dev/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: ["firecrawl:global"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "tenant",
		descopeAppId: "firecrawl",
		credentialProfile: {
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
			defaultScopes: ["firecrawl:global"],
			helpText:
				"Connect a Firecrawl account and select the team whose v2 MCP tools this organization may use.",
		},
		oauthConfig: {
			authorizationUrl: "https://www.firecrawl.dev/api/oauth/authorize",
			authorizationUrlParams: [
				{
					key: "resource",
					value: "https://mcp.firecrawl.dev/v2/mcp-oauth",
				},
			],
			tokenUrl: "https://www.firecrawl.dev/api/oauth/token",
			tokenUrlParams: [
				{
					key: "resource",
					value: "https://mcp.firecrawl.dev/v2/mcp-oauth",
				},
			],
			pkce: true,
			// Firecrawl advertises CIMD and rejects anonymous DCR. Tedix's stable
			// client metadata document is the registered client identity.
			useDcr: false,
		},
	},
	{
		id: "firecrawl-api-key",
		name: "Firecrawl API Key",
		description: "Unattended Firecrawl v2 MCP access",
		icon: "https://www.firecrawl.dev/favicon.ico",
		category: "development",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "firecrawl-api-key",
		credentialProfile: {
			inputFields: [
				{
					name: "apiKey",
					label: "Firecrawl API key",
					type: "password",
					placeholder: "fc-...",
				},
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
			helpText:
				"Use this v2 MCP connection for unattended workloads that cannot complete browser OAuth.",
		},
	},
	{
		id: "dataforseo-api-key",
		name: "DataForSEO API Key",
		description: "Official DataForSEO MCP access",
		icon: "https://dataforseo.com/favicon.ico",
		category: "analytics",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "dataforseo-api-key",
		credentialProfile: {
			inputFields: [
				{
					name: "apiKey",
					label: "DataForSEO API key (Base64)",
					type: "password",
					helpText:
						"Base64-encoded DataForSEO API login and API password in login:password form.",
				},
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Basic {token}",
			helpText:
				"Use this connection only for the official DataForSEO MCP lane. Tedix-managed SEO credits use a separate hidden platform credential and do not require this connection.",
		},
	},
	{
		id: "promptwatch-api-key",
		name: "PromptWatch API Key",
		description: "PromptWatch project API access",
		icon: "https://promptwatch.com/favicon-96x96.png",
		category: "analytics",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "promptwatch-api-key",
		descopeAppAliases: ["promptwatch-tedix"],
		credentialProfile: {
			inputFields: [
				{
					name: "apiKey",
					label: "PromptWatch API key",
					type: "password",
				},
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
			helpText:
				"Use a project-specific outbound app ID such as promptwatch-tedix when each PromptWatch project has its own key.",
		},
	},
	{
		id: "promptwatch-dashboard-session",
		name: "PromptWatch Dashboard Session",
		description:
			"PromptWatch dashboard access for project profile maintenance not exposed by the public API",
		icon: "https://promptwatch.com/favicon-96x96.png",
		category: "analytics",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "promptwatch-dashboard-session",
		credentialProfile: {
			inputFields: [
				{
					name: "sessionToken",
					label: "PromptWatch session token",
					type: "password",
				},
			],
			tokenTemplate: "{sessionToken}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
			helpText:
				"Use a dedicated PromptWatch owner session only with a narrow tenant-owned tool surface. PromptWatch does not publish a project-update operation or service credential for this dashboard API, so rotate this credential when its upstream session expires.",
		},
	},
	{
		id: "wise-api-token",
		name: "Wise",
		description: "Wise Platform API access for business and personal accounts",
		icon: "https://wise.com/public-resources/assets/icons/wise-personal/favicon.png",
		category: "finance",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "wise-api-token",
		credentialProfile: {
			inputFields: [
				{ name: "apiKey", label: "Wise API token", type: "password" },
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Token {token}",
		},
	},
	{
		id: "github-pat-key",
		name: "GitHub Personal Access Token",
		description:
			"GitHub repository and organization metadata via PAT-backed tools",
		icon: "https://github.githubassets.com/favicons/favicon.svg",
		category: "development",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "github-pat-key",
		credentialProfile: {
			inputFields: [
				{
					name: "apiKey",
					label: "GitHub personal access token",
					type: "password",
					placeholder: "github_pat_...",
				},
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
		},
	},
	{
		id: "sevdesk-api-key",
		name: "Sevdesk API Key",
		description: "Sevdesk accounting API access",
		icon: "https://sevdesk.de/favicon.ico",
		category: "finance",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "sevdesk-api-key",
		credentialProfile: {
			inputFields: [
				{ name: "apiKey", label: "Sevdesk API key", type: "password" },
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "{token}",
		},
	},
	{
		id: "alegra-api-key",
		name: "Alegra API Key",
		description: "Alegra classic REST API access",
		icon: "https://www.alegra.com/favicon.ico",
		category: "finance",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "alegra-api-key",
		credentialProfile: {
			inputFields: [
				{
					name: "email",
					label: "Alegra API email",
					type: "text",
					required: true,
				},
				{
					name: "apiKey",
					label: "Alegra API token",
					type: "password",
					required: true,
					helpText:
						"Use the token from developer.alegra.com. The classic REST API uses HTTP Basic Auth with email:token.",
				},
			],
			tokenTemplate: "{email}:{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Basic {token}",
			authEncoding: "base64",
		},
	},
	{
		id: "tavily-api-key",
		name: "Tavily API Key",
		description: "Tavily search API access",
		icon: "https://www.tavily.com/favicon.ico",
		category: "analytics",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "tavily-api-key",
		credentialProfile: {
			inputFields: [
				{ name: "apiKey", label: "Tavily API key", type: "password" },
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
		},
	},
	{
		id: "nosana-api-key",
		name: "Nosana API Key",
		description: "Nosana API access",
		icon: "https://nosana.com/favicon.ico",
		category: "infrastructure",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "nosana-api-key",
		credentialProfile: {
			inputFields: [
				{ name: "apiKey", label: "Nosana API key", type: "password" },
			],
			tokenTemplate: "{apiKey}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
		},
	},
	{
		id: "cloudflare",
		name: "Cloudflare",
		description: "Workers, D1, R2, KV, Pages, and more",
		icon: "https://www.cloudflare.com/favicon.ico",
		category: "infrastructure",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "cloudflare",
		credentialProfile: {
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
			helpText:
				"Cloudflare uses OAuth through the upstream MCP server. Reconnect if the upstream token cannot refresh after app restoration.",
		},
		oauthConfig: {
			authorizationUrl: "https://mcp.cloudflare.com/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://mcp.cloudflare.com/mcp" },
			],
			tokenUrl: "https://mcp.cloudflare.com/token",
			tokenUrlParams: [
				{ key: "resource", value: "https://mcp.cloudflare.com/mcp" },
			],
			pkce: true,
			useDcr: false,
		},
	},
	{
		id: "todoist",
		name: "Todoist",
		description: "Tasks, Projects, Labels, Reminders",
		icon: "https://www.todoist.com/favicon.ico",
		category: "productivity",
		type: "oauth",
		requiredScopes: ["data:read_write"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "todoist",
		credentialProfile: {
			defaultScopes: ["data:read_write"],
			scopeGroups: [
				{
					id: "tasks",
					label: "Todoist tasks",
					scopes: ["data:read_write"],
				},
			],
		},
		oauthConfig: {
			authorizationUrl: "https://todoist.com/oauth/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://ai.todoist.net/mcp" },
			],
			tokenUrl: "https://todoist.com/oauth/access_token",
			tokenUrlParams: [
				{ key: "resource", value: "https://ai.todoist.net/mcp" },
			],
			pkce: true,
			useDcr: false,
		},
	},
	{
		id: "google-docs",
		name: "Google Docs",
		description: "Official Google Docs MCP API OAuth connection",
		icon: "https://ssl.gstatic.com/docs/documents/images/kix-favicon7.ico",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"openid",
			"email",
			"profile",
			"https://www.googleapis.com/auth/userinfo.profile",
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/documents",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-docs",
	},
	{
		id: "google-slides",
		name: "Google Slides",
		description: "Official Google Slides MCP API OAuth connection",
		icon: "https://ssl.gstatic.com/docs/presentations/images/favicon5.ico",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"email",
			"openid",
			"profile",
			"https://www.googleapis.com/auth/drive.readonly",
			"https://www.googleapis.com/auth/presentations",
			"https://www.googleapis.com/auth/presentations.readonly",
			"https://www.googleapis.com/auth/userinfo.profile",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "google-slides",
	},
	{
		id: "microsoft-graph-mail-tedix",
		name: "Microsoft Graph Mail OAuth",
		description: "OAuth connection for Microsoft Graph Mail.",
		icon: "https://res.cdn.office.net/assets/mail/file-icon/png/outlook_64x64.png",
		category: "communication",
		type: "oauth",
		requiredScopes: [
			"openid",
			"profile",
			"email",
			"offline_access",
			"Mail.Read",
			"Mail.ReadWrite",
			"Mail.Send",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "microsoft-graph-ma-tedix-oauth",
	},
	{
		id: "microsoft-graph-calendar-tedix",
		name: "Microsoft Graph Calendar OAuth",
		description: "OAuth connection for Microsoft Graph Calendar.",
		icon: "https://res.cdn.office.net/assets/mail/file-icon/png/outlook_64x64.png",
		category: "productivity",
		type: "oauth",
		requiredScopes: [
			"openid",
			"profile",
			"email",
			"offline_access",
			"Calendars.Read",
			"Calendars.ReadWrite",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "microsoft-graph-ca-tedix-oauth",
	},
	{
		id: "obsidian-local-rest",
		name: "Obsidian Local REST API",
		description: "Bearer token from the Obsidian Local REST API plugin.",
		icon: "https://obsidian.md/favicon.ico",
		category: "productivity",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "obsidian-local-rest-tedix-key",
		credentialProfile: {
			inputFields: [
				{ name: "token", label: "API key", type: "password", required: true },
			],
			tokenTemplate: "{token}",
			authHeader: "Authorization",
			authTemplate: "Bearer {token}",
		},
	},
	{
		id: "cloudflare-api-key",
		name: "Cloudflare API",
		description:
			"Tenant-scoped Cloudflare API token for governed REST research apps.",
		icon: "https://www.cloudflare.com/favicon.ico",
		category: "infrastructure",
		type: "api_key",
		requiredScopes: [],
		supportedScopes: ["tenant"],
		recommendedScope: "tenant",
		descopeAppId: "cloudflare-api-key",
	},
	{
		id: "atlassian",
		name: "Atlassian Rovo",
		description:
			"OAuth connection for Jira, Confluence, and Compass through Atlassian Rovo MCP.",
		icon: "https://www.atlassian.com/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "atlassian",
	},
	{
		id: "descope",
		name: "Descope",
		description: "Descope project and company administration OAuth connection.",
		icon: "https://www.descope.com/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: [
			"project:read",
			"project:write",
			"company:read",
			"company:write",
		],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "descope",
	},
	{
		id: "planetscale",
		name: "PlanetScale",
		description: "PlanetScale MCP OAuth connection.",
		icon: "https://planetscale.com/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "planetscale",
	},
	{
		id: "neo4j-aura-mcp",
		name: "Neo4j Aura MCP",
		description: "OAuth connection to the official Neo4j Aura MCP server.",
		icon: "https://neo4j.com/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: [],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "neo4j-aura-mcp",
	},
	{
		id: "runway",
		name: "Runway",
		description: "Official Runway MCP OAuth connection",
		icon: "https://runwayml.com/favicon.ico",
		category: "development",
		type: "oauth",
		requiredScopes: ["openid", "api:read_write"],
		supportedScopes: ["tenant", "user"],
		recommendedScope: "user",
		descopeAppId: "runway",
		oauthConfig: {
			authorizationUrl: "https://mcp.runwayml.com/authorize",
			authorizationUrlParams: [
				{ key: "resource", value: "https://mcp.runwayml.com/mcp" },
			],
			tokenUrl: "https://mcp.runwayml.com/token",
			tokenUrlParams: [
				{ key: "resource", value: "https://mcp.runwayml.com/mcp" },
			],
			pkce: true,
			useDcr: true,
			dcrUrl: "https://mcp.runwayml.com/register",
		},
	},
];

// =============================================================================
// SEED RUNNER
// =============================================================================

function sqlString(value: string | null): string {
	if (value === null) return "NULL";
	return `'${value.replaceAll("'", "''")}'`;
}

async function d1<T>(sql: string): Promise<T[]> {
	const proc = Bun.spawn(
		[
			"bunx",
			"wrangler",
			"d1",
			"execute",
			D1_DB,
			"--remote",
			"--config",
			fileURLToPath(new URL("../../apps/api/wrangler.jsonc", import.meta.url)),
			"--json",
			"--command",
			sql,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(
			`wrangler d1 execute failed (${code}):\n${stderr}\n${stdout}`,
		);
	}
	const parsed = JSON.parse(stdout) as D1Result<T>[];
	const first = parsed[0];
	if (!first?.success) throw new Error(`D1 command failed:\n${stdout}`);
	return first.results ?? [];
}

/** Row shape a seed would produce, for diffing against what's already stored. */
function seedToRowShape(
	seed: ConnectionProviderTemplate,
	sortOrder: number,
): Omit<ConnectionProviderRow, "sort_order"> & { sort_order: number } {
	return {
		id: seed.id,
		name: seed.name,
		description: seed.description,
		icon: seed.icon,
		category: seed.category,
		type: seed.type,
		descope_app_id: seed.descopeAppId ?? null,
		descope_app_aliases: seed.descopeAppAliases
			? JSON.stringify(seed.descopeAppAliases)
			: null,
		sort_order: sortOrder,
		recommended_scope: seed.recommendedScope,
		supported_scopes: JSON.stringify(seed.supportedScopes),
		required_scopes: JSON.stringify(seed.requiredScopes),
		credential_profile: seed.credentialProfile
			? JSON.stringify(seed.credentialProfile)
			: null,
		oauth_config: seed.oauthConfig ? JSON.stringify(seed.oauthConfig) : null,
	};
}

function rowsEqual(
	a: ReturnType<typeof seedToRowShape>,
	b: ConnectionProviderRow,
): boolean {
	return (
		a.name === b.name &&
		a.description === b.description &&
		a.icon === b.icon &&
		a.category === b.category &&
		a.type === b.type &&
		a.descope_app_id === b.descope_app_id &&
		a.descope_app_aliases === b.descope_app_aliases &&
		a.sort_order === b.sort_order &&
		a.recommended_scope === b.recommended_scope &&
		a.supported_scopes === b.supported_scopes &&
		a.required_scopes === b.required_scopes &&
		a.credential_profile === b.credential_profile &&
		a.oauth_config === b.oauth_config
	);
}

async function main() {
	const ids = new Set(CONNECTION_PROVIDER_SEEDS.map((seed) => seed.id));
	if (ids.size !== CONNECTION_PROVIDER_SEEDS.length) {
		throw new Error("Duplicate id in CONNECTION_PROVIDER_SEEDS");
	}
	const onlyIds = selectedProviderIds();
	if (onlyIds) {
		const unknownIds = [...onlyIds].filter((id) => !ids.has(id));
		if (unknownIds.length > 0) {
			throw new Error(`Unknown provider id(s): ${unknownIds.join(", ")}`);
		}
	}
	const selectedSeeds = CONNECTION_PROVIDER_SEEDS.map((seed, index) => ({
		seed,
		index,
	})).filter(({ seed }) => !onlyIds || onlyIds.has(seed.id));

	const existingRows = await d1<ConnectionProviderRow>(
		"SELECT id, name, description, icon, category, type, descope_app_id, descope_app_aliases, sort_order, recommended_scope, supported_scopes, required_scopes, credential_profile, oauth_config FROM connection_providers",
	);
	const existingById = new Map(existingRows.map((row) => [row.id, row]));

	console.log(
		`# connection_providers seed (${APPLY ? "apply" : "dry-run"}) — ${selectedSeeds.length} provider${selectedSeeds.length === 1 ? "" : "s"}`,
	);

	let inserted = 0;
	let updated = 0;
	let skipped = 0;

	for (const { seed, index } of selectedSeeds) {
		const target = seedToRowShape(seed, index);
		const existing = existingById.get(seed.id);

		if (!existing) {
			console.log(`insert ${seed.id}`);
			inserted += 1;
			if (APPLY) {
				await d1(
					`INSERT INTO connection_providers (id, name, description, icon, category, type, descope_app_id, descope_app_aliases, sort_order, recommended_scope, supported_scopes, required_scopes, credential_profile, oauth_config, created_at, updated_at)
					 VALUES (${sqlString(target.id)}, ${sqlString(target.name)}, ${sqlString(target.description)}, ${sqlString(target.icon)}, ${sqlString(target.category)}, ${sqlString(target.type)}, ${sqlString(target.descope_app_id)}, ${sqlString(target.descope_app_aliases)}, ${target.sort_order}, ${sqlString(target.recommended_scope)}, ${sqlString(target.supported_scopes)}, ${sqlString(target.required_scopes)}, ${sqlString(target.credential_profile)}, ${sqlString(target.oauth_config)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
				);
			}
			continue;
		}

		if (rowsEqual(target, existing)) {
			skipped += 1;
			continue;
		}

		console.log(`update ${seed.id}`);
		updated += 1;
		if (APPLY) {
			await d1(
				`UPDATE connection_providers
				 SET name = ${sqlString(target.name)},
				     description = ${sqlString(target.description)},
				     icon = ${sqlString(target.icon)},
				     category = ${sqlString(target.category)},
				     type = ${sqlString(target.type)},
				     descope_app_id = ${sqlString(target.descope_app_id)},
				     descope_app_aliases = ${sqlString(target.descope_app_aliases)},
				     sort_order = ${target.sort_order},
				     recommended_scope = ${sqlString(target.recommended_scope)},
				     supported_scopes = ${sqlString(target.supported_scopes)},
				     required_scopes = ${sqlString(target.required_scopes)},
				     credential_profile = ${sqlString(target.credential_profile)},
				     oauth_config = ${sqlString(target.oauth_config)},
				     updated_at = CURRENT_TIMESTAMP
				 WHERE id = ${sqlString(seed.id)}`,
			);
		}
	}

	const staleIds = existingRows
		.map((row) => row.id)
		.filter((id) => !ids.has(id));
	if (staleIds.length) {
		console.log(
			`\nWARNING: rows in connection_providers with no matching seed (not removed by this script): ${staleIds.join(", ")}`,
		);
	}

	console.log(
		`\n${inserted} insert, ${updated} update, ${skipped} unchanged` +
			(APPLY ? "" : " (dry run — re-run with --apply to mutate D1)"),
	);

	if (!APPLY) return;

	// Post-apply assertion: row count matches and every seed round-trips.
	const finalRows = await d1<ConnectionProviderRow>(
		"SELECT id, name, description, icon, category, type, descope_app_id, descope_app_aliases, sort_order, recommended_scope, supported_scopes, required_scopes, credential_profile, oauth_config FROM connection_providers",
	);
	const finalById = new Map(finalRows.map((row) => [row.id, row]));
	const mismatches: string[] = [];
	for (const { seed, index } of selectedSeeds) {
		const target = seedToRowShape(seed, index);
		const final = finalById.get(seed.id);
		if (!final || !rowsEqual(target, final)) {
			mismatches.push(seed.id);
		}
	}
	if (mismatches.length) {
		throw new Error(
			`Post-apply verification failed for: ${mismatches.join(", ")}`,
		);
	}
	console.log(
		`Verified: all ${selectedSeeds.length} selected providers match their seed after apply.`,
	);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
