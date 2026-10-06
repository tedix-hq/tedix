import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	buildDelegationChain,
	unresolvedPrincipal,
} from "../../lib/audit-activity";
import type { BaseContext } from "../orpc";
import {
	analyticsContractRouter,
	applyCloudflareTraceEvidence,
	applyDurableCognitionEvidence,
	buildTraceEvidenceCoverage,
	buildTraceEvidenceSummary,
	buildTraceFreshnessCoverage,
	markMcpTraceEvidence,
	namespaceSlugCandidatesForAuditResource,
	toolIdCandidatesForAuditResource,
} from "./analytics";

const mocks = vi.hoisted(() => ({
	getOrganizationById: vi.fn(),
	getOrganizationIdForApp: vi.fn(),
	getOrganizationIdsForApps: vi.fn(),
	resolveActiveProviderInstallationForOutcome: vi.fn(),
	listEmbeddedAttentionReviews: vi.fn(),
	listEmbeddedProviderActivity: vi.fn(),
	trackEmbeddedAttentionOutcome: vi.fn(),
	trackEmbeddedAttentionOutcomes: vi.fn(),
	trackWidgetEvents: vi.fn(),
	hasCodemodeAEConfig: vi.fn(),
	hasAEConfig: vi.fn(),
	getExternalAgentValidationSloFromAE: vi.fn(),
	queryCodemodeAnalyticsSummary: vi.fn(),
	getTediById: vi.fn(),
	listTediObservabilityRows: vi.fn(),
	listSkillRetrievalUtility: vi.fn(),
	insertAuditEvent: vi.fn(),
}));

vi.mock("@tedix/db/queries/organizations", () => ({
	getOrganizationById: mocks.getOrganizationById,
}));

vi.mock("@tedix/db/queries/analytics", () => ({
	getOrganizationIdForApp: mocks.getOrganizationIdForApp,
	getOrganizationIdsForApps: mocks.getOrganizationIdsForApps,
	listEmbeddedAttentionReviews: mocks.listEmbeddedAttentionReviews,
	listEmbeddedProviderActivity: mocks.listEmbeddedProviderActivity,
	trackEmbeddedAttentionOutcome: mocks.trackEmbeddedAttentionOutcome,
	trackEmbeddedAttentionOutcomes: mocks.trackEmbeddedAttentionOutcomes,
	trackWidgetEvents: mocks.trackWidgetEvents,
}));

vi.mock("@tedix/db/queries/provider-installations", () => ({
	resolveActiveProviderInstallationForOutcome:
		mocks.resolveActiveProviderInstallationForOutcome,
}));

vi.mock("@tedix/db/queries/tedis", () => ({
	getTediById: mocks.getTediById,
}));

vi.mock("@tedix/db/queries/cognitive-runtime", () => ({
	listTediObservabilityRows: mocks.listTediObservabilityRows,
}));

vi.mock("@tedix/db/queries/skill-retrieval-utility", () => ({
	listSkillRetrievalUtility: mocks.listSkillRetrievalUtility,
}));

vi.mock("@tedix/db/queries/audit", () => ({
	insertAuditEvent: mocks.insertAuditEvent,
}));

vi.mock("../../lib/analytics-engine", async (importOriginal) => {
	const original =
		await importOriginal<typeof import("../../lib/analytics-engine")>();
	return {
		...original,
		hasAEConfig: mocks.hasAEConfig,
		getExternalAgentValidationSloFromAE:
			mocks.getExternalAgentValidationSloFromAE,
		hasCodemodeAEConfig: mocks.hasCodemodeAEConfig,
		queryCodemodeAnalyticsSummary: mocks.queryCodemodeAnalyticsSummary,
	};
});

const APP_ID = "5eed0020-0000-4000-8000-000000000020";
const ORG_ID = "aff11111-1111-4111-8111-111111111111";

function createContext(dbAll = vi.fn()): BaseContext {
	return {
		authType: "user",
		db: {
			all: dbAll,
		} as unknown as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: {
			limit: vi.fn(async () => ({ success: true })),
		} as unknown as RateLimit,
		url: new URL("https://api.tedix.test/rpc/analytics"),
		user: {
			aud: "test",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			sub: "user-1",
			dct: "tenant-1",
			permissions: ["analytics:read"],
			roles: [],
		},
	};
}

function createClient(context: BaseContext) {
	return createRouterClient(analyticsContractRouter, { context });
}

function emptyCognitionEvidence() {
	return {
		summary: "No cognitive evidence linked.",
		retrievedFactIds: [],
		citedFactIds: [],
		ignoredFactIds: [],
		decisionIds: [],
		latestDecision: null,
		retrieval: {
			topK: null,
			returnedCount: null,
			vectorEnabled: null,
			vectorMs: null,
			hydrateFactsMs: null,
		},
		graph: {
			status: "not_applicable",
			projectedDecisionIds: [],
			warnings: [],
		},
		warnings: [],
	};
}

function emptyCloudflareTraceEvidence() {
	return {
		sampled: false,
		traceId: null,
		spanCount: 0,
		serviceNames: [],
		durationMs: null,
		errorCount: 0,
		traceStartAt: null,
		traceEndAt: null,
	};
}

