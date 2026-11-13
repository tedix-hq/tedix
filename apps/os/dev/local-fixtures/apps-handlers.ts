/**
 * Local fixture handlers: App, tool, catalog, connection, analytics and
 * content procedures.
 */

import type { ListCatalogAppsInput } from "@tedix/api-contract/schemas/catalog";
import type {
	ConnectionAllowedResources,
	ConnectionConsumerGrants,
	ConnectionInventoryInput,
} from "@tedix/api-contract/schemas/connections";
import {
	APP_METADATA,
	APP_TOOLS,
	APPS,
	CONNECTION_PROVIDERS,
	CONNECTIONS,
	ELIGIBILITY,
	fullApp,
	ORGANIZATION_INVENTORY,
	PERSONAL_INVENTORY,
} from "./apps";
import { fid, ORG_ID, RpcError, T1, T5 } from "./core";
import { LOCAL_CATALOG, paginate, type Pagination } from "./lookups";
import {
	localConnectionConsumerGrants,
	localConnectionResourceLimits,
	localConnectTickets,
} from "./state";

export const appHandlers: Record<string, (input: never) => unknown> = {
	"catalog/list": (input: ListCatalogAppsInput) => {
		const rows = LOCAL_CATALOG.filter(
			(app) =>
				(!input.search ||
					`${app.name} ${app.description}`
						.toLowerCase()
						.includes(input.search.toLowerCase())) &&
				(!input.category || app.category === input.category) &&
				(!input.connectorType || app.connectorType === input.connectorType) &&
				(!input.healthStatus || app.healthStatus === input.healthStatus),
		);
		const offset = input.offset ?? 0;
		const limit = input.limit ?? 30;
		return {
			apps: rows.slice(offset, offset + limit).map((app) => ({
				...app,
				source: "manual",
				sourceAppId: null,
				regions: null,
				version: null,
			})),
			total: rows.length,
			pagination: { offset, limit, hasMore: offset + limit < rows.length },
		};
	},
	"catalog/getCategories": () => [
		{
			name: "PRODUCTIVITY",
			label: "Productivity",
			count: LOCAL_CATALOG.length,
		},
	],
	"catalog/getBySlug": (input: { slug: string }) =>
		LOCAL_CATALOG.find((app) => app.slug === input.slug) ?? null,
	"connections/getConnectionsOverview": (
		raw: Partial<ConnectionInventoryInput> | undefined,
	) => {
		const input = {
			scope: "organization",
			q: "",
			status: "all",
			limit: 50,
			offset: 0,
			...raw,
		};
		const rows = (
			input.scope === "personal" ? PERSONAL_INVENTORY : ORGANIZATION_INVENTORY
		).filter(
			(row) =>
				(!input.providerId || row.provider.appId === input.providerId) &&
				row.provider.name.toLowerCase().includes(input.q.toLowerCase()) &&
				(input.status === "all" ||
					(input.status === "attention" && row.accountState !== "present") ||
					(input.status === "in_use" && row.references.length > 0) ||
					(input.status === "unused" && row.references.length === 0)),
		);
		const verificationComplete = rows.every(
			(row) =>
				row.accountState !== "unknown" && row.accountState !== "restricted",
		);
		return {
			organizationId: ORG_ID,
			scope: input.scope,
			observedAt: "2026-08-28T00:00:00Z",
			rows: rows.slice(input.offset, input.offset + input.limit),
			total: rows.length,
			hasMore: input.offset + input.limit < rows.length,
			verificationComplete,
			referencesComplete: true,
			issues: verificationComplete
				? []
				: [
						{
							source: "credentials" as const,
							message:
								"Some accounts could not be verified. Missing rows do not prove that no account exists.",
						},
					],
		};
	},
	"connections/getAllowedResources": (input: {
		providerId: string;
		id?: string;
	}) => ({
		allowedResources:
			localConnectionResourceLimits.get(
				`${input.providerId}\0${input.id ?? ""}`,
			) ?? null,
	}),
	"connections/setAllowedResources": (input: {
		providerId: string;
		id?: string;
		allowedResources: ConnectionAllowedResources | null;
	}) => {
		localConnectionResourceLimits.set(
			`${input.providerId}\0${input.id ?? ""}`,
			input.allowedResources,
		);
		return { allowedResources: input.allowedResources };
	},
	"connections/getConsumerGrants": (input: {
		providerId: string;
		connectionInstanceId?: string;
	}) =>
		localConnectionConsumerGrants.get(
			`${input.providerId}\0${input.connectionInstanceId ?? ""}`,
		) ?? { mode: "all" as const },
	"connections/setConsumerGrants": (input: {
		providerId: string;
		connectionInstanceId?: string;
		policy: ConnectionConsumerGrants;
	}) => {
		localConnectionConsumerGrants.set(
			`${input.providerId}\0${input.connectionInstanceId ?? ""}`,
			input.policy,
		);
		return { success: true as const };
	},
	"connections/getUserConnections": () => ({ data: CONNECTIONS }),
	"connections/stageConnectTicket": (input: {
		appId: string;
		scope?: "tenant" | "user";
		connectionInstanceId?: string;
	}) => {
		const ticket = `fixture-connect-ticket-${localConnectTickets.size + 1}`;
		localConnectTickets.set(ticket, {
			appId: input.appId,
			scope: input.scope ?? "user",
			connectionInstanceId: input.connectionInstanceId ?? null,
			redeemed: false,
		});
		return {
			ticket,
			expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
		};
	},
	"connections/settleOutboundOAuth": () => ({
		status: "success" as const,
		provider: "fixture-provider",
	}),
	"connections/redeemConnectTicket": (input: { ticket: string }) => {
		const staged = localConnectTickets.get(input.ticket);
		if (!staged)
			throw new RpcError(
				"NOT_FOUND",
				"This connection was not started in this workspace",
			);
		if (staged.redeemed)
			throw new RpcError("CONFLICT", "This connection was already completed");
		staged.redeemed = true;
		return {
			appId: staged.appId,
			scope: staged.scope,
			connectionInstanceId: staged.connectionInstanceId,
			recorded: staged.connectionInstanceId !== null,
		};
	},
	// Provider catalog behind /admin/connections. Mirrors the two seeded
	// connections so the local page shows both an OAuth and an API-key row.
	"connections/listProviders": () => ({ data: CONNECTION_PROVIDERS }),
	"connections/setProviderAccountMode": (input: {
		appId: string;
		accountMode: "single" | "multiple";
	}) => {
		const providers = [
			...CONNECTION_PROVIDERS,
			...ORGANIZATION_INVENTORY.map((row) => row.provider),
			...PERSONAL_INVENTORY.map((row) => row.provider),
		].filter((provider) => provider.appId === input.appId);
		if (!providers.length)
			throw new RpcError("NOT_FOUND", "Provider not found");
		if (
			!providers.some((provider) =>
				provider.availableAccountModes.includes(input.accountMode),
			)
		)
			throw new RpcError(
				"BAD_REQUEST",
				"Provider sign-in supports only one account per owner",
			);
		for (const provider of providers) provider.accountMode = input.accountMode;
		return input;
	},
	"apps/list": (input: Pagination | undefined) => paginate(APPS, input),
	"apps/listComposerCommands": () => ({ commands: [] }),
	"apps/getByIdWithTools": (input: { appId: string }) => {
		const item = APPS.find((row) => row.id === input.appId);
		if (!item) throw new RpcError("NOT_FOUND", "App not found");
		return {
			app: fullApp(item),
			tools: APP_TOOLS[item.id] ?? [],
			catalogMcp: null,
		};
	},
	"apps/update": (input: {
		appId: string;
		metadata?: { mcpConfig?: Record<string, unknown> };
	}) => {
		const item = APPS.find((row) => row.id === input.appId);
		if (!item) throw new RpcError("NOT_FOUND", "App not found");
		if (input.metadata?.mcpConfig) {
			const current = APP_METADATA[item.id] ?? { mcpConfig: {} };
			APP_METADATA[item.id] = {
				...current,
				mcpConfig: { ...current.mcpConfig, ...input.metadata.mcpConfig },
			};
		}
		return fullApp(item);
	},
	"apps/getGatewayMembership": () => ({
		gateway: null,
		enabled: false,
		unavailableReason: "No gateway configured in this sample workspace.",
	}),
	"apps/listGatewayMemberships": () => ({ gateway: null, memberships: [] }),
	"appTools/list": (input: { appId: string; query?: string } & Pagination) => {
		const inventory = APP_TOOLS[input.appId] ?? [];
		const terms = input.query?.trim().toLowerCase().split(/\s+/) ?? [];
		const tools = inventory.filter((tool) => {
			const text =
				`${tool.toolId} ${tool.title} ${tool.description ?? ""}`.toLowerCase();
			return terms.every((term) => text.includes(term));
		});
		return { ...paginate(tools, input), inventoryTotal: inventory.length };
	},
	"appSecrets/list": () => paginate([]),
	"tediAppAssignments/listByApp": () => ({ data: [] }),
	"tediAppAssignments/listByTedi": () => ({ data: [] }),
	"appAdapters/list": (input: { appId: string } & Pagination) =>
		paginate(
			[
				{
					id: fid("d4", 1),
					appId: input.appId,
					name: "sample-catalog",
					displayName: "Sample product catalog",
					adapterType: "custom",
					enabled: true,
					priority: 0,
					createdAt: T5,
					updatedAt: T5,
				},
			],
			input,
		),
	"content/listSources": (input: { appId: string }) => ({
		success: true,
		sources: [
			{
				id: fid("d5", 1),
				appId: input.appId,
				sourceType: "webpage",
				sourceUrl: "https://example.com/product-guide",
				title: "Sample product guide",
				lastIngestedAt: T5,
				lastIngestStatus: "success",
				documentCount: 4,
				config: null,
				lastError: null,
				createdAt: T5,
				updatedAt: T5,
			},
		],
	}),
	"analytics/getMetrics": () => ({
		totalSessions: 128,
		sessionsChange: 12,
		avgMessages: 4.5,
		avgMessagesChange: 0.5,
		successRate: 96,
		successRateChange: 2,
	}),
	"analytics/getAppSummary": () => ({
		totalEvents: 0,
		toolCalls: 0,
		promptCalls: 0,
		codeExecs: 0,
		successRate: 0,
		avgDurationMs: 0,
		uniqueUsers: 0,
		uniqueCallerTypes: [],
	}),
	"analytics/getWidgetLifecycleHealth": (input: {
		from: string;
		to: string;
	}) => ({
		from: input.from,
		to: input.to,
		status: "unconfigured",
		configured: false,
		hasData: false,
		latestEventAt: null,
		totalEvents: 0,
		readyEvents: 0,
		sessionAttempts: 0,
		failedSessions: 0,
		messageSubmissions: 0,
		firstTokens: 0,
		completedAnswers: 0,
		cancelledAnswers: 0,
		failedAnswers: 0,
		avgReadyMs: 0,
		avgSessionMs: 0,
		avgFirstTokenMs: 0,
		avgAnswerMs: 0,
	}),
	"analytics/getAppToolBreakdown": () => ({ tools: [] }),
	"analytics/getAppTimeSeries": () => ({ buckets: [] }),
	"analytics/getRecentExecutions": () => ({ executions: [] }),
	"analytics/getRecentActivity": () => ({ items: [] }),
	// An audited period with no human activity: every coverage gauge reports
	// no_data rather than a met or breached target.
	"analytics/getHumanActivityReview": () => ({
		windowStart: T1,
		windowEnd: T5,
		totalEvents: 0,
		groups: [],
		coverage: {
			totalGroups: 0,
			unresolvedActorGroups: 0,
			missingSubjectGroups: 0,
			unresolvedToolGroups: 0,
			securityPosture: {
				executedGroups: 0,
				deniedGroups: 0,
				mixedGroups: 0,
				executedEvents: 0,
				deniedEvents: 0,
				unknownRiskEvents: 0,
				denialReasons: [],
			},
			traceEvidence: {
				status: "no_data",
				targetCoverageRate: 0.9,
				proofCoverageRate: 0,
				proofLinkedGroups: 0,
				auditOnlyGroups: 0,
				mcpLinkedGroups: 0,
				runtimeLinkedGroups: 0,
				cognitiveLinkedGroups: 0,
				retrievalDecisionLinkedGroups: 0,
				missingTraceGroups: 0,
				warnings: [],
			},
			traceFreshness: {
				status: "no_data",
				targetMaxLagMs: 120_000,
				freshnessRate: 0,
				proofGroups: 0,
				freshGroups: 0,
				staleGroups: 0,
				missingProofTimestampGroups: 0,
				maxLagMs: null,
				latestAuditAt: null,
				latestProofAt: null,
				warnings: [],
			},
			warnings: [],
		},
	}),
	"analytics/getAppFreshness": () => ({
		windowStart: T1,
		windowEnd: T5,
		currentWindow: {
			totalEvents: 0,
			toolExecutions: 0,
			codeExecutions: 0,
			toolErrors: 0,
		},
		latestAuditEvent: null,
	}),
	"analytics/getCodemodeAnalyticsSummary": () => ({
		byNamespace: [],
		topTools: [],
		execSummary: {
			totalExecs: 0,
			successExecs: 0,
			failedExecs: 0,
			successRate: 0,
			avgDurationMs: 0,
			avgToolCount: 0,
			avgNamespaceCount: 0,
		},
	}),
	"appGating/installedEligibility": () => ELIGIBILITY,
};