describe("analytics router freshness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
		mocks.getOrganizationIdForApp.mockResolvedValue(ORG_ID);
		mocks.getTediById.mockResolvedValue({
			id: "55555555-5555-4555-8555-555555555555",
			organizationId: ORG_ID,
		});
		mocks.listTediObservabilityRows.mockResolvedValue({
			runtimeEvents: [],
			auditEvents: [],
			runtimeTruncated: false,
			auditTruncated: false,
		});
		mocks.insertAuditEvent.mockResolvedValue("receipt");
	});

	it("records embedded attention only for matching signed installation authority", async () => {
		mocks.resolveActiveProviderInstallationForOutcome.mockResolvedValue({
			id: "33333333-3333-4333-8333-333333333333",
			providerAppId: APP_ID,
		});
		const serviceContext = createContext();
		serviceContext.user = undefined;
		serviceContext.authType = undefined;
		serviceContext.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORG_ID,
			"X-Tedix-Tedi-Id": "55555555-5555-4555-8555-555555555555",
		});
		serviceContext.url = new URL("https://api/rpc/analytics");
		const client = createClient(serviceContext);
		await expect(
			client.trackEmbeddedAttentionOutcome({
				id: "77777777-7777-4777-8777-777777777777",
				installationId: "33333333-3333-4333-8333-333333333333",
				providerAppId: APP_ID,
				hostOrganizationId: "1",
				hostUserId: "6190",
				origin: "https://staging.acme.example",
				sessionId: "embed:opaque",
				eventType: "open",
				attentionRef: "attn_0123456789abcdef0123456789abcdef",
			}),
		).resolves.toEqual({ success: true });
		expect(
			mocks.resolveActiveProviderInstallationForOutcome,
		).toHaveBeenCalledWith(expect.anything(), {
			installationId: "33333333-3333-4333-8333-333333333333",
			providerAppId: APP_ID,
			customerOrganizationId: ORG_ID,
			primaryTediId: "55555555-5555-4555-8555-555555555555",
			externalTenantId: "1",
			allowedOrigin: "https://staging.acme.example",
		});
		expect(mocks.trackEmbeddedAttentionOutcome).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				appId: APP_ID,
				eventType: "attention_open",
				widgetKey: "attn_0123456789abcdef0123456789abcdef",
				metadata: {
					installationId: "33333333-3333-4333-8333-333333333333",
					tediId: "55555555-5555-4555-8555-555555555555",
					hostOrganizationId: "1",
					hostUserId: "6190",
					origin: "https://staging.acme.example",
				},
			}),
		);
	});

	it("rejects attention outcomes when installation authority does not match", async () => {
		mocks.resolveActiveProviderInstallationForOutcome.mockResolvedValue(
			undefined,
		);
		const serviceContext = createContext();
		serviceContext.user = undefined;
		serviceContext.authType = undefined;
		serviceContext.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORG_ID,
			"X-Tedix-Tedi-Id": "55555555-5555-4555-8555-555555555555",
		});
		serviceContext.url = new URL("https://api/rpc/analytics");
		await expect(
			createClient(serviceContext).trackEmbeddedAttentionOutcome({
				id: "77777777-7777-4777-8777-777777777777",
				installationId: "33333333-3333-4333-8333-333333333333",
				providerAppId: APP_ID,
				hostOrganizationId: "8042",
				hostUserId: "6190",
				origin: "https://staging.acme.example",
				sessionId: "embed:opaque",
				eventType: "impression",
				attentionRef: "attn_0123456789abcdef0123456789abcdef",
			}),
		).rejects.toThrow(/does not match an active installation/);
		expect(mocks.trackEmbeddedAttentionOutcome).not.toHaveBeenCalled();
	});

	it("marks only fresh current refs with this signed actor's prior review as still open", async () => {
		mocks.resolveActiveProviderInstallationForOutcome.mockResolvedValue({
			id: "33333333-3333-4333-8333-333333333333",
			providerAppId: APP_ID,
		});
		mocks.listEmbeddedAttentionReviews.mockResolvedValue([
			{
				attentionRef: "attn_0123456789abcdef0123456789abcdef",
				reviewedAt: "2026-08-31 03:18:37",
			},
		]);
		const serviceContext = createContext();
		serviceContext.user = undefined;
		serviceContext.authType = undefined;
		serviceContext.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORG_ID,
			"X-Tedix-Tedi-Id": "55555555-5555-4555-8555-555555555555",
		});
		serviceContext.url = new URL("https://api/rpc/analytics");

		await expect(
			createClient(serviceContext).correlateEmbeddedAttentionFollowUps({
				installationId: "33333333-3333-4333-8333-333333333333",
				providerAppId: APP_ID,
				hostOrganizationId: "1",
				hostUserId: "6190",
				origin: "https://staging.acme.example",
				sessionId: "embed:opaque",
				sourceGeneratedAt: "2026-08-31T04:00:00.000Z",
				attentionRefs: ["attn_0123456789abcdef0123456789abcdef"],
			}),
		).resolves.toEqual({
			items: [
				{
					attentionRef: "attn_0123456789abcdef0123456789abcdef",
					state: "still_open",
					reviewedAt: "2026-08-31T03:18:37.000Z",
				},
			],
		});
		expect(mocks.listEmbeddedAttentionReviews).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				organizationId: ORG_ID,
				installationId: "33333333-3333-4333-8333-333333333333",
				hostOrganizationId: "1",
				hostUserId: "6190",
			}),
		);
		expect(mocks.trackEmbeddedAttentionOutcomes).toHaveBeenCalledWith(
			expect.anything(),
			[
				expect.objectContaining({
					eventType: "attention_still_open",
					widgetKey: "attn_0123456789abcdef0123456789abcdef",
					metadata: expect.objectContaining({
						hostOrganizationId: "1",
						hostUserId: "6190",
						sourceGeneratedAt: "2026-08-31T04:00:00.000Z",
					}),
				}),
			],
		);
	});

	it("reads current-window freshness from audit events", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-10T17:52:35.000Z"));

		const dbAll = vi
			.fn()
			.mockResolvedValueOnce([
				{
					codeExecutions: 17,
					toolErrors: 4,
					toolExecutions: 29,
					totalEvents: 50,
				},
			])
			.mockResolvedValueOnce([
				{
					action: "mcp.code.execute",
					durationMs: 1038,
					executionId: "29b49eda-4ca4-4abf-b055-c18d57dd7053",
					namespaceCount: 75,
					resourceId: "code",
					timestamp: 1781113895,
					toolCount: 2161,
					traceId: "fcd4181d-d381-4065-93b8-36a57b23c5ab",
				},
			]);
		const client = createClient(createContext(dbAll));

		const result = await client.getAppFreshness({ appId: APP_ID });

		expect(mocks.getOrganizationIdForApp).toHaveBeenCalledWith(
			expect.anything(),
			APP_ID,
		);
		expect(dbAll).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			windowStart: "2026-06-10T17:00:00.000Z",
			windowEnd: "2026-06-10T17:52:35.000Z",
			currentWindow: {
				totalEvents: 50,
				toolExecutions: 29,
				codeExecutions: 17,
				toolErrors: 4,
			},
			latestAuditEvent: {
				action: "mcp.code.execute",
				resourceId: "code",
				timestamp: "2026-06-10T17:51:35.000Z",
				durationMs: 1038,
				executionId: "29b49eda-4ca4-4abf-b055-c18d57dd7053",
				traceId: "fcd4181d-d381-4065-93b8-36a57b23c5ab",
				toolCount: 2161,
				namespaceCount: 75,
			},
		});
	});

	it("rejects cross-org app freshness reads", async () => {
		mocks.getOrganizationIdForApp.mockResolvedValue(
			"bff22222-2222-4222-8222-222222222222",
		);
		const dbAll = vi.fn();
		const client = createClient(createContext(dbAll));

		await expect(client.getAppFreshness({ appId: APP_ID })).rejects.toThrow(
			"You do not have access to this app",
		);
		expect(dbAll).not.toHaveBeenCalled();
	});
});

describe("tedi observability snapshot", () => {
	const TEDI_ID = "55555555-5555-4555-8555-555555555555";
	const OTHER_ORG_ID = "bff22222-2222-4222-8222-222222222222";
	const FROM = "2026-09-03T00:00:00.000Z";
	const TO = "2026-09-03T01:00:00.000Z";

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTediById.mockResolvedValue({
			id: TEDI_ID,
			organizationId: ORG_ID,
		});
		mocks.insertAuditEvent.mockResolvedValue("ignored");
		mocks.listTediObservabilityRows.mockResolvedValue({
			runtimeEvents: [
				{
					id: "runtime-1",
					kind: "tool.failed",
					runId: "run-1",
					traceId: "trace-1",
					payload: {
						toolName: "gmail_send",
						durationMs: 125,
						input: "secret request content",
						output: "secret response content",
					},
					createdAt: "2026-09-03T00:30:00.000Z",
				},
			],
			auditEvents: [
				{
					id: "audit-1",
					action: "mcp.tool.execute",
					resourceType: "tool",
					resourceId: "gmail_send",
					metadata: { requestBody: "secret audit content" },
					timestamp: new Date("2026-09-03T00:31:00.000Z"),
				},
			],
			runtimeTruncated: false,
			auditTruncated: false,
		});
	});

	it("returns a content-free snapshot and records a receipt", async () => {
		const result = await createClient(
			createContext(),
		).getTediObservabilitySnapshot({
			tediId: TEDI_ID,
			from: FROM,
			to: TO,
			limit: 50,
		});

		expect(mocks.listTediObservabilityRows).toHaveBeenCalledWith(
			expect.anything(),
			{
				organizationId: ORG_ID,
				tediId: TEDI_ID,
				from: FROM,
				to: TO,
				limit: 50,
			},
		);
		expect(result.metrics).toMatchObject({
			runtimeEvents: 1,
			auditEvents: 1,
			invocations: 1,
			failedInvocations: 1,
			traceCount: 1,
			averageInvocationDurationMs: 125,
		});
		expect(result.invocations[0]).toMatchObject({
			toolName: "gmail_send",
			outcome: "failure",
			traceId: "trace-1",
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				id: result.auditReceiptId,
				organizationId: ORG_ID,
				action: "observability.snapshot.read",
				resourceType: "tedi",
				resourceId: TEDI_ID,
			}),
		);
	});

	it("rejects a cross-tenant tedi before reading observability rows", async () => {
		mocks.getTediById.mockResolvedValue({
			id: TEDI_ID,
			organizationId: OTHER_ORG_ID,
		});
		await expect(
			createClient(createContext()).getTediObservabilitySnapshot({
				tediId: TEDI_ID,
				from: FROM,
				to: TO,
				limit: 10,
			}),
		).rejects.toThrow("Access denied to this tedi");
		expect(mocks.listTediObservabilityRows).not.toHaveBeenCalled();
		expect(mocks.insertAuditEvent).not.toHaveBeenCalled();
	});

	it("allows an analytics-scoped tedi to read only its own snapshot", async () => {
		const context = createContext();
		context.user = undefined;
		context.authType = undefined;
		context.organizationId = undefined;
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORG_ID,
			"X-Tedix-Tedi-Id": TEDI_ID,
			"X-Tedix-Tedi-Scopes": "analytics:read",
		});
		await expect(
			createClient(context).getTediObservabilitySnapshot({
				tediId: TEDI_ID,
				from: FROM,
				to: TO,
				limit: 10,
			}),
		).resolves.toMatchObject({ tediId: TEDI_ID });

		mocks.getTediById.mockResolvedValue({
			id: "66666666-6666-4666-8666-666666666666",
			organizationId: ORG_ID,
		});
		await expect(
			createClient(context).getTediObservabilitySnapshot({
				tediId: "66666666-6666-4666-8666-666666666666",
				from: FROM,
				to: TO,
				limit: 10,
			}),
		).rejects.toThrow("Access denied to this tedi");
	});

	it("requires analytics read authority", async () => {
		const context = createContext();
		context.user = { ...context.user!, permissions: [] };
		await expect(
			createClient(context).getTediObservabilitySnapshot({
				tediId: TEDI_ID,
				from: FROM,
				to: TO,
				limit: 10,
			}),
		).rejects.toThrow("Required: analytics:read");
		expect(mocks.getTediById).not.toHaveBeenCalled();
	});

	it("rejects an unbounded time window", async () => {
		await expect(
			createClient(createContext()).getTediObservabilitySnapshot({
				tediId: TEDI_ID,
				from: "2026-09-01T00:00:00.000Z",
				to: TO,
				limit: 10,
			}),
		).rejects.toThrow("no longer than 24 hours");
		expect(mocks.getTediById).not.toHaveBeenCalled();
	});
});

describe("skill retrieval utility", () => {
	const tediId = "55555555-5555-4555-8555-555555555555";
	const from = "2026-09-24T00:00:00.000Z";
	const to = "2026-09-24T01:00:00.000Z";

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getTediById.mockResolvedValue({ id: tediId, organizationId: ORG_ID });
		mocks.insertAuditEvent.mockResolvedValue("ignored");
		mocks.listSkillRetrievalUtility.mockResolvedValue({
			rows: [
				{
					injectionEventId: `${tediId}:chat:turn-1:skill-retrieval:0`,
					turnRunId: `${tediId}:chat:turn-1`,
					conversationId: null,
					skillId: "88888888-8888-4888-8888-888888888888",
					injectedAt: "2026-09-24T00:30:00.000Z",
					status: "unknown",
					skillRunId: null,
				},
			],
			truncated: false,
		});
	});

	it("returns unknown for injection without verified execution and audits the read", async () => {
		const result = await createClient(createContext()).getSkillRetrievalUtility(
			{
				tediId,
				from,
				to,
				limit: 20,
			},
		);
		expect(result.metrics).toEqual({
			injected: 1,
			verifiedSuccess: 0,
			verifiedFailure: 0,
			unknown: 1,
		});
		expect(result.rows[0]).toMatchObject({
			injectionEventId: `${tediId}:chat:turn-1:skill-retrieval:0`,
			turnRunId: `${tediId}:chat:turn-1`,
		});
		expect(mocks.listSkillRetrievalUtility).toHaveBeenCalledWith(
			expect.anything(),
			{
				organizationId: ORG_ID,
				tediId,
				from,
				to,
				limit: 20,
			},
		);
		expect(mocks.insertAuditEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ action: "skill.retrieval_utility.read" }),
		);
	});

	it("rejects cross-tenant access before reading rows", async () => {
		mocks.getTediById.mockResolvedValue({
			id: tediId,
			organizationId: "bff22222-2222-4222-8222-222222222222",
		});
		await expect(
			createClient(createContext()).getSkillRetrievalUtility({
				tediId,
				from,
				to,
				limit: 20,
			}),
		).rejects.toThrow("Access denied to this tedi");
		expect(mocks.listSkillRetrievalUtility).not.toHaveBeenCalled();
	});
});

describe("activity attribution display", () => {
	it("redacts long client identifiers in display labels and summaries", () => {
		const actor = unresolvedPrincipal("tedi-1", "tedi");
		const chain = buildDelegationChain({
			mode: "agent",
			actor,
			subject: actor,
			agent: actor,
			clientId:
				"UDM5d1dZRlVxUExnSjYzanJqYnRvaW43UlFiWDpUUEEzRVBIemVYdDlDV3JiZHgzYmlNeHpBYVl2YVEj",
		});

		expect(chain.client).toEqual({
			id: "UDM5d1dZRlVxUExnSjYzanJqYnRvaW43UlFiWDpUUEEzRVBIemVYdDlDV3JiZHgzYmlNeHpBYVl2YVEj",
			label: "UDM5d1...YVEj",
		});
		expect(chain.summary).toBe("tedi-1 via UDM5d1...YVEj");
	});
});

describe("activity review trace evidence", () => {
	it("resolves built-in MCP server utility tools", async () => {
		const dbAll = vi.fn().mockResolvedValue([
			{
				action: "mcp.get_info.execute",
				actorId: "tedix-mcp",
				actorType: "service",
				resourceId: "get_info",
				timestamp: 1781113895,
				appId: null,
				durationMs: 8,
				errorCode: null,
				executionId: "exec-info",
				traceId: "trace-info",
				clientId: "tedix-os",
				subjectUserId: null,
				agentTediId: null,
				oauthClientId: null,
				delegationMode: "direct",
			},
		]);
		const client = createClient(createContext(dbAll));

		const result = await client.getRecentActivity({ limit: 1 });

		expect(result.items[0]).toMatchObject({
			actor: {
				id: "tedix-mcp",
				type: "service",
				label: "Tedix MCP",
				secondary: "Service · tedix-mcp",
				unresolved: false,
			},
			tool: {
				id: "get_info",
				label: "Get Info",
				unresolved: false,
			},
			identityCoverage: {
				toolResolved: true,
			},
		});
		expect(result.items[0]?.identityCoverage.warnings).not.toContain(
			"tool_unresolved",
		);
	});

	it("uses human labels instead of raw machine ids in activity review titles", async () => {
		const dbAll = vi
			.fn()
			.mockResolvedValueOnce([
				{
					action: "mcp.get_info.execute",
					actorId: "tedix-mcp",
					actorType: "service",
					resourceId: "get_info",
					timestamp: 1781113895,
					appId: null,
					durationMs: 8,
					errorCode: null,
					executionId: "exec-info",
					traceId: "trace-info",
					clientId: "tedix-os",
					subjectUserId: null,
					agentTediId: null,
					oauthClientId: null,
					delegationMode: "direct",
				},
			])
			.mockResolvedValueOnce([]);
		const client = createClient(createContext(dbAll));

		const result = await client.getHumanActivityReview({
			from: "2026-06-10T00:00:00.000Z",
			to: "2026-06-10T23:59:59.000Z",
			limit: 1,
		});

		expect(result.groups[0]).toMatchObject({
			title: "Tedix MCP used Get Info",
			actor: {
				id: "tedix-mcp",
				type: "service",
				label: "Tedix MCP",
				unresolved: false,
			},
			traceEvidence: {
				status: "mcp_linked",
			},
			identityCoverage: {
				warningDetails: [
					{
						code: "subject_missing",
						label: "No human subject",
						severity: "info",
					},
				],
			},
		});
		expect(result.coverage.unresolvedActorGroups).toBe(0);
	});

	it("summarizes denied MCP security episodes separately from executions", async () => {
		const dbAll = vi
			.fn()
			.mockResolvedValueOnce([
				{
					action: "mcp.access.denied",
					actorId: "tedix-mcp",
					actorType: "service",
					resourceId: "run_tedi_turn",
					timestamp: 1781113895,
					appId: null,
					durationMs: null,
					errorCode: "insufficient_scope",
					executionId: null,
					traceId: "trace-denied",
					clientId: "codex-client",
					subjectUserId: null,
					agentTediId: null,
					oauthClientId: "codex-client",
					delegationMode: "direct",
					denialReason: "insufficient_scope",
					httpStatus: 403,
					mcpMethod: "tools/call",
					riskTier: "external_side_effect",
				},
			])
			.mockResolvedValueOnce([]);
		const client = createClient(createContext(dbAll));

		const result = await client.getHumanActivityReview({
			from: "2026-06-10T00:00:00.000Z",
			to: "2026-06-10T23:59:59.000Z",
			limit: 1,
		});

		expect(result.groups[0]).toMatchObject({
			title: "Tedix MCP was denied Run Tedi Turn",
			securityPosture: {
				disposition: "denied",
				executedEvents: 0,
				deniedEvents: 1,
				denialReasons: ["insufficient_scope"],
				mcpMethods: ["tools/call"],
				riskTiers: ["external_side_effect"],
				unknownRiskEvents: 0,
			},
		});
		expect(result.coverage.securityPosture).toEqual({
			executedGroups: 0,
			deniedGroups: 1,
			mixedGroups: 0,
			executedEvents: 0,
			deniedEvents: 1,
			unknownRiskEvents: 0,
			denialReasons: ["insufficient_scope"],
		});
	});

	it("hydrates Code Mode subject ids that belong to tedi Descope identities", async () => {
		const dbAll = vi.fn().mockResolvedValue([
			{
				action: "mcp.code.execute",
				actorId: "tedi-cto",
				actorType: "tedi",
				resourceId: "cto__email_inbox_list",
				timestamp: 1781113895,
				appId: null,
				durationMs: 42,
				errorCode: null,
				executionId: "exec-1",
				traceId: "trace-1",
				clientId: "tedix-os",
				subjectUserId: "TPA-cto-access-key",
				agentTediId: "tedi-cto",
				oauthClientId: null,
				delegationMode: "agent",
			},
		]);
		const select = vi
			.fn()
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([]),
				}),
			})
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([]),
				}),
			})
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([]),
				}),
			})
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([
						{
							id: "tedi-cto",
							descopeUserId: "U-cto",
							name: "CTO",
							displayName: "CTO",
							slug: "cto",
							avatar: null,
						},
					]),
				}),
			});
		const context = createContext(dbAll);
		context.db = {
			...context.db,
			select,
		} as unknown as BaseContext["db"];
		const client = createClient(context);

		const result = await client.getRecentActivity({ limit: 1 });

		expect(result.items[0]).toMatchObject({
			actor: {
				id: "tedi-cto",
				type: "tedi",
				label: "CTO",
				unresolved: false,
			},
			subject: {
				id: "tedi-cto",
				type: "tedi",
				label: "CTO",
				unresolved: false,
			},
			identityCoverage: {
				subjectPresent: true,
				subjectResolved: true,
				agentResolved: true,
				toolResolved: true,
			},
			tool: {
				id: "cto__email_inbox_list",
				label: "Email Inbox List",
				appLabel: "CTO",
				appSlug: "cto",
				unresolved: false,
			},
		});
		expect(result.items[0]?.identityCoverage.warnings).not.toContain(
			"subject_unresolved",
		);
		expect(result.items[0]?.identityCoverage.warnings).not.toContain(
			"tool_unresolved",
		);
	});

	it("derives aggregate audit tool lookup candidates", () => {
		expect(
			toolIdCandidatesForAuditResource("notion-tedix__notion-fetch"),
		).toEqual(["notion-tedix__notion-fetch", "notion-fetch", "notion_fetch"]);
		expect(
			toolIdCandidatesForAuditResource("tedi:cto:workstation_run_job"),
		).toEqual([
			"tedi:cto:workstation_run_job",
			"workstation_run_job",
			"workstation-run-job",
		]);
		expect(
			toolIdCandidatesForAuditResource("cms_globex__content_compare"),
		).toEqual([
			"cms_globex__content_compare",
			"content_compare",
			"content-compare",
		]);
		expect(
			namespaceSlugCandidatesForAuditResource("cms_globex__content_compare"),
		).toEqual(["cms_globex", "cms-globex"]);
		expect(
			namespaceSlugCandidatesForAuditResource("tedi:cto:workstation_run_job"),
		).toEqual(["cto"]);
		expect(namespaceSlugCandidatesForAuditResource("code")).toEqual([]);
	});

	it("hydrates aggregate tedi computer tools from namespace slug", async () => {
		const computerTools = [
			"open_computer",
			"close_computer",
			"exec",
			"read_execution",
			"cancel_execution",
			"read",
		];
		const dbAll = vi.fn().mockResolvedValue(
			computerTools.map((tool, index) => ({
				action: "mcp.tool.execute",
				actorId: "tedix-mcp",
				actorType: "service",
				resourceId: `cto__${tool}`,
				timestamp: 1781113895 + index,
				appId: null,
				durationMs: 42,
				errorCode: null,
				executionId: `exec-${index}`,
				traceId: "trace-computer",
				clientId: "tedix-os",
				subjectUserId: null,
				agentTediId: null,
				oauthClientId: null,
				delegationMode: "direct",
			})),
		);
		const select = vi
			.fn()
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([]),
				}),
			})
			.mockReturnValueOnce({
				from: () => ({
					where: vi.fn().mockResolvedValue([
						{
							id: "tedi-cto",
							descopeUserId: "U-cto",
							name: "CTO",
							displayName: "CTO",
							slug: "cto",
							avatar: null,
						},
					]),
				}),
			});
		const context = createContext(dbAll);
		context.db = {
			...context.db,
			select,
		} as unknown as BaseContext["db"];
		const client = createClient(context);

		const result = await client.getRecentActivity({ limit: 10 });

		expect(result.items).toHaveLength(computerTools.length);
		for (const [index, item] of result.items.entries()) {
			const resourceId = `cto__${computerTools[index]}`;
			expect(item.tool).toMatchObject({
				id: resourceId,
				toolName: resourceId,
				appLabel: "CTO",
				appSlug: "cto",
				unresolved: false,
			});
			expect(item.tool?.label).toBe(
				`CTO / ${["Open Computer", "Close Computer", "Computer Command", "Read Execution", "Cancel Execution", "Read File"][index]}`,
			);
			expect(item.identityCoverage.warnings).not.toContain("tool_unresolved");
		}
	});

	it("classifies retrieval and decision evidence joined inside one trace", () => {
		const result = buildTraceEvidenceSummary("trace-1", [
			{
				traceId: "trace-1",
				kind: "run.started",
				createdAt: "2026-06-10T12:00:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {},
			},
			{
				traceId: "trace-1",
				kind: "memory.retrieved",
				createdAt: "2026-06-10T12:01:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {
					factIds: ["fact-a", "fact-b"],
					topK: 5,
					returnedCount: 2,
					vectorEnabled: true,
					vectorMs: 11,
					hydrateFactsMs: 7,
				},
			},
			{
				traceId: "trace-1",
				kind: "decision.recorded",
				createdAt: "2026-06-10T12:02:00.000Z",
				runtimeBackend: "cloudflare-agents",
				payload: {
					rationaleRecordId: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.82,
					citedFactIds: ["fact-a"],
					ignoredFactIds: ["fact-b"],
				},
			},
		]);

		expect(result).toEqual({
			status: "retrieval_decision_linked",
			mcpEvents: 0,
			runtimeEvents: 3,
			cognitiveEvents: 2,
			retrievalEvents: 1,
			decisionEvents: 1,
			retrievedFactCount: 2,
			citedFactCount: 1,
			ignoredFactCount: 1,
			runtimeBackends: ["cloudflare-agents"],
			hasRetrievalDecisionJoin: true,
			latestRuntimeAt: "2026-06-10T12:02:00.000Z",
			latestCognitiveAt: "2026-06-10T12:02:00.000Z",
			latestRetrievalAt: "2026-06-10T12:01:00.000Z",
			latestDecisionAt: "2026-06-10T12:02:00.000Z",
			cloudflare: emptyCloudflareTraceEvidence(),
			cognition: {
				summary:
					"2 fact(s) retrieved; 1 cited / 1 ignored; 1 decision event(s), success; graph projection not observed",
				retrievedFactIds: ["fact-a", "fact-b"],
				citedFactIds: ["fact-a"],
				ignoredFactIds: ["fact-b"],
				decisionIds: ["decision-1"],
				latestDecision: {
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.82,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: null,
					source: "runtime",
				},
				retrieval: {
					topK: 5,
					returnedCount: 2,
					vectorEnabled: true,
					vectorMs: 11,
					hydrateFactsMs: 7,
				},
				graph: {
					status: "not_observed",
					projectedDecisionIds: [],
					warnings: ["graph_projection_not_observed"],
				},
				warnings: ["graph_projection_not_observed"],
			},
			warnings: [],
		});
	});

	it("adds sampled Cloudflare trace evidence without changing cognitive proof", () => {
		const result = applyCloudflareTraceEvidence(
			buildTraceEvidenceSummary("trace-1", []),
			{
				cloudflareTraceId: "cf-trace-1",
				durationMs: 42,
				errorCount: 0,
				serviceNames: ["tedix-mcp-production"],
				spanCount: 7,
				traceEndAt: "2026-06-10T12:00:00.042Z",
				traceStartAt: "2026-06-10T12:00:00.000Z",
			},
		);

		expect(result.status).toBe("audit_only");
		expect(result.cloudflare).toEqual({
			sampled: true,
			traceId: "cf-trace-1",
			spanCount: 7,
			serviceNames: ["tedix-mcp-production"],
			durationMs: 42,
			errorCount: 0,
			traceStartAt: "2026-06-10T12:00:00.000Z",
			traceEndAt: "2026-06-10T12:00:00.042Z",
		});
	});

	it("hydrates cognition evidence from durable rationale records", () => {
		const result = applyDurableCognitionEvidence(
			buildTraceEvidenceSummary("trace-1", [
				{
					traceId: "trace-1",
					kind: "memory.retrieved",
					createdAt: "2026-06-10T12:01:00.000Z",
					runtimeBackend: "cloudflare-agents",
					payload: {
						factIds: ["fact-a", "fact-b"],
						topK: 5,
						returnedCount: 2,
						vectorEnabled: true,
						vectorMs: 11,
						hydrateFactsMs: 7,
					},
				},
				{
					traceId: "trace-1",
					kind: "decision.recorded",
					createdAt: "2026-06-10T12:02:00.000Z",
					runtimeBackend: "cloudflare-agents",
					payload: {
						rationaleRecordId: "decision-1",
						category: "operations",
						outcomeStatus: "pending",
						confidence: 0.72,
					},
				},
			]),
			[
				{
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.91,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: "2026-06-10T12:04:00.000Z",
					evidence: {
						factIds: ["fact-a"],
					},
				},
			],
		);

		expect(result).toMatchObject({
			status: "retrieval_decision_linked",
			citedFactCount: 1,
			ignoredFactCount: 1,
			hasRetrievalDecisionJoin: true,
			cognition: {
				summary:
					"2 fact(s) retrieved; 1 cited / 1 ignored; 1 decision event(s), success; graph projection not observed",
				retrievedFactIds: ["fact-a", "fact-b"],
				citedFactIds: ["fact-a"],
				ignoredFactIds: ["fact-b"],
				decisionIds: ["decision-1"],
				latestDecision: {
					id: "decision-1",
					category: "operations",
					outcomeStatus: "success",
					confidence: 0.91,
					createdAt: "2026-06-10T12:02:00.000Z",
					completedAt: "2026-06-10T12:04:00.000Z",
					source: "rationale_record",
				},
				warnings: ["graph_projection_not_observed"],
			},
			warnings: [],
		});
	});

	it("keeps audit-only traces explicit instead of implying cognitive proof", () => {
		expect(buildTraceEvidenceSummary("trace-2", [])).toEqual({
			status: "audit_only",
			mcpEvents: 0,
			runtimeEvents: 0,
			cognitiveEvents: 0,
			retrievalEvents: 0,
			decisionEvents: 0,
			retrievedFactCount: 0,
			citedFactCount: 0,
			ignoredFactCount: 0,
			runtimeBackends: [],
			hasRetrievalDecisionJoin: false,
			latestRuntimeAt: null,
			latestCognitiveAt: null,
			latestRetrievalAt: null,
			latestDecisionAt: null,
			cloudflare: emptyCloudflareTraceEvidence(),
			cognition: emptyCognitionEvidence(),
			warnings: ["runtime_trace_missing"],
		});
	});

	it("counts MCP audit events as trace proof without implying runtime proof", () => {
		expect(
			markMcpTraceEvidence(buildTraceEvidenceSummary("trace-2", []), 4),
		).toEqual({
			status: "mcp_linked",
			mcpEvents: 4,
			runtimeEvents: 0,
			cognitiveEvents: 0,
			retrievalEvents: 0,
			decisionEvents: 0,
			retrievedFactCount: 0,
			citedFactCount: 0,
			ignoredFactCount: 0,
			runtimeBackends: [],
			hasRetrievalDecisionJoin: false,
			latestRuntimeAt: null,
			latestCognitiveAt: null,
			latestRetrievalAt: null,
			latestDecisionAt: null,
			cloudflare: emptyCloudflareTraceEvidence(),
			cognition: emptyCognitionEvidence(),
			warnings: [],
		});
	});

	it("summarizes trace proof coverage against the review SLO", () => {
		const coverage = buildTraceEvidenceCoverage([
			{
				traceEvidence: markMcpTraceEvidence(
					buildTraceEvidenceSummary("trace-a", []),
					2,
				),
			},
			{
				traceEvidence: buildTraceEvidenceSummary("trace-b", [
					{
						traceId: "trace-b",
						kind: "run.started",
						createdAt: "2026-06-10T12:04:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: {},
					},
				]),
			},
			{
				traceEvidence: buildTraceEvidenceSummary("trace-c", [
					{
						traceId: "trace-c",
						kind: "memory.retrieved",
						createdAt: "2026-06-10T12:05:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { factIds: ["fact-a"] },
					},
					{
						traceId: "trace-c",
						kind: "decision.completed",
						createdAt: "2026-06-10T12:05:10.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { citedFactIds: ["fact-a"] },
					},
				]),
			},
		]);

		expect(coverage).toEqual({
			status: "met",
			targetCoverageRate: 0.8,
			proofCoverageRate: 1,
			proofLinkedGroups: 3,
			auditOnlyGroups: 0,
			mcpLinkedGroups: 1,
			runtimeLinkedGroups: 1,
			cognitiveLinkedGroups: 0,
			retrievalDecisionLinkedGroups: 1,
			missingTraceGroups: 0,
			warnings: ["cognitive_trace_missing"],
		});
	});

	it("marks empty trace proof coverage as no-data", () => {
		expect(buildTraceEvidenceCoverage([])).toEqual({
			status: "no_data",
			targetCoverageRate: 0.8,
			proofCoverageRate: 0,
			proofLinkedGroups: 0,
			auditOnlyGroups: 0,
			mcpLinkedGroups: 0,
			runtimeLinkedGroups: 0,
			cognitiveLinkedGroups: 0,
			retrievalDecisionLinkedGroups: 0,
			missingTraceGroups: 0,
			warnings: [],
		});
	});

	it("summarizes trace proof freshness against the review SLO", () => {
		const coverage = buildTraceFreshnessCoverage([
			{
				endedAt: "2026-06-10T12:00:00.000Z",
				traceEvidence: markMcpTraceEvidence(
					buildTraceEvidenceSummary("trace-a", []),
					2,
				),
			},
			{
				endedAt: "2026-06-10T12:10:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-b", [
					{
						traceId: "trace-b",
						kind: "run.started",
						createdAt: "2026-06-10T12:12:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: {},
					},
				]),
			},
			{
				endedAt: "2026-06-10T12:20:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-c", [
					{
						traceId: "trace-c",
						kind: "memory.retrieved",
						createdAt: "2026-06-10T12:34:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { factIds: ["fact-a"] },
					},
					{
						traceId: "trace-c",
						kind: "decision.completed",
						createdAt: "2026-06-10T12:35:00.000Z",
						runtimeBackend: "cloudflare-agents",
						payload: { citedFactIds: ["fact-a"] },
					},
				]),
			},
			{
				endedAt: "2026-06-10T12:40:00.000Z",
				traceEvidence: buildTraceEvidenceSummary("trace-d", []),
			},
		]);

		expect(coverage).toEqual({
			status: "warning",
			targetMaxLagMs: 300000,
			freshnessRate: 2 / 3,
			proofGroups: 3,
			freshGroups: 2,
			staleGroups: 1,
			missingProofTimestampGroups: 0,
			maxLagMs: 900000,
			latestAuditAt: "2026-06-10T12:20:00.000Z",
			latestProofAt: "2026-06-10T12:35:00.000Z",
			warnings: ["trace_proof_stale"],
		});
	});

	it("marks empty trace freshness coverage as no-data", () => {
		expect(buildTraceFreshnessCoverage([])).toEqual({
			status: "no_data",
			targetMaxLagMs: 300000,
			freshnessRate: 0,
			proofGroups: 0,
			freshGroups: 0,
			staleGroups: 0,
			missingProofTimestampGroups: 0,
			maxLagMs: null,
			latestAuditAt: null,
			latestProofAt: null,
			warnings: [],
		});
	});
});

describe("codemode analytics summary", () => {
	const FROM = "2026-06-01T00:00:00.000Z";
	const TO = "2026-06-25T23:59:59.000Z";

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOrganizationIdForApp.mockResolvedValue(ORG_ID);
	});

	it("returns fallback when codemode AE config is unavailable", async () => {
		mocks.hasCodemodeAEConfig.mockReturnValue(false);
		const client = createClient(createContext());

		const result = await client.getCodemodeAnalyticsSummary({
			from: FROM,
			to: TO,
		});

		expect(mocks.queryCodemodeAnalyticsSummary).not.toHaveBeenCalled();
		expect(result).toEqual({
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
		});
	});

	it("returns codemode summary scoped to caller org", async () => {
		mocks.hasCodemodeAEConfig.mockReturnValue(true);
		const summary = {
			byNamespace: [
				{
					namespace: "gmail",
					totalCalls: 120,
					successCalls: 118,
					failedCalls: 2,
					successRate: 98.3,
					avgDurationMs: 45,
				},
			],
			topTools: [
				{
					toolName: "gmail.list_messages",
					namespace: "gmail",
					totalCalls: 80,
					successCalls: 79,
					failedCalls: 1,
					successRate: 98.8,
					avgDurationMs: 40,
					p50DurationMs: 38,
				},
			],
			execSummary: {
				totalExecs: 30,
				successExecs: 28,
				failedExecs: 2,
				successRate: 93.3,
				avgDurationMs: 1200,
				avgToolCount: 4.0,
				avgNamespaceCount: 1.5,
			},
		};
		mocks.queryCodemodeAnalyticsSummary.mockResolvedValue(summary);
		const client = createClient(createContext());

		const result = await client.getCodemodeAnalyticsSummary({
			from: FROM,
			to: TO,
		});

		expect(mocks.queryCodemodeAnalyticsSummary).toHaveBeenCalledWith(
			expect.objectContaining({ ENVIRONMENT: "test" }),
			FROM,
			TO,
			expect.objectContaining({ organizationId: ORG_ID }),
		);
		expect(result).toEqual(summary);
	});

	it("validates appId access and passes it through to the AE query", async () => {
		mocks.hasCodemodeAEConfig.mockReturnValue(true);
		mocks.queryCodemodeAnalyticsSummary.mockResolvedValue({
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
		});
		const client = createClient(createContext());

		await client.getCodemodeAnalyticsSummary({
			from: FROM,
			to: TO,
			appId: APP_ID,
		});

		expect(mocks.getOrganizationIdForApp).toHaveBeenCalledWith(
			expect.anything(),
			APP_ID,
		);
		expect(mocks.queryCodemodeAnalyticsSummary).toHaveBeenCalledWith(
			expect.anything(),
			FROM,
			TO,
			expect.objectContaining({ appId: APP_ID }),
		);
	});

	it("rejects cross-org appId reads", async () => {
		mocks.hasCodemodeAEConfig.mockReturnValue(true);
		mocks.getOrganizationIdForApp.mockResolvedValue(
			"bff22222-2222-4222-8222-222222222222",
		);
		const client = createClient(createContext());

		await expect(
			client.getCodemodeAnalyticsSummary({
				from: FROM,
				to: TO,
				appId: APP_ID,
			}),
		).rejects.toThrow("You do not have access to this app");
		expect(mocks.queryCodemodeAnalyticsSummary).not.toHaveBeenCalled();
	});

	it("returns fallback and logs on AE query error", async () => {
		mocks.hasCodemodeAEConfig.mockReturnValue(true);
		mocks.queryCodemodeAnalyticsSummary.mockRejectedValue(
			new Error("AE SQL API error (500): internal"),
		);
		const consoleSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		const client = createClient(createContext());

		const result = await client.getCodemodeAnalyticsSummary({
			from: FROM,
			to: TO,
		});

		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("[Analytics] Codemode AE query failed:"),
			expect.any(Error),
		);
		expect(result.byNamespace).toEqual([]);
		consoleSpy.mockRestore();
	});
});

describe("external-agent validation SLO", () => {
	const FROM = "2026-08-21T00:00:00.000Z";
	const TO = "2026-08-21T23:59:59.000Z";

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.hasAEConfig.mockReturnValue(true);
	});

	it("queries Analytics Engine with only the caller organization", async () => {
		const expected = {
			from: FROM,
			to: TO,
			status: "healthy" as const,
			configured: true,
			hasData: true,
			latestValidationAt: "2026-08-21T23:58:00.000Z",
			freshnessLagMs: 119_000,
			totalValidations: 5,
			successfulValidations: 4,
			inactiveValidations: 1,
			unavailableValidations: 0,
			availabilityPercent: 100,
			avgLatencyMs: 201,
		};
		mocks.getExternalAgentValidationSloFromAE.mockResolvedValue(expected);
		const context = createContext();

		await expect(
			createClient(context).getExternalAgentValidationSlo({
				from: FROM,
				to: TO,
			}),
		).resolves.toEqual(expected);
		expect(mocks.getExternalAgentValidationSloFromAE).toHaveBeenCalledWith(
			context.env,
			ORG_ID,
			FROM,
			TO,
		);
	});

	it("distinguishes an unavailable query from a valid empty window", async () => {
		mocks.getExternalAgentValidationSloFromAE.mockRejectedValue(
			new Error("provider detail must not escape"),
		);
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			createClient(createContext()).getExternalAgentValidationSlo({
				from: FROM,
				to: TO,
			}),
		).resolves.toEqual({
			from: FROM,
			to: TO,
			status: "query_unavailable",
			configured: true,
			hasData: false,
			latestValidationAt: null,
			freshnessLagMs: null,
			totalValidations: 0,
			successfulValidations: 0,
			inactiveValidations: 0,
			unavailableValidations: 0,
			availabilityPercent: 0,
			avgLatencyMs: 0,
		});
		consoleSpy.mockRestore();
	});

	it("reports an unconfigured Analytics Engine binding explicitly", async () => {
		mocks.hasAEConfig.mockReturnValue(false);

		await expect(
			createClient(createContext()).getExternalAgentValidationSlo({
				from: FROM,
				to: TO,
			}),
		).resolves.toMatchObject({
			status: "unconfigured",
			configured: false,
			hasData: false,
			latestValidationAt: null,
			freshnessLagMs: null,
		});
		expect(mocks.getExternalAgentValidationSloFromAE).not.toHaveBeenCalled();
	});

	it("rejects authenticated callers without organization scope", async () => {
		const context = createContext();
		context.organizationId = undefined;

		await expect(
			createClient(context).getExternalAgentValidationSlo({
				from: FROM,
				to: TO,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.getExternalAgentValidationSloFromAE).not.toHaveBeenCalled();
	});
});

describe("widget lifecycle telemetry", () => {
	it("passes profile filters to the provider-scoped activity query", async () => {
		mocks.listEmbeddedProviderActivity.mockResolvedValue([]);
		const installationId = "33333333-3333-4333-8333-333333333333";
		await createClient(createContext()).getEmbeddedProviderActivity({
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-09-02T00:00:00.000Z",
			installationId,
			hostUserId: "6190",
			limit: 50,
		});
		expect(mocks.listEmbeddedProviderActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				installationId,
				hostUserId: "6190",
				limit: 1000,
			}),
		);
	});
	it("projects signed provider activity into tenant and user summaries", async () => {
		mocks.listEmbeddedProviderActivity.mockResolvedValue([
			{
				id: "event-2",
				installationId: "33333333-3333-4333-8333-333333333333",
				externalTenantId: "1",
				hostUserId: "6190",
				hostUserLabel: null,
				hostRole: null,
				sessionId: "embed:two",
				eventType: "attention_still_open",
				createdAt: "2026-09-01 12:01:00",
			},
			{
				id: "event-1",
				installationId: "33333333-3333-4333-8333-333333333333",
				externalTenantId: "1",
				hostUserId: "6190",
				hostUserLabel: "Owner",
				hostRole: "owner",
				sessionId: "embed:one",
				eventType: "embedded_session_started",
				createdAt: "2026-09-01 12:00:00",
			},
		]);
		const result = await createClient(
			createContext(),
		).getEmbeddedProviderActivity({
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-09-01T23:59:59.000Z",
			limit: 50,
		});
		expect(result).toMatchObject({
			tenants: [{ externalTenantId: "1", activeUsers: 1, sessions: 2 }],
			users: [
				{
					hostUserId: "6190",
					hostUserLabel: "Owner",
					hostRole: "owner",
					sessions: 2,
					events: 2,
				},
			],
		});
		expect(result.recent).toContainEqual(
			expect.objectContaining({ eventType: "attention_still_open" }),
		);
		expect(mocks.listEmbeddedProviderActivity).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ providerOrganizationId: ORG_ID }),
		);
	});

	it("stamps the authenticated organization and writes only bounded fields", async () => {
		const writeDataPoint = vi.fn();
		const context = createContext();
		context.env = {
			...context.env,
			GIT_SHA: "deadbeef",
			WIDGET_ANALYTICS: { writeDataPoint },
		} as unknown as CloudflareEnv;

		await expect(
			createClient(context).trackWidgetLifecycle({
				events: [
					{
						event: "performance",
						phase: "session",
						outcome: "failed",
						durationMs: 321,
					},
				],
			}),
		).resolves.toEqual({ accepted: 1 });
		expect(writeDataPoint).toHaveBeenCalledWith({
			blobs: [
				"performance",
				"session",
				"failed",
				ORG_ID,
				"deadbeef",
				"",
				"",
				"",
			],
			doubles: [321],
			indexes: [ORG_ID],
		});
	});

	it("records content-free native turn milestones", async () => {
		const writeDataPoint = vi.fn();
		const context = createContext();
		context.env = {
			...context.env,
			GIT_SHA: "deadbeef",
			WIDGET_ANALYTICS: { writeDataPoint },
		} as unknown as CloudflareEnv;

		await expect(
			createClient(context).trackWidgetLifecycle({
				events: [
					{
						event: "client_turn_milestone",
						eventId: "aff11111-1111-4111-8111-111111111111",
						surface: "native_os",
						milestone: "first_text",
						conversationId: "conversation-1",
						runId: "run-0001",
						traceId: "run-0001",
						durationMs: 420,
					},
				],
			}),
		).resolves.toEqual({ accepted: 1 });
		expect(writeDataPoint).toHaveBeenCalledWith({
			blobs: [
				"client_turn_milestone",
				"",
				"",
				ORG_ID,
				"deadbeef",
				"",
				"native_os",
				"first_text",
			],
			doubles: [420],
			indexes: [ORG_ID],
		});
	});

	it("rejects transcript-shaped lifecycle payloads", async () => {
		await expect(
			createClient(createContext()).trackWidgetLifecycle({
				events: [
					{
						event: "ready",
						transcript: "must never cross this boundary",
					} as never,
				],
			}),
		).rejects.toBeDefined();
	});
});

describe("verified provider lifecycle collection", () => {
	const installationId = "33333333-3333-4333-8333-333333333333";
	function fixture() {
		const context = createContext();
		context.user = undefined;
		context.authType = undefined;
		context.headers = new Headers({
			"X-Service-Binding": "true",
			"X-Tedix-Org-Id": ORG_ID,
			"X-Tedix-Tedi-Id": APP_ID,
		});
		const writeDataPoint = vi.fn();
		context.env = {
			...context.env,
			WIDGET_ANALYTICS: { writeDataPoint },
		} as unknown as CloudflareEnv;
		mocks.resolveActiveProviderInstallationForOutcome.mockResolvedValue({
			id: installationId,
			providerOrganizationId: "provider",
			allowedOrigin: "https://host.example",
		});
		mocks.getOrganizationById.mockResolvedValue({
			metadata: { tediWidget: { analyticsEnabled: true } },
		});
		const input = {
			installationId,
			providerAppId: APP_ID,
			externalTenantId: "8042",
			allowedOrigin: "https://host.example",
			events: [
				{
					eventId: crypto.randomUUID(),
					milestone: "submitted" as const,
					durationMs: 12,
				},
			],
		};
		return { client: createClient(context), context, writeDataPoint, input };
	}
	it("maps canonical counters and stamps provider, installation and origin from authority", async () => {
		const f = fixture();
		const events = [
			{ milestone: "submitted", durationMs: 0 },
			{ milestone: "first_text", durationMs: 120 },
			{ milestone: "terminal_received", durationMs: 200, outcome: "succeeded" },
			{ milestone: "rendered", durationMs: 210, outcome: "succeeded" },
			{ milestone: "failed", durationMs: 100, outcome: "cancelled" },
			{ milestone: "failed", durationMs: 100, outcome: "failed" },
			{ milestone: "ready", durationMs: 30 },
			{ milestone: "session", durationMs: 50 },
		].map((e) => ({ ...e, eventId: crypto.randomUUID() }));
		await f.client.trackEmbeddedWidgetLifecycle({
			...f.input,
			events: events as typeof f.input.events,
		});
		expect(f.writeDataPoint.mock.calls.map(([p]) => p.blobs[0])).toEqual([
			"message_submitted",
			"first_token",
			"client_turn_milestone",
			"answer_completed",
			"answer_cancelled",
			"answer_failed",
			"performance",
			"performance",
		]);
		for (const [point] of f.writeDataPoint.mock.calls) {
			expect(point.indexes).toEqual(["provider"]);
			expect(point.blobs.slice(8)).toEqual([
				installationId,
				"https://host.example",
			]);
			expect(point.blobs).not.toContain(ORG_ID);
		}
		expect(
			mocks.resolveActiveProviderInstallationForOutcome,
		).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				customerOrganizationId: ORG_ID,
				primaryTediId: APP_ID,
				installationId,
				allowedOrigin: "https://host.example",
			}),
		);
	});
	it("checks current opt-in for every batch and rejects foreign authority", async () => {
		const f = fixture();
		mocks.getOrganizationById.mockResolvedValue({
			metadata: { tediWidget: { analyticsEnabled: false } },
		});
		await expect(
			f.client.trackEmbeddedWidgetLifecycle(f.input),
		).resolves.toEqual({ accepted: 0 });
		expect(f.writeDataPoint).not.toHaveBeenCalled();
		mocks.resolveActiveProviderInstallationForOutcome.mockResolvedValue(
			undefined,
		);
		await expect(
			f.client.trackEmbeddedWidgetLifecycle(f.input),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
	it("rejects a user attempting to submit signed installation measurements", async () => {
		const f = fixture();
		await expect(
			createClient(createContext()).trackEmbeddedWidgetLifecycle(f.input),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});
});
