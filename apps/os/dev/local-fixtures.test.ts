import {
	AgentsConfigSchema,
	OfficeConfigSchema,
} from "@tedix/api-contract/schemas/os-session-apps";
import { OutboundReviewConfigSchema } from "@tedix/api-contract/schemas/os-outbound-review";
import { DEFAULT_ATTENTION_LAYOUT } from "@tedix/api-contract/schemas/attention-layout";
// @vitest-environment node
import { apiContract } from "@tedix/api-contract/contracts/api";
import { dynamicSkillDefinitionId } from "@tedix/api-contract/constants/workflow-definition-keys";
import type { OsGadgetExecution } from "@tedix/api-contract/schemas/os-workspaces";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	handleLocalRpc,
	LOCAL_FIXTURE_IDS as IDS,
	LOCAL_RPC_PROCEDURES,
	LOCAL_WIDGET_RESOURCE_URI,
	resetLocalFixtures,
} from "./local-fixtures";
import { localWidgetResource } from "./local-api-plugin";
import { uid } from "./demo-pack";
import opportunityCardsApp from "./demo-pack/opportunity-cards-app.json";
import opportunityCardsManifest from "./demo-pack/opportunity-cards-manifest.json";

// ---------------------------------------------------------------------------
// Contract access (drift-proof core): every handler's success payload must
// parse through the REAL contract output schema resolved from apiContract.
// ---------------------------------------------------------------------------

type StandardSchema = {
	"~standard": {
		validate: (
			value: unknown,
		) =>
			| { issues?: readonly unknown[]; value?: unknown }
			| Promise<{ issues?: readonly unknown[]; value?: unknown }>;
	};
};

describe("local widget fixture", () => {
	it("serves the renderable Revenue Dashboard only for its exact app and URI", () => {
		const payload = localWidgetResource(
			"tedix-local",
			LOCAL_WIDGET_RESOURCE_URI,
		);
		expect(payload).toMatchObject({
			contents: [
				{
					uri: LOCAL_WIDGET_RESOURCE_URI,
					mimeType: "text/html;profile=mcp-app",
				},
			],
		});
		expect(
			localWidgetResource("other-app", LOCAL_WIDGET_RESOURCE_URI),
		).toBeNull();
		expect(localWidgetResource("tedix-local", "ui://widgets/nope")).toBeNull();
	});
});

function contractNode(key: string): unknown {
	let node: unknown = apiContract;
	for (const segment of key.split("/")) {
		node = (node as Record<string, unknown>)[segment];
		if (node === undefined) throw new Error(`No contract node for ${key}`);
	}
	return node;
}

/**
 * The INPUT schema a procedure validates server-side.
 *
 * Output-only checking let a call ship that the real API rejects outright: a
 * `limit` above the shared pagination cap 400s in production while the fixture
 * lane — which never validates input — answered happily, so the surface it fed
 * was silently dead. Every fixture call now proves its arguments would be
 * ACCEPTED, not just that the reply has the right shape.
 */
function contractInputSchemas(key: string): StandardSchema[] {
	const def = (
		contractNode(key) as { "~orpc": { inputSchemas?: StandardSchema[] } }
	)["~orpc"];
	return def.inputSchemas ?? [];
}

async function expectInputAcceptedByContract(
	key: string,
	input: unknown,
): Promise<void> {
	let value = input;
	for (const schema of contractInputSchemas(key)) {
		const result = await schema["~standard"].validate(value);
		if (result.issues && result.issues.length > 0) {
			throw new Error(
				`${key} INPUT would be rejected by the real API:\n${JSON.stringify(result.issues.slice(0, 5), null, 2)}`,
			);
		}
		value = result.value;
	}
}

function contractOutputSchemas(key: string): StandardSchema[] {
	let node: unknown = apiContract;
	for (const segment of key.split("/")) {
		node = (node as Record<string, unknown>)[segment];
		if (node === undefined) throw new Error(`No contract node for ${key}`);
	}
	const def = (node as { "~orpc": { outputSchemas?: StandardSchema[] } })[
		"~orpc"
	];
	return def.outputSchemas ?? [];
}

async function expectParsesAgainstContract(
	key: string,
	output: unknown,
): Promise<void> {
	const schemas = contractOutputSchemas(key);
	expect(
		schemas.length,
		`${key} declares no contract output schema`,
	).toBeGreaterThan(0);
	let value = output;
	for (const schema of schemas) {
		const result = await schema["~standard"].validate(value);
		if (result.issues && result.issues.length > 0) {
			throw new Error(
				`${key} output failed its contract schema:\n${JSON.stringify(result.issues.slice(0, 5), null, 2)}`,
			);
		}
		value = result.value;
	}
}

function callLocal(
	key: string,
	input?: unknown,
): { status: number; body: unknown } {
	const envelope = input === undefined ? undefined : { json: input };
	const result = handleLocalRpc(`/api/rpc/${key}`, "POST", envelope);
	if (result === null) throw new Error(`Unhandled local procedure: ${key}`);
	return result;
}

function callLocalOk(key: string, input?: unknown): unknown {
	const result = callLocal(key, input);
	expect(result.status, `${key} returned ${result.status}`).toBe(200);
	return (result.body as { json: unknown }).json;
}

// ---------------------------------------------------------------------------
// One representative success call per covered procedure
// ---------------------------------------------------------------------------

const blankDefinition = {
	gadgets: [],
	layout: null,
	skills: [],
	connections: [],
	policyRequirements: [],
};

const portableBlueprintExport = {
	envelopeVersion: 1 as const,
	exportedAt: "2026-08-17T20:00:00.000Z",
	exportedByKind: "user" as const,
	source: {
		organizationId: IDS.orgId,
		organizationName: "Tedix local",
		blueprintId: IDS.blueprintPublished,
		blueprintName: "Revenue Ops Starter",
		revisionId: "00000051-0000-4000-8000-000000000001",
		revision: 1,
		definitionSha256: "a".repeat(64),
		forkedAt: "2026-08-17T20:00:00.000Z",
		via: "export" as const,
		attested: true,
	},
	blueprint: {
		name: "Revenue Ops Starter",
		description: "Workspace template for weekly revenue reporting",
		status: "published" as const,
	},
	revision: {
		revision: 1,
		createdAt: "2026-08-10T09:00:00.000Z",
		publishedAt: "2026-08-10T13:00:00.000Z",
		createdByKind: "user" as const,
	},
	definition: { gadgets: [], requirements: null },
	lineage: null,
};

const CALLS = {
	"decisionGraph/getContext": {
		cardId: "d5000000-0000-4000-8000-000000000001",
		maxHops: 4,
	},
	"attention/listDeckCards": {},
	"workInteractions/outbound/list": { limit: 50 },
	"workInteractions/outbound/get": {
		workItemId: "00000090-0000-4000-8000-000000000001",
	},
	"workInteractions/outbound/accounts": {},
	"workInteractions/outbound/policy": {},
	"workInteractions/outbound/profile": {},
	"members/listMembers": { organizationId: IDS.orgId, limit: 25, offset: 0 },
	"tedis/list": { limit: 50, offset: 0 },
	"tedis/get": { tediId: IDS.tediMiles },
	"tedis/getSetup": { tediId: IDS.tediMiles },
	"tedis/listOperationsSummaries": undefined,
	"tediUsage/getCallCosts": { tediId: IDS.tediMiles, period: "7d" },
	"skills/listByOrg": { limit: 100, offset: 0, summary: true },
	"skills/get": { id: IDS.skillRevenue },
	"skills/getWorkflowReliability": { skillId: IDS.skillRevenue },
	"skills/listWorkflowSchedules": { limit: 100 },
	"skills/runWorkflowHistory": { limit: 50 },
	"skills/listWorkflowRetryCandidates": {},
	"skills/inspectWorkflowRun": { runId: IDS.skillRunFailed },
	"skills/listRunArtifacts": { runId: IDS.skillRunCompleted },
	"skills/restartWorkflow": {
		runId: IDS.skillRunFailed,
		restartId: "restart-test-epoch-0",
		confirmDestructive: true,
		reason: "unit test",
	},
	"skills/runWorkflowCancel": {
		runId: IDS.skillRunCompleted,
		confirmDestructive: true,
		reason: "unit test",
	},
	"skills/approveWorkflow": {
		runId: IDS.skillRunCompleted,
		approvalId: "approval-1",
		confirmDestructive: true,
		reason: "unit test",
	},
	"skills/rejectWorkflow": {
		runId: IDS.skillRunCompleted,
		approvalId: "approval-1",
		confirmDestructive: true,
	},
	"runtimeEntitlements/get": {},
	"osCompute/posture": { window: "7d" },
	"workflows/listDefinitions": { limit: 50, offset: 0 },
	"workflows/listDefinitionHealth": { limit: 50, offset: 0 },
	"memoryGraph/health": undefined,
	"memoryGraph/healthFindings": undefined,
	"memoryGraph/browse": { view: "observations", limit: 20, offset: 0 },
	"memoryGraph/listDomains": undefined,
	"memoryGraph/optimize/backlog": { type: "curiosity", limit: 100 },
	"memoryGraph/expertise": { tediId: IDS.tediMiles },
	"memoryGraph/graph/visualization": {
		view: "knowledge_map",
		tediId: IDS.tediMiles,
		depth: 2,
		maxNodes: 60,
	},
	"rationaleRecords/list": { limit: 50 },
	"cognitiveRuntime/listEvents": {
		tediId: IDS.tediMiles,
		kind: "tool.completed",
		limit: 200,
	},
	"earnedDelegation/getProfile": { tediId: IDS.tediMiles },
	"growthSnapshots/latest": { tediId: IDS.tediMiles },
	"knowledge/list": { limit: 100 },
	"audit/search": { limit: 100 },
	"workItems/list": { limit: 50 },
	"workItems/listCases": {},
	"workItems/listResourcePools": {},
	"workItems/listBudgetEnvelopes": {},
	"workItems/getById": { id: "00000070-0000-4000-8000-000000000001" },
	"workItems/getReadiness": { id: "00000070-0000-4000-8000-000000000001" },
	"workItems/listAttempts": { id: "00000070-0000-4000-8000-000000000001" },
	"workItems/listEvidence": { id: "00000070-0000-4000-8000-000000000001" },
	"workItems/listEvents": { id: "00000070-0000-4000-8000-000000000001" },
	"workItems/listReadinessProjection": { limit: 25 },
	"workItems/listAttemptProjection": {
		projectId: "00000076-0000-4000-8000-000000000001",
		runtimeStates: ["queued", "running", "waiting", "retrying"],
		limit: 100,
	},
	"workAgentSessions/list": {},
	"workAgentSessions/listRequests": { limit: 200 },
	"workAgentSessions/attention": {},
	"workAgentSessions/getAttentionLayout": {},
	"workAgentSessions/updateAttentionLayout": {
		layout: DEFAULT_ATTENTION_LAYOUT,
		expectedRevision: 0,
	},
	"workAgentSessions/visitAttention": {},
	"workAgentSessions/contributors": {
		projectId: "00000076-0000-4000-8000-000000000001",
	},
	"workInteractions/listInbox": { limit: 100 },
	"workInteractions/snooze": {
		requestId: "000000a7-0000-4000-8000-000000000001",
		expectedVersion: 1,
		until: "2099-10-27T09:00:00.000Z",
	},
	"workInteractions/refreshDecisionSources": {},
	"workInteractions/get": { requestId: "000000a7-0000-4000-8000-000000000001" },
	"agentTurnTriage/getReplyDraftAcceptance": {
		since: "2026-10-08T00:00:00.000Z",
	},
	"agentTurnTriage/getCaptureHealth": { since: "2026-10-08T00:00:00.000Z" },
	"agentTurnTriage/getReplyDraftLeaderboard": {
		since: "2026-10-05T00:00:00.000Z",
		todaySince: "2026-10-08T00:00:00.000Z",
	},
	"agentTurnTriage/listLessons": { limit: 50 },
	"support/mine": { limit: 50 },
	"projects/list": { limit: 100 },
	"projects/get": { id: "00000076-0000-4000-8000-000000000001" },
	// Writes the target date the fixture already holds, so state is unchanged.
	"projects/update": {
		id: "00000076-0000-4000-8000-000000000001",
		targetDate: "2026-11-30",
	},
	"workItems/getCase": { caseId: "000000b1-0000-4000-8000-000000000001" },
	"workItems/attachCaseWorkItem": {
		caseId: "000000b1-0000-4000-8000-000000000001",
		workItemId: "00000070-0000-4000-8000-000000000001",
	},
	"workItems/addCaseDependency": {
		fromCaseId: "000000b1-0000-4000-8000-000000000001",
		toCaseId: "000000b1-0000-4000-8000-000000000002",
	},
	"projects/getRollup": { id: "00000076-0000-4000-8000-000000000001" },
	"projects/getPortfolio": {},
	"projects/getFactoryScoreboard": {},
	"projects/listMilestones": { id: "00000076-0000-4000-8000-000000000001" },
	"projects/listSprints": { id: "00000076-0000-4000-8000-000000000001" },
	"projects/listHealthJudgments": {
		id: "00000076-0000-4000-8000-000000000001",
	},
	"workItems/listRelations": { limit: 500 },
	"workItems/getOrgGraphHealth": { limit: 20 },
	"workItems/getWorkGraphHealth": {
		idleThresholdDays: 14,
		dupThreshold: 0.85,
		scanCap: 500,
	},
	"organizationPurpose/getOwnerBrief": { outcomeWindowDays: 7 },
	"tediApprovals/list": { status: "pending", limit: 50 },
	"osApprovalRules/list": {},
	"osApprovalRules/setEnabled": {
		ruleId: "000000e1-0000-4000-8000-000000000001",
		enabled: false,
	},
	"osApprovalRules/delete": { ruleId: "000000e1-0000-4000-8000-000000000001" },
	"tediApprovals/getById": { id: IDS.approvalPending },
	"tediApprovals/resolve": { id: IDS.approvalPending, status: "approved" },
	"tediApprovals/clearExpired": {},
	"webPush/getStatus": {},
	"webPush/subscribe": {
		endpoint: "https://web.push.apple.com/fixture",
		keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
	},
	"webPush/unsubscribe": { endpoint: "https://web.push.apple.com/fixture" },
	"webPush/setVisibility": {
		clientId: "00000000-0000-4000-8000-000000000001",
		conversationId: "fixture-chat",
	},
	"webPush/setPreferences": {
		mutedProjectIds: [],
		mutedWorkspaceIds: [],
	},
	"userSettings/getPreferences": {},
	"userSettings/updatePreferences": {
		preferences: {
			theme: "dark",
			density: "compact",
			locale: "es-MX",
			timezone: "America/Mexico_City",
			accessibility: { motion: "reduced", contrast: "high" },
			notifications: {
				approvals: true,
				runFailures: false,
				budgetAlerts: true,
			},
			conversationModelRef: "azure-openai/gpt-5.6-terra",
		},
		expectedRevision: 0,
	},
	"userSettings/getContext": {},
	"userSettings/getBrowserMcpAuthorization": {},
	"organizations/listAllMine": {},
	"organizations/getMyOrganization": {},
	"modelCatalog/list": {},
	"externalAgentIdentity/listPrincipals": { organizationId: IDS.orgId },
	"organizations/get": { organizationId: IDS.orgId },
	"organizations/getFeatures": { organizationId: IDS.orgId },
	"organizations/listInboundClientInventory": { organizationId: IDS.orgId },
	"organizations/update": {
		organizationId: IDS.orgId,
		name: "Solstice Coffee Company",
		slug: "solstice",
		description: "Updated in a unit test",
		metadata: {
			website: "https://solstice.example",
			contactEmail: "hello@solstice.example",
		},
	},
	"billing/listPlans": undefined,
	"billing/listProviderCapacitySponsorships": undefined,
	"billing/getInferenceSpending": { limit: 100 },
	"billing/getOverview": undefined,
	"orgUsage/getOrgUsage": { organizationId: IDS.orgId, period: "30d" },
	"mcpPayments/listEvents": { limit: 100 },
	"mcpPayments/getReceipt": { id: IDS.paymentReceipt },
	"mcpPayments/spendSummary": { lastHours: 24, limit: 50 },
	"mcpPayments/listPolicies": { limit: 100 },
	"organizations/listApiKeys": {
		organizationId: IDS.orgId,
		limit: 25,
		offset: 0,
	},
	"organizations/getExpiringKeys": {
		organizationId: IDS.orgId,
		withinDays: 30,
	},
	"connections/getUserConnections": {},
	"connections/getConnectionsOverview": { scope: "organization" },
	"connections/listProviders": {},
	"connections/setProviderAccountMode": {
		appId: "github",
		accountMode: "single",
	},
	"connections/stageConnectTicket": { appId: "github", scope: "user" },
	// Redeems the ticket the stage call above issues after a reset.
	"connections/redeemConnectTicket": { ticket: "fixture-connect-ticket-1" },
	"catalog/list": { limit: 30, offset: 0 },
	"catalog/getCategories": {},
	"catalog/getBySlug": { slug: "local-documents" },
	"apps/list": { limit: 50 },
	"apps/listComposerCommands": {},
	"apps/update": {
		appId: "00000080-0000-4000-8000-000000000004",
		metadata: { mcpConfig: { aggregateTedis: [{ slug: "nova" }] } },
	},
	"apps/getByIdWithTools": { appId: IDS.appStorefront },
	"apps/getGatewayMembership": { appId: IDS.appStorefront },
	"apps/listGatewayMemberships": undefined,
	"appTools/list": { appId: IDS.appStorefront },
	"appSecrets/list": { appId: IDS.appStorefront },
	"tediAppAssignments/listByApp": { appId: IDS.appStorefront },
	"tediAppAssignments/listByTedi": { tediId: IDS.tediMiles },
	"appAdapters/list": { appId: IDS.appStorefront },
	"content/listSources": { appId: IDS.appStorefront },
	"analytics/getMetrics": {
		appId: IDS.appStorefront,
		from: "2026-08-01T00:00:00.000Z",
		to: "2026-08-31T00:00:00.000Z",
	},
	...Object.fromEntries(
		[
			"getAppSummary",
			"getAppToolBreakdown",
			"getAppTimeSeries",
			"getRecentExecutions",
			"getAppFreshness",
			"getCodemodeAnalyticsSummary",
			"getWidgetLifecycleHealth",
		].map((procedure) => [
			`analytics/${procedure}`,
			{
				appId: IDS.appStorefront,
				from: "2026-08-01T00:00:00.000Z",
				to: "2026-08-31T00:00:00.000Z",
			},
		]),
	),
	"analytics/getRecentActivity": { appId: IDS.appStorefront },
	"analytics/getHumanActivityReview": { appId: IDS.appStorefront, limit: 20 },
	"appGating/installedEligibility": undefined,
	"osWorkspaces/workspaces/list": { status: "active", limit: 50 },
	"osWorkspaces/workspaces/create": { name: "Test Workspace" },
	"osWorkspaces/workspaces/createFromConversation": {
		conversationId: IDS.conversationHome,
		name: "Orion planning",
	},
	"osWorkspaces/workspaces/get": { workspaceId: IDS.workspaceRevenue },
	"osCollaborators/access": { workspaceId: IDS.workspaceRevenue },
	"osCollaborators/list": { workspaceId: IDS.workspaceRevenue },
	"osCollaborators/add": {
		workspaceId: IDS.workspaceRevenue,
		email: "kai@example.test",
		role: "use",
	},
	"osCollaborators/createLink": {
		workspaceId: IDS.workspaceRevenue,
		role: "use",
	},
	"osShares/shares/list": {
		resourceType: "output",
		resourceId: IDS.outputDocument,
	},
	"osShares/shares/create": {
		resourceType: "output",
		resourceId: IDS.outputDocument,
		role: "viewer",
		revisionMode: "living",
		note: "For the team to review",
	},
	"osShares/shares/previewRevoke": {
		shareId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
	},
	"osShares/shares/revoke": {
		shareId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
	},
	"osCollaborators/copyLink": {
		workspaceId: IDS.workspaceRevenue,
		linkId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	},
	"osCollaborators/previewRemove": {
		workspaceId: IDS.workspaceRevenue,
		target: { kind: "user", userId: "local-kai@example.test" },
	},
	"osCollaborators/remove": {
		workspaceId: IDS.workspaceRevenue,
		target: { kind: "user", userId: "local-kai@example.test" },
		keepUserIds: [],
	},
	"osCollaborators/open": { workspaceId: IDS.workspaceRevenue },
	"osCollaborators/listShared": {},
	"osCollaborators/dismissShared": { workspaceId: IDS.workspaceRevenue },
	"osWorkspaces/workspaces/update": {
		workspaceId: IDS.workspaceRevenue,
		name: "Revenue Operations",
	},
	"osWorkspaces/workspaces/archive": { workspaceId: IDS.workspaceRevenue },
	"osWorkspaces/workspaces/restore": { workspaceId: IDS.workspaceRevenue },
	"osWorkspaces/workspacePreferences/list": {},
	"osWorkspaces/workspacePreferences/setFavorite": {
		workspaceId: IDS.workspaceRevenue,
		favorite: true,
	},
	"osWorkspaces/workspacePreferences/touch": {
		workspaceId: IDS.workspaceRevenue,
	},
	"osWorkspaces/resources/list": {
		workspaceId: IDS.workspaceRevenue,
		status: "active",
		limit: 100,
	},
	"osWorkspaces/resources/create": {
		workspaceId: IDS.workspaceRevenue,
		selection: {
			providerId: "github",
			connectionScope: "tenant",
			requiredScopes: ["repo:read"],
			resourceType: "repository",
			providerResourceId: "tedix-hq/example",
			name: "Example repository",
			metadata: {},
		},
	},
	"osWorkspaces/resources/get": {
		workspaceId: IDS.workspaceRevenue,
		resourceId: "00000030-0000-4000-8000-000000000003",
	},
	"osWorkspaces/resources/rename": {
		workspaceId: IDS.workspaceRevenue,
		resourceId: "00000030-0000-4000-8000-000000000003",
		name: "Renamed repository",
		expectedUpdatedAt: "2026-08-12T08:30:00.000Z",
	},
	"osWorkspaces/resources/remove": {
		workspaceId: IDS.workspaceRevenue,
		resourceId: "00000030-0000-4000-8000-000000000003",
		expectedUpdatedAt: "2026-08-12T08:30:00.000Z",
	},
	"osWorkspaces/schedules/list": { workspaceId: IDS.workspaceRevenue },
	"osWorkspaces/schedules/allowPersonalRead": {
		workspaceId: IDS.workspaceRevenue,
		resourceId: "00000034-0000-4000-8000-000000000002",
	},
	"osWorkspaces/schedules/link": {
		workspaceId: IDS.workspaceRevenue,
		skillId: "00000020-0000-4000-8000-000000000002",
	},
	"osWorkspaces/schedules/unlink": {
		workspaceId: IDS.workspaceRevenue,
		skillId: "00000020-0000-4000-8000-000000000002",
	},
	"osWorkspaces/schedules/linkFactorySkills": {
		workspaceId: IDS.workspaceRevenue,
		dryRun: true,
	},
	"osWorkspaces/gadgets/installWorkDefaults": {},
	"osWorkspaces/gadgets/workApps": { limit: 100 },
	"osWorkspaces/gadgets/list": { workspaceId: IDS.workspaceRevenue, limit: 50 },
	"osWorkspaces/gadgets/create": {
		workspaceId: IDS.workspaceRevenue,
		name: "New Gadget",
	},
	"osWorkspaces/gadgets/get": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
	},
	"osWorkspaces/gadgets/revise": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
		manifest: {
			capabilities: ["outputs.read"],
			entry: "gadgets/next/index.html",
		},
		expectedRevision: 1,
	},
	"osAppRuntime/open": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
	},
	"osAppRuntime/client": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
	},
	"osAppRuntime/readOutput": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
		session: `fixture-only:${uid(49, 14)}:${uid(50, 14)}`,
		slot: "opportunities",
	},
	"osAppRuntime/draft": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
		proposalId: uid(51, 14),
	},
	"osAppRuntime/proposeEdit": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
		conversationId: "demo-chat-opportunity-cards",
		expectedRevisionId: uid(50, 14),
		edits: [
			{
				path: "client.js",
				before: "${cards.length} opportunities for ${reviewer}",
				after: "${cards.length} opportunities · ${reviewer}",
			},
		],
	},
	// Saves Code edits onto the open chat draft of the seeded app.
	"osAppRuntime/saveDraft": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
		expectedRevisionId: uid(50, 14),
		proposalId: uid(51, 14),
		expectedSequence: 1,
		content: {
			manifest: opportunityCardsManifest,
			files: {
				...opportunityCardsApp,
				"client.js": opportunityCardsApp["client.js"].replace(
					"${cards.length} opportunities for ${reviewer}",
					"${cards.length} opportunities · ${reviewer}",
				),
			},
		},
	},
	"osAppRuntime/mergeDraft": {
		workspaceId: uid(48, 1),
		gadgetId: uid(49, 14),
		proposalId: uid(51, 14),
		expectedSequence: 1,
	},
	"osWorkspaces/gadgets/getCode": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
	},
	"osWorkspaces/gadgets/archive": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
	},
	"osWorkspaces/gadgets/rename": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
		name: "Revenue overview",
	},
	"osWorkspaces/gadgets/run": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
		tediId: IDS.tediMiles,
		input: { range: "this_week" },
		idempotencyKey: "local-gadget-run-contract",
	},
	"osWorkspaces/executions/list": {
		workspaceId: IDS.workspaceRevenue,
		gadgetId: IDS.gadgetDashboard,
		limit: 50,
	},
	"osWorkspaces/outputs/list": { limit: 50 },
	"osWorkspaces/outputs/library": { status: "active", limit: 50 },
	"osWorkspaces/outputs/create": {
		kind: "document",
		title: "Created Doc",
		content: IDS.documentContent,
	},
	"osWorkspaces/outputs/get": { outputId: IDS.outputDocument },
	"osWorkspaces/outputs/rename": {
		outputId: IDS.outputDocument,
		title: "Renamed fixture document",
	},
	"osWorkspaces/outputs/move": {
		outputId: IDS.outputDocument,
		workspaceId: IDS.workspaceRevenue,
	},
	"osWorkspaces/outputs/revise": {
		outputId: IDS.outputDocument,
		content: IDS.documentContent,
		expectedRevision: 1,
		note: "unit test edit",
	},
	"osWorkspaces/outputs/setSheetRange": {
		outputId: IDS.outputSheet,
		startRow: 0,
		startColumn: 3,
		cells: [["Checked"]],
		expectedRevision: 1,
	},
	"osWorkspaces/outputs/export": { outputId: IDS.outputSheet, format: "pdf" },
	"osWorkspaces/outputs/archive": { outputId: IDS.outputDeck },
	"osWorkspaces/collaboration/list": {
		workspaceId: IDS.workspaceRevenue,
		limit: 20,
	},
	"osWorkspaces/collaboration/get": {
		proposalId: IDS.collaborationProposalOpen,
	},
	"osWorkspaces/collaboration/create": {
		workspaceId: IDS.workspaceRevenue,
		documentType: "output",
		documentId: IDS.outputDocument,
		sourceKind: "agent_session",
		sourceId: "test-agent-session",
		content: IDS.documentContent,
	},
	"osWorkspaces/collaboration/updatePreview": {
		proposalId: IDS.collaborationProposalOpen,
		expectedSequence: 1,
		content: IDS.documentContent,
	},
	"osWorkspaces/collaboration/accept": {
		proposalId: IDS.collaborationProposalOpen,
		expectedSequence: 1,
		rationale: "Reviewed locally",
		evidenceRefs: [],
	},
	"osWorkspaces/collaboration/reject": {
		proposalId: IDS.collaborationProposalOpen,
		expectedSequence: 1,
		rationale: "Rejected locally",
		evidenceRefs: [],
	},
	"osWorkspaces/collaboration/merge": {
		proposalId: IDS.collaborationProposalAccepted,
		expectedSequence: 0,
		rationale: "Merged locally",
		evidenceRefs: ["local://test"],
	},
	"osWorkspaces/workspaces/previewBlueprintUpgrade": {
		workspaceId: IDS.workspaceSupport,
	},
	"osWorkspaces/workspaces/decideBlueprintUpgrade": {
		workspaceId: IDS.workspaceSupport,
		decision: "stay_pinned",
		candidateRevisionId: "00000051-0000-4000-8000-000000000004",
	},
	"osWorkspaces/blueprints/list": { limit: 50 },
	"osWorkspaces/blueprints/gallery": { limit: 50 },
	"osWorkspaces/blueprints/galleryPage": {
		blueprintId: IDS.blueprintPublished,
	},
	"osWorkspaces/blueprints/setFeatured": {
		blueprintId: IDS.blueprintPublished,
		featured: false,
	},
	"osWorkspaces/blueprints/create": { name: "Test Blueprint" },
	"osWorkspaces/blueprints/saveWorkspace": {
		workspaceId: IDS.workspaceRevenue,
		name: "Saved Revenue Ops",
	},
	"osWorkspaces/blueprints/get": { blueprintId: IDS.blueprintDraft },
	"osWorkspaces/blueprints/revise": {
		blueprintId: IDS.blueprintDraft,
		definition: blankDefinition,
		expectedRevision: 1,
	},
	"osWorkspaces/blueprints/publish": { blueprintId: IDS.blueprintDraft },
	"osWorkspaces/blueprints/setVisibility": {
		blueprintId: IDS.blueprintPublished,
		visibility: "catalog",
	},
	"osWorkspaces/blueprints/export": {
		blueprintId: IDS.blueprintPublished,
	},
	"osWorkspaces/blueprints/import": {
		export: portableBlueprintExport,
		name: "Imported Revenue Ops Starter",
	},
	"osWorkspaces/blueprints/instantiate": {
		blueprintId: IDS.blueprintPublished,
		workspaceName: "Instantiated Workspace",
	},
	"osWorkspaces/blueprints/instantiateFromGallery": {
		blueprintId: IDS.blueprintPublished,
		workspaceName: "Instantiated Gallery Workspace",
	},
	"osWorkspaces/work/listProjects": {
		workspaceId: IDS.workspaceRevenue,
		status: "active",
		limit: 100,
	},
	"osWorkspaces/work/attachProject": {
		workspaceId: IDS.workspaceRevenue,
		projectId: "00000076-0000-4000-8000-000000000004",
	},
	"osWorkspaces/work/removeProject": {
		workspaceId: IDS.workspaceRevenue,
		projectId: "00000076-0000-4000-8000-000000000002",
		expectedUpdatedAt: "2026-08-11T06:00:00.000Z",
	},
	"kernelRuntime/listConversations": { limit: 30 },
	"kernelRuntime/renameConversation": {
		conversationId: IDS.conversationHome,
		title: "Renamed thread",
	},
	"kernelRuntime/pinConversation": {
		conversationId: IDS.conversationHome,
		pinned: true,
	},
	"kernelRuntime/deleteConversation": { conversationId: IDS.conversationHome },
	"kernelRuntime/readMessages": {
		conversationId: IDS.conversationHome,
		limit: 60,
	},
	"kernelRuntime/readRunSet": { conversationId: IDS.conversationHome },
	"kernelRuntime/readConversationCharges": {
		conversationId: IDS.conversationHome,
	},
	"kernelRuntime/listPendingHomeDelegations": {},
	"kernelRuntime/readRun": { runId: IDS.homeRunDone },
	"kernelRuntime/readRunTrace": { runId: IDS.homeRunDelegating },
	"kernelRuntime/readChildRunEvidence": {
		delegatedTediId: IDS.tediMiles,
		childRunId: IDS.childRunDelegating,
	},
	"kernelRuntime/readRunEvents": { runId: IDS.homeRunDone, tail: 40 },
	"kernelRuntime/readConversationEvents": {
		conversationId: IDS.conversationHome,
	},
	"kernelRuntime/respondApproval": {
		runId: IDS.homeRunDone,
		decision: "approve",
	},
	"kernelRuntime/cancelRun": { runId: IDS.homeRunDone },
	"kernelRuntime/steerRun": {
		runId: IDS.homeRunDelegating,
		instruction: "Use the latest evidence",
		idempotencyKey: "fixture-steer",
	},
	"kernelRuntime/controlRunSteering": {
		runId: IDS.homeRunDelegating,
		action: "inspect",
	},
	"kernelRuntime/retryRun": { runId: IDS.homeRunDone },
	"kernelRuntime/uploadAttachment": {
		type: "file",
		fileName: "notes.txt",
		mimeType: "text/plain",
		size: 5,
		content: "data:text/plain;base64,SGVsbG8=",
	},
	"kernelRuntime/enqueueMessage": {
		conversationId: IDS.conversationHome,
		content: "Ping from the unit test",
		idempotencyKey: "test-key-1",
	},
};

// Runtime-app procedures answer only for the sample company's seeded app.
const DEMO_PACK_CALLS = new Set([
	"osAppRuntime/client",
	"osAppRuntime/readOutput",
	"osAppRuntime/draft",
	"osAppRuntime/proposeEdit",
	"osAppRuntime/saveDraft",
	"osAppRuntime/mergeDraft",
]);

describe("local fixtures parse through the contract output schemas", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	it("covers every registered handler with a contract-parse case", () => {
		expect(Object.keys(CALLS).sort()).toEqual([...LOCAL_RPC_PROCEDURES].sort());
	});

	for (const [key, input] of Object.entries(CALLS)) {
		it(`${key} input is accepted and output parses against its contract schema`, async () => {
			await expectInputAcceptedByContract(key, input);
			if (DEMO_PACK_CALLS.has(key)) {
				vi.resetModules();
				const sample = await import("./local-fixtures");
				sample.enableDemoPack();
				const result = sample.handleLocalRpc(`/api/rpc/${key}`, "POST", {
					json: input,
				});
				expect(result?.status).toBe(200);
				await expectParsesAgainstContract(
					key,
					(result!.body as { json: unknown }).json,
				);
				return;
			}
			if (key === "connections/redeemConnectTicket")
				callLocalOk(
					"connections/stageConnectTicket",
					CALLS["connections/stageConnectTicket"],
				);
			// A share link exists only once created; act on a real one.
			const shareInput =
				key === "osShares/shares/previewRevoke" ||
				key === "osShares/shares/revoke"
					? {
							shareId: (
								callLocalOk(
									"osShares/shares/create",
									CALLS["osShares/shares/create"],
								) as { share: { id: string } }
							).share.id,
						}
					: input;
			const output = callLocalOk(key, shareInput);
			await expectParsesAgainstContract(key, output);
		});
	}
});

it("redeems a staged connect ticket once and refuses unknown tickets", () => {
	resetLocalFixtures();
	const { ticket } = callLocalOk("connections/stageConnectTicket", {
		appId: "github",
	}) as { ticket: string };
	expect(callLocalOk("connections/redeemConnectTicket", { ticket })).toEqual({
		appId: "github",
		scope: "user",
		connectionInstanceId: null,
		recorded: false,
	});
	expect(callLocal("connections/redeemConnectTicket", { ticket }).status).toBe(
		409,
	);
	expect(
		callLocal("connections/redeemConnectTicket", { ticket: "unknown" }).status,
	).toBe(404);
});

it("serves the runtime client and only its current session's granted Output slots", async () => {
	vi.resetModules();
	const sample = await import("./local-fixtures");
	sample.enableDemoPack();
	const scope = CALLS["osAppRuntime/client"];
	const request = (key: string, input: unknown) =>
		sample.handleLocalRpc(`/api/rpc/${key}`, "POST", { json: input });
	const client = request("osAppRuntime/client", scope);
	expect(client?.body).toMatchObject({
		json: {
			client: expect.any(String),
			settings: { reviewer: "Maya", slot: "opportunities" },
			grants: [
				{
					slot: "opportunities",
					operations: ["outputs.read", "outputs.patch"],
				},
			],
		},
	});
	expect((client!.body as { json: unknown }).json).not.toHaveProperty("files");
	const input = CALLS["osAppRuntime/readOutput"];
	expect(request("osAppRuntime/readOutput", input)?.body).toMatchObject({
		json: { kind: "sheet" },
	});
	for (const change of [{ session: "wrong-session" }, { slot: "ungranted" }])
		expect(
			request("osAppRuntime/readOutput", { ...input, ...change })?.status,
		).toBe(403);
	expect(
		request("osWorkspaces/gadgets/revise", {
			...scope,
			manifest: {
				entry: "tedix:runtime/v1",
				capabilities: [],
				resourceGrants: [],
			},
			files: {
				"server.js": "export default {}",
				"client.js": "export default () => {}",
			},
		})?.status,
	).toBe(200);
	expect(request("osAppRuntime/readOutput", input)?.status).toBe(403);
});

describe("portable blueprint fixtures", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	it("exports the allowlisted envelope and imports a private draft with asserted lineage", () => {
		const exported = callLocalOk("osWorkspaces/blueprints/export", {
			blueprintId: IDS.blueprintPublished,
		}) as { export: typeof portableBlueprintExport };
		expect(exported.export.blueprint.name).toBe("Revenue Ops Starter");
		expect(JSON.stringify(exported)).not.toContain("dev-operator");

		const imported = callLocalOk("osWorkspaces/blueprints/import", {
			export: exported.export,
			name: "Revenue Ops Portable Copy",
		}) as {
			blueprint: {
				name: string;
				status: string;
				visibility: string;
				lineage: { chain: Array<{ attested: boolean }> };
			};
			revision: { revision: number };
		};
		expect(imported.blueprint).toMatchObject({
			name: "Revenue Ops Portable Copy",
			status: "draft",
			visibility: "org",
		});
		expect(imported.blueprint.lineage.chain[0]?.attested).toBe(false);
		expect(imported.revision.revision).toBe(1);
	});
});

describe("workflow definition health join key", () => {
	// local-fixtures.ts cannot import the contract helper (vite.config.ts loads
	// it under raw Node), so this is the drift guard: the fixture's literal
	// definitionId must equal what the API projects for a dynamic skill. A
	// fixture that encoded the wrong prefix once hid a dead lookup in run detail.
	it("fixture definitionIds match the contract projection", () => {
		const health = callLocalOk("workflows/listDefinitionHealth", {
			limit: 50,
			offset: 0,
		}) as { health: Array<{ definitionId: string }> };
		const ids = health.health.map((entry) => entry.definitionId);
		expect(ids).toContain(dynamicSkillDefinitionId(IDS.skillRevenue));
		expect(ids).toContain(dynamicSkillDefinitionId(IDS.skillChurn));
	});
});

describe("tedi evidence fixture coherence", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	// The OS unions a completed read with a failed read because listEvents
	// filters by ONE kind. A fixture that ignored `kind` would make that union
	// meaningless and hide a real filter bug behind a passing surface.
	it("listEvents honors the kind filter and the tedi scope", () => {
		const completed = callLocalOk("cognitiveRuntime/listEvents", {
			tediId: IDS.tediMiles,
			kind: "tool.completed",
			limit: 200,
		}) as { events: { kind: string; tediId: string }[] };
		expect(completed.events.length).toBeGreaterThan(0);
		expect(completed.events.every((e) => e.kind === "tool.completed")).toBe(
			true,
		);
		expect(completed.events.every((e) => e.tediId === IDS.tediMiles)).toBe(
			true,
		);

		const failed = callLocalOk("cognitiveRuntime/listEvents", {
			tediId: IDS.tediMiles,
			kind: "tool.failed",
			limit: 200,
		}) as { events: { kind: string }[] };
		expect(failed.events.length).toBeGreaterThan(0);
		expect(failed.events.every((e) => e.kind === "tool.failed")).toBe(true);

		const nova = callLocalOk("cognitiveRuntime/listEvents", {
			tediId: IDS.tediNova,
			kind: "tool.failed",
			limit: 200,
		}) as { events: unknown[] };
		expect(nova.events.length).toBe(0);
	});

	it("tool events carry the payload fields telemetry reads", () => {
		const failed = callLocalOk("cognitiveRuntime/listEvents", {
			tediId: IDS.tediMiles,
			kind: "tool.failed",
			limit: 200,
		}) as {
			events: {
				payload?: { name?: unknown; latencyMs?: unknown; error?: unknown };
			}[];
		};
		const payload = failed.events[0]?.payload;
		expect(typeof payload?.name).toBe("string");
		expect(typeof payload?.latencyMs).toBe("number");
		expect(typeof payload?.error).toBe("string");
	});

	it("expertise narrows by tedi", () => {
		const miles = callLocalOk("memoryGraph/expertise", {
			tediId: IDS.tediMiles,
		}) as { expertise: { tediId: string }[] };
		expect(miles.expertise.length).toBeGreaterThan(1);
		expect(miles.expertise.every((row) => row.tediId === IDS.tediMiles)).toBe(
			true,
		);
	});

	// The map's domain nodes must be the SAME ids the expertise read returns —
	// two independently invented id spaces would render a graph that agrees
	// with nothing else on the page.
	it("knowledge-map domain nodes are the expertise domains", () => {
		const domains = new Set(
			(
				callLocalOk("memoryGraph/expertise", { tediId: IDS.tediMiles }) as {
					expertise: { domainId: string }[];
				}
			).expertise.map((row) => row.domainId),
		);
		const graph = callLocalOk("memoryGraph/graph/visualization", {
			view: "knowledge_map",
			tediId: IDS.tediMiles,
			depth: 2,
			maxNodes: 60,
		}) as { nodes: { id: string; type: string }[] };
		const graphDomains = graph.nodes.filter((node) => node.type === "domain");
		expect(graphDomains.length).toBeGreaterThan(0);
		for (const node of graphDomains) expect(domains.has(node.id)).toBe(true);
	});

	it("the delegation profile grants real, active task-scoped authority", () => {
		const profile = callLocalOk("earnedDelegation/getProfile", {
			tediId: IDS.tediMiles,
		}) as {
			tediId: string;
			activeRole: { careerStage: string } | null;
			entrustments: { effectiveStatus: string; activity: { name: string } }[];
		};
		expect(profile.tediId).toBe(IDS.tediMiles);
		expect(profile.activeRole).not.toBeNull();
		expect(
			profile.entrustments.some((row) => row.effectiveStatus === "active"),
		).toBe(true);
	});
});

describe("work graph fixture coherence", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	type Row = { id: string; title: string; projectId: string | null };
	const board = (input?: unknown) =>
		(callLocalOk("workItems/list", input ?? { limit: 100 }) as { data: Row[] })
			.data;

	// A project option whose key no work item carries renders a filter that can
	// only ever show an empty board — the local lane must not model that.
	it("every active project has canonical work linked by id", () => {
		const ids = new Set(board().map((row) => row.projectId));
		const projects = (
			callLocalOk("projects/list", { limit: 100 }) as {
				data: { id: string; archivedAt: string | null }[];
			}
		).data.filter((row) => row.archivedAt === null);
		expect(projects.length).toBeGreaterThan(1);
		for (const project of projects) {
			expect(ids.has(project.id), `no work item in ${project.id}`).toBe(true);
		}
	});

	it("narrows the board and relations by canonical project id", () => {
		const projectId = (
			callLocalOk("projects/list", { limit: 100 }) as {
				data: { id: string; key: string }[];
			}
		).data.find((project) => project.key === "OPS")!.id;
		const scoped = board({ projectId, limit: 100 });
		expect(scoped.length).toBeGreaterThan(0);
		expect(scoped.every((row) => row.projectId === projectId)).toBe(true);

		const ids = new Set(scoped.map((row) => row.id));
		const relations = (
			callLocalOk("workItems/listRelations", {
				projectId,
				limit: 500,
			}) as { relations: { fromWorkItemId: string; toWorkItemId: string }[] }
		).relations;
		expect(relations.length).toBeGreaterThan(0);
		for (const relation of relations) {
			expect(ids.has(relation.fromWorkItemId)).toBe(true);
			expect(ids.has(relation.toWorkItemId)).toBe(true);
		}
	});

	it("root blockers head a real chain and outrank their own dependents", () => {
		const health = callLocalOk("workItems/getOrgGraphHealth", {
			limit: 20,
		}) as {
			rootBlockers: { id: string; downstreamBlockedCount: number }[];
			counts: { rootBlockerCount: number; statusBlockedCount: number };
		};
		expect(health.rootBlockers.length).toBe(health.counts.rootBlockerCount);
		expect(health.rootBlockers.length).toBeGreaterThan(0);
		// Transitive, not one-hop: the fixture chain is 6 → 1 → 7 plus 6 → 2.
		expect(health.rootBlockers[0]?.downstreamBlockedCount).toBeGreaterThan(1);
		expect(health.counts.statusBlockedCount).toBeGreaterThan(0);
	});

	it("coherence findings point at work items that exist", () => {
		const ids = new Set(board().map((row) => row.id));
		const report = callLocalOk("workItems/getWorkGraphHealth", {
			idleThresholdDays: 14,
			dupThreshold: 0.85,
			scanCap: 500,
		}) as {
			duplicates: { workItemIds: string[] }[];
			idleAccepted: { workItemId: string }[];
			expiredAttempts: { workItemId: string }[];
			counts: {
				duplicateClusters: number;
				idleAccepted: number;
				expiredAttempts: number;
			};
		};
		const referenced = [
			...report.duplicates.flatMap((cluster) => cluster.workItemIds),
			...report.idleAccepted.map((row) => row.workItemId),
			...report.expiredAttempts.map((row) => row.workItemId),
		];
		expect(referenced.length).toBeGreaterThan(0);
		for (const id of referenced) expect(ids.has(id)).toBe(true);
		expect(report.counts.duplicateClusters).toBe(report.duplicates.length);
		expect(report.counts.idleAccepted).toBe(report.idleAccepted.length);
		expect(report.counts.expiredAttempts).toBe(report.expiredAttempts.length);
	});

	it("the owner brief's attention items are real work items", () => {
		const ids = new Set(board().map((row) => row.id));
		const brief = callLocalOk("organizationPurpose/getOwnerBrief", {
			outcomeWindowDays: 7,
		}) as {
			purposeCharter: { version: number } | null;
			needsJudgment: { id: string }[];
			exceptions: { id: string }[];
			outcomes: { id: string }[];
		};
		expect(brief.purposeCharter).not.toBeNull();
		for (const item of [
			...brief.needsJudgment,
			...brief.exceptions,
			...brief.outcomes,
		]) {
			expect(ids.has(item.id)).toBe(true);
		}
	});
});

describe("workspace work fixture coherence", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	const OPS = "00000076-0000-4000-8000-000000000001";
	const linksFor = (workspaceId: string) =>
		(
			callLocalOk("osWorkspaces/work/listProjects", {
				workspaceId,
				status: "active",
				limit: 100,
			}) as { items: { projectId: string; updatedAt: string }[] }
		).items;

	it("workspace project links resolve to real projects that carry work", () => {
		const links = linksFor(IDS.workspaceRevenue);
		expect(links.length).toBeGreaterThan(0);
		const projects = (
			callLocalOk("projects/list", { limit: 100 }) as {
				data: { id: string }[];
			}
		).data;
		for (const link of links) {
			expect(projects.some((project) => project.id === link.projectId)).toBe(
				true,
			);
			const items = (
				callLocalOk("workItems/list", {
					projectId: link.projectId,
					limit: 100,
				}) as { data: { id: string }[] }
			).data;
			expect(items.length).toBeGreaterThan(0);
		}
	});

	it("links, relinks and removes a project through the attach/remove handlers", () => {
		const pilot = "00000076-0000-4000-8000-000000000004";
		const attached = callLocalOk("osWorkspaces/work/attachProject", {
			workspaceId: IDS.workspaceRevenue,
			projectId: pilot,
		}) as { link: { status: string; updatedAt: string } };
		expect(attached.link.status).toBe("active");
		expect(
			linksFor(IDS.workspaceRevenue).some((link) => link.projectId === pilot),
		).toBe(true);

		const removed = callLocalOk("osWorkspaces/work/removeProject", {
			workspaceId: IDS.workspaceRevenue,
			projectId: pilot,
			expectedUpdatedAt: attached.link.updatedAt,
		}) as { link: { status: string } };
		expect(removed.link.status).toBe("removed");
		expect(
			linksFor(IDS.workspaceRevenue).some((link) => link.projectId === pilot),
		).toBe(false);
	});

	it("linked projects expose sprints and milestones over real work", () => {
		const sprints = callLocalOk("projects/listSprints", { id: OPS }) as {
			data: { sprint: { projectId: string }; workItemIds: string[] }[];
		};
		expect(sprints.data.length).toBeGreaterThan(0);
		const ids = new Set(
			(
				callLocalOk("workItems/list", {
					projectId: OPS,
					limit: 100,
				}) as { data: { id: string }[] }
			).data.map((row) => row.id),
		);
		for (const entry of sprints.data) {
			expect(entry.sprint.projectId).toBe(OPS);
			for (const id of entry.workItemIds) expect(ids.has(id)).toBe(true);
		}
		const milestones = callLocalOk("projects/listMilestones", {
			id: OPS,
		}) as {
			data: {
				milestone: { projectId: string };
				workItems: { id: string }[];
			}[];
		};
		expect(milestones.data.length).toBeGreaterThan(0);
		for (const entry of milestones.data) {
			expect(entry.milestone.projectId).toBe(OPS);
			for (const item of entry.workItems) expect(ids.has(item.id)).toBe(true);
		}
	});

	it("attempt projections scope to the project and name its real work", () => {
		const projection = callLocalOk("workItems/listAttemptProjection", {
			projectId: OPS,
			runtimeStates: ["queued", "running", "waiting", "retrying"],
			limit: 100,
		}) as {
			data: {
				attempt: { workItemId: string; runtimeState: string };
				workItem: { id: string; projectId: string | null };
			}[];
			hasMore: boolean;
		};
		expect(projection.data.length).toBeGreaterThan(0);
		for (const entry of projection.data) {
			expect(entry.workItem.id).toBe(entry.attempt.workItemId);
			expect(entry.workItem.projectId).toBe(OPS);
		}
		expect(
			projection.data.map((entry) => entry.attempt.runtimeState),
		).toContain("running");

		const other = callLocalOk("workItems/listAttemptProjection", {
			projectId: "00000076-0000-4000-8000-000000000006",
			limit: 100,
		}) as { data: unknown[] };
		expect(other.data.length).toBe(0);
	});

	it("readiness queue lists accepted work and marks running items", () => {
		const queue = callLocalOk("workItems/listReadinessProjection", {
			limit: 25,
		}) as {
			data: {
				workItem: { disposition: string };
				readiness: { state: string; ready: boolean };
			}[];
		};
		expect(queue.data.length).toBeGreaterThan(0);
		for (const entry of queue.data)
			expect(entry.workItem.disposition).toBe("accepted");
		const states = queue.data.map((entry) => entry.readiness.state);
		expect(states).toContain("ready");
		expect(states).toContain("already_running");
	});
});

describe("seeded output content", () => {
	beforeEach(() => resetLocalFixtures());

	it.each([
		[IDS.outputDocument, IDS.documentContent],
		[IDS.outputSheet, IDS.sheetContent],
		[IDS.outputDeck, IDS.deckContent],
	])("keeps the initial revision and content for %s", (outputId, content) => {
		const detail = callLocalOk("osWorkspaces/outputs/get", { outputId });
		expect(detail).toMatchObject({ currentRevision: { revision: 1, content } });
	});
});

describe("wire envelope", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	it("wraps success payloads as {json: <output>}", () => {
		const result = callLocal("tedis/list", { limit: 10, offset: 0 });
		expect(result.status).toBe(200);
		expect(Object.keys(result.body as object)).toEqual(["json"]);
	});

	it("returns null for procedures it does not cover", () => {
		expect(
			handleLocalRpc("/api/rpc/nope/nothing", "POST", undefined),
		).toBeNull();
		expect(handleLocalRpc("/not-api", "POST", undefined)).toBeNull();
	});

	it("re-applies the client serializer's undefined meta markers", () => {
		// The SPA sends `conversationId: undefined` as null + meta marker; the
		// handler must see undefined and open a NEW conversation, not fail.
		const result = handleLocalRpc(
			"/api/rpc/kernelRuntime/enqueueMessage",
			"POST",
			{
				json: { conversationId: null, content: "meta test" },
				meta: [["undefined", "conversationId"]],
			},
		);
		expect(result?.status).toBe(200);
		const output = (result?.body as { json: { conversationId: string } }).json;
		expect(output.conversationId).not.toBe(IDS.conversationHome);
	});
});

describe("workspace preference fixtures", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	it("persists favorite and recency independently of workspace authority", () => {
		const before = callLocalOk(
			"osWorkspaces/workspacePreferences/list",
			{},
		) as { items: Array<{ workspaceId: string; favorite: boolean }> };
		expect(before.items).toContainEqual(
			expect.objectContaining({
				workspaceId: IDS.workspaceRevenue,
				favorite: true,
			}),
		);

		callLocalOk("osWorkspaces/workspacePreferences/setFavorite", {
			workspaceId: IDS.workspaceSupport,
			favorite: true,
		});
		const touched = callLocalOk("osWorkspaces/workspacePreferences/touch", {
			workspaceId: IDS.workspaceSupport,
		}) as { preference: { favorite: boolean; lastOpenedAt: string | null } };
		expect(touched.preference.favorite).toBe(true);
		expect(touched.preference.lastOpenedAt).toEqual(expect.any(String));
	});
});

describe("optimistic-concurrency conflicts", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	const expectConflict = (
		result: { status: number; body: unknown },
		currentRevision: number,
	) => {
		expect(result.status).toBe(409);
		const error = (
			result.body as {
				json: {
					defined: boolean;
					inferable: boolean;
					code: string;
					message: string;
					data: { expectedRevision: number; currentRevision: number | null };
				};
			}
		).json;
		expect(error.defined).toBe(true);
		expect(error.inferable).toBe(true);
		expect(error.code).toBe("CONFLICT");
		expect(error.message).toMatch(/conflict/i);
		expect(error.data.currentRevision).toBe(currentRevision);
	};

	it("outputs.revise bumps the revision, then rejects a stale expectedRevision", () => {
		const first = callLocalOk("osWorkspaces/outputs/revise", {
			outputId: IDS.outputDocument,
			content: IDS.documentContent,
			expectedRevision: 1,
		}) as {
			output: { currentRevisionId: string };
			revision: { revision: number };
		};
		expect(first.revision.revision).toBe(2);

		const stale = callLocal("osWorkspaces/outputs/revise", {
			outputId: IDS.outputDocument,
			content: IDS.documentContent,
			expectedRevision: 1,
		});
		expectConflict(stale, 2);

		const detail = callLocalOk("osWorkspaces/outputs/get", {
			outputId: IDS.outputDocument,
		}) as { currentRevision: { revision: number } };
		expect(detail.currentRevision.revision).toBe(2);
	});

	it("gadgets.revise honors expectedRevision", () => {
		const revised = callLocalOk("osWorkspaces/gadgets/revise", {
			workspaceId: IDS.workspaceRevenue,
			gadgetId: IDS.gadgetDashboard,
			manifest: {
				capabilities: [],
				entry: "gadgets/next/index.html",
				skillSlug: "weekly-revenue-report",
				config: { version: 1, limit: 25 },
				navigation: { board: true },
			},
			expectedRevision: 1,
		}) as { revision: { revision: number; manifest: { skillSlug?: string } } };
		expect(revised.revision.revision).toBe(2);
		expect(revised.revision.manifest.skillSlug).toBe("weekly-revenue-report");
		expect(revised.revision.manifest).toMatchObject({
			config: { version: 1, limit: 25 },
			navigation: { board: true },
		});

		const stale = callLocal("osWorkspaces/gadgets/revise", {
			workspaceId: IDS.workspaceRevenue,
			gadgetId: IDS.gadgetDashboard,
			manifest: { capabilities: [], entry: "gadgets/next/index.html" },
			expectedRevision: 1,
		});
		expectConflict(stale, 2);
	});

	it("runs a Gadget through a selected local tedi and records its receipt", () => {
		const result = callLocalOk("osWorkspaces/gadgets/run", {
			workspaceId: IDS.workspaceRevenue,
			gadgetId: IDS.gadgetDashboard,
			tediId: IDS.tediMiles,
			input: { range: "this_week" },
		}) as { execution: OsGadgetExecution };
		expect(result.execution).toMatchObject({
			status: "completed",
			input: { range: "this_week" },
			policyDecision: { allowed: true, reasons: [] },
			lineage: { tediId: IDS.tediMiles, runtimeEnvironment: "development" },
		});
		expect(result.execution.lineage.runId).not.toBeNull();

		const history = callLocalOk("osWorkspaces/executions/list", {
			workspaceId: IDS.workspaceRevenue,
			gadgetId: IDS.gadgetDashboard,
		}) as { items: OsGadgetExecution[] };
		expect(history.items[0]?.id).toBe(result.execution.id);
	});

	it("blueprint upgrade previews the new app and applying it adds the app and re-pins", () => {
		const input = { workspaceId: IDS.workspaceSupport };
		const { report } = callLocalOk(
			"osWorkspaces/workspaces/previewBlueprintUpgrade",
			input,
		) as { report: { candidateRevisionId: string; gadgetChanges: unknown } };
		expect(report.gadgetChanges).toEqual([
			{ name: "Ticket Triage Board", change: "unchanged" },
			{ name: "Follow-up List", change: "added" },
		]);
		const { workspace } = callLocalOk(
			"osWorkspaces/workspaces/decideBlueprintUpgrade",
			{
				...input,
				decision: "apply",
				candidateRevisionId: report.candidateRevisionId,
			},
		) as {
			workspace: {
				sourceBlueprintRevisionNumber: number;
				rollbackReference: { revision: number } | null;
				blueprintDecision: { decision: string } | null;
			};
		};
		expect(workspace.sourceBlueprintRevisionNumber).toBe(2);
		expect(workspace.rollbackReference?.revision).toBe(1);
		expect(workspace.blueprintDecision?.decision).toBe("applied");
		const { items } = callLocalOk("osWorkspaces/gadgets/list", input) as {
			items: Array<{ name: string }>;
		};
		expect(items.map((row) => row.name)).toContain("Follow-up List");
	});

	it("blueprints.saveWorkspace persists a draft snapshot and rejects duplicate or missing sources", () => {
		const input = {
			workspaceId: IDS.workspaceRevenue,
			name: "Saved Revenue Ops",
		};
		const saved = callLocalOk("osWorkspaces/blueprints/saveWorkspace", input);
		expect(saved).toMatchObject({
			blueprint: { name: input.name, status: "draft", visibility: "org" },
			revision: {
				revision: 1,
				publishedAt: null,
				definition: {
					gadgets: expect.arrayContaining([
						expect.objectContaining({
							name: "Revenue Dashboard",
							manifest: expect.objectContaining({
								entry: LOCAL_WIDGET_RESOURCE_URI,
							}),
						}),
					]),
				},
			},
		});
		const { blueprint } = saved as { blueprint: { id: string } };
		expect(
			callLocalOk("osWorkspaces/blueprints/get", { blueprintId: blueprint.id }),
		).toMatchObject({
			blueprint,
			currentRevision: (saved as { revision: unknown }).revision,
		});
		expect(
			callLocal("osWorkspaces/blueprints/saveWorkspace", input).status,
		).toBe(409);
		expect(
			callLocal("osWorkspaces/blueprints/saveWorkspace", {
				...input,
				workspaceId: "00000000-0000-4000-8000-000000000999",
				name: "Missing",
			}).status,
		).toBe(404);
	});

	it("blueprints.revise honors expectedRevision and publish flows through", () => {
		const revised = callLocalOk("osWorkspaces/blueprints/revise", {
			blueprintId: IDS.blueprintDraft,
			definition: blankDefinition,
			expectedRevision: 1,
		}) as { revision: { revision: number } };
		expect(revised.revision.revision).toBe(2);

		const stale = callLocal("osWorkspaces/blueprints/revise", {
			blueprintId: IDS.blueprintDraft,
			definition: blankDefinition,
			expectedRevision: 1,
		});
		expectConflict(stale, 2);

		const published = callLocalOk("osWorkspaces/blueprints/publish", {
			blueprintId: IDS.blueprintDraft,
		}) as {
			blueprint: { status: string };
			revision: { publishedAt: string | null };
		};
		expect(published.blueprint.status).toBe("published");
		expect(published.revision.publishedAt).not.toBeNull();
	});

	it("blueprints.instantiate rejects a taken workspace name with CONFLICT", () => {
		const taken = callLocal("osWorkspaces/blueprints/instantiate", {
			blueprintId: IDS.blueprintPublished,
			workspaceName: "Revenue Ops",
		});
		expect(taken.status).toBe(409);
		const fresh = callLocalOk("osWorkspaces/blueprints/instantiate", {
			blueprintId: IDS.blueprintPublished,
			workspaceName: "Fresh Workspace",
		}) as { workspace: { name: string }; gadgets: unknown[] };
		expect(fresh.workspace.name).toBe("Fresh Workspace");
		expect(fresh.gadgets.length).toBeGreaterThan(0);
	});
});

describe("kernel enqueue flow", () => {
	beforeEach(() => {
		resetLocalFixtures();
	});

	it("appends the user message plus a canned assistant reply and returns the enqueue shape", async () => {
		const before = callLocalOk("kernelRuntime/readMessages", {
			conversationId: IDS.conversationHome,
		}) as { messages: unknown[] };

		const output = callLocalOk("kernelRuntime/enqueueMessage", {
			conversationId: IDS.conversationHome,
			content: "How did wholesale do today?",
			idempotencyKey: "enqueue-flow-1",
		}) as {
			status: string;
			conversationId: string;
			idempotencyKey: string;
			run: { id: string; conversationId: string };
			assistantMessage?: { role: string; content: string };
		};
		await expectParsesAgainstContract("kernelRuntime/enqueueMessage", output);
		expect(output.status).toBe("queued");
		expect(output.conversationId).toBe(IDS.conversationHome);
		expect(output.idempotencyKey).toBe("enqueue-flow-1");
		expect(output.run.conversationId).toBe(IDS.conversationHome);
		expect(output.assistantMessage?.role).toBe("assistant");

		const after = callLocalOk("kernelRuntime/readMessages", {
			conversationId: IDS.conversationHome,
		}) as { messages: { role: string; content: string }[] };
		expect(after.messages.length).toBe(before.messages.length + 2);
		const last = after.messages[after.messages.length - 1];
		expect(last?.role).toBe("assistant");

		const runSet = callLocalOk("kernelRuntime/readRunSet", {
			conversationId: IDS.conversationHome,
		}) as { runSet: { runs: { id: string }[] } };
		expect(runSet.runSet.runs.some((run) => run.id === output.run.id)).toBe(
			true,
		);
	});

	it("starts a new conversation when none is given", () => {
		const output = callLocalOk("kernelRuntime/enqueueMessage", {
			content: "Fresh thread please",
		}) as { conversationId: string };
		expect(output.conversationId).not.toBe(IDS.conversationHome);
		const list = callLocalOk("kernelRuntime/listConversations", {}) as {
			conversations: { id: string }[];
		};
		expect(
			list.conversations.some((row) => row.id === output.conversationId),
		).toBe(true);
	});
});

describe("fixture bootstrap parity", () => {
	beforeEach(() => resetLocalFixtures());

	it("preserves synthetic identity, attachments and one input on same-key retries", async () => {
		const input = {
			conversationId: "home:fixture-bootstrap",
			content: "Review the fictional supplier note",
			idempotencyKey: "fixture-bootstrap-turn",
			attachments: [
				{
					type: "file",
					fileName: "supplier.txt",
					mimeType: "text/plain",
					content: "Fictional supplier note",
				},
			],
		};
		await expectInputAcceptedByContract("kernelRuntime/enqueueMessage", input);
		const first = callLocalOk("kernelRuntime/enqueueMessage", input);
		expect(first).toMatchObject({
			conversationId: input.conversationId,
			run: {
				id: input.idempotencyKey,
				inputMessageId: `${input.idempotencyKey}:input`,
			},
		});
		expect(callLocalOk("kernelRuntime/enqueueMessage", input)).toEqual(first);
		const transcript = callLocalOk("kernelRuntime/readMessages", {
			conversationId: input.conversationId,
		}) as { messages: unknown[] };
		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages).toContainEqual(
			expect.objectContaining({
				id: `${input.idempotencyKey}:input`,
				attachments: input.attachments,
			}),
		);
		const changed = callLocalOk("kernelRuntime/enqueueMessage", {
			...input,
			idempotencyKey: "fixture-bootstrap-next",
		});
		expect(changed).toMatchObject({
			conversationId: input.conversationId,
			run: { id: "fixture-bootstrap-next" },
		});
		const runs = callLocalOk("kernelRuntime/readRunSet", {
			conversationId: input.conversationId,
		}) as { runSet: { runs: unknown[] } };
		expect(runs.runSet.runs).toHaveLength(2);
		expect(
			(
				callLocalOk("kernelRuntime/readMessages", {
					conversationId: input.conversationId,
				}) as { messages: unknown[] }
			).messages,
		).toHaveLength(4);
	});

	it("refuses a key rebound to another conversation", () => {
		const input = {
			conversationId: IDS.conversationHome,
			content: "Fictional note",
			idempotencyKey: "fixture-bound-key",
		};
		callLocalOk("kernelRuntime/enqueueMessage", input);
		expect(
			callLocal("kernelRuntime/enqueueMessage", {
				...input,
				conversationId: "home:other-fixture",
			}).status,
		).toBe(409);
	});

	it("keeps Office available while installing Feed and Deck once", async () => {
		const key = "osWorkspaces/gadgets/installWorkDefaults";
		const before = callLocalOk("osWorkspaces/gadgets/workApps", { limit: 100 });
		expect(before).toMatchObject({
			items: ["Projects", "Agents", "Office", "Outbound"].map((name) => ({
				gadget: { name },
			})),
		});
		const installed = callLocalOk(key, {}) as { workspaceId: string };
		await expectParsesAgainstContract(key, installed);
		const apps = callLocalOk("osWorkspaces/gadgets/workApps", { limit: 100 });
		await expectParsesAgainstContract("osWorkspaces/gadgets/workApps", apps);
		expect(apps).toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({
					gadget: expect.objectContaining({
						name: "Activity",
						workspaceId: installed.workspaceId,
					}),
					currentRevision: expect.objectContaining({
						manifest: expect.objectContaining({
							entry: "tedix:app/activity-feed",
							navigation: expect.objectContaining({ work: "feed" }),
						}),
					}),
				}),
				expect.objectContaining({
					gadget: expect.objectContaining({
						name: "Decisions",
						workspaceId: installed.workspaceId,
					}),
					currentRevision: expect.objectContaining({
						manifest: expect.objectContaining({
							entry: "tedix:app/decision-deck",
							navigation: expect.objectContaining({
								work: "deck",
								workDefault: true,
							}),
						}),
					}),
				}),
			]),
		});
		expect(callLocalOk(key, {})).toEqual(installed);
		expect(
			callLocalOk("osWorkspaces/gadgets/workApps", { limit: 100 }),
		).toEqual(apps);
		const listed = callLocalOk("osWorkspaces/gadgets/list", {
			workspaceId: installed.workspaceId,
			limit: 100,
		});
		await expectParsesAgainstContract("osWorkspaces/gadgets/list", listed);
	});

	it("adds only the missing role when a default app is already installed", () => {
		const key = "osWorkspaces/gadgets/installWorkDefaults";
		const installed = callLocalOk(key, {}) as { workspaceId: string };
		const apps = callLocalOk("osWorkspaces/gadgets/workApps", {
			limit: 100,
		}) as {
			items: { gadget: { id: string; name: string } }[];
		};
		const deck = apps.items.find(
			(app) => app.gadget.name === "Decisions",
		)!.gadget;
		callLocalOk("osWorkspaces/gadgets/archive", {
			workspaceId: installed.workspaceId,
			gadgetId: deck.id,
		});
		expect(callLocalOk(key, {})).toEqual(installed);
		const repaired = callLocalOk("osWorkspaces/gadgets/workApps", {
			limit: 100,
		}) as typeof apps;
		expect(repaired.items).toHaveLength(6);
		expect(
			repaired.items.filter((app) => app.gadget.name === "Activity"),
		).toEqual(apps.items.filter((app) => app.gadget.name === "Activity"));
		expect(
			repaired.items.find((app) => app.gadget.name === "Decisions")!.gadget.id,
		).not.toBe(deck.id);
	});

	it("exposes Projects through the generic installed Work apps", async () => {
		const apps = callLocalOk("osWorkspaces/gadgets/workApps", { limit: 100 });
		await expectParsesAgainstContract("osWorkspaces/gadgets/workApps", apps);
		expect(apps).toMatchObject({
			items: expect.arrayContaining([
				expect.objectContaining({
					gadget: expect.objectContaining({ name: "Projects" }),
					currentRevision: expect.objectContaining({
						manifest: expect.objectContaining({
							entry: "tedix:app/portfolio",
							navigation: { board: true },
						}),
					}),
				}),
			]),
		});
	});
});

it("keeps sample Feed/Deck records, installs Projects after reset, and refuses sending", async () => {
	vi.resetModules();
	const sample = await import("./local-fixtures");
	sample.enableDemoPack();
	const read = (key: string, input: unknown = {}) => {
		const result = sample.handleLocalRpc(`/api/rpc/${key}`, "POST", {
			json: input,
		});
		expect(result?.status).toBe(200);
		return (result!.body as { json: unknown }).json;
	};
	for (let reset = 0; reset < 2; reset++) {
		const apps = read("osWorkspaces/gadgets/workApps", { limit: 100 }) as {
			items: {
				gadget: { id: string; name: string; workspaceId: string };
				currentRevision: { manifest: { entry: string } };
			}[];
		};
		await expectParsesAgainstContract("osWorkspaces/gadgets/workApps", apps);
		const installed = read("osWorkspaces/gadgets/installWorkDefaults");
		await expectParsesAgainstContract(
			"osWorkspaces/gadgets/installWorkDefaults",
			installed,
		);
		expect(read("osWorkspaces/gadgets/installWorkDefaults")).toEqual(installed);
		expect(read("osWorkspaces/gadgets/workApps", { limit: 100 })).toEqual(apps);
		expect(apps.items.map((item) => item.gadget.name).sort()).toEqual([
			"Activity",
			"Agents",
			"Decisions",
			"Office",
			"Outbound",
			"Projects",
		]);
		expect(
			apps.items.find((item) => item.gadget.name === "Projects")
				?.currentRevision.manifest.entry,
		).toBe("tedix:app/portfolio");
		expect(
			apps.items.find((item) => item.gadget.name === "Office")?.currentRevision
				.manifest.entry,
		).toBe("tedix:app/office");
		expect(
			(read("attention/listDeckCards") as { cards: unknown[] }).cards,
		).toHaveLength(36);
		expect(
			(read("workItems/listActivity") as { events: unknown[] }).events.length,
		).toBeGreaterThan(0);
		const blocked = sample.handleLocalRpc(
			"/api/rpc/workInteractions/outbound/submit",
			"POST",
			{ json: {} },
		);
		expect(blocked?.status).toBe(403);
		expect(JSON.stringify(blocked?.body)).toMatch(/sending.*off/i);
		for (const app of apps.items.filter((app) =>
			["Activity", "Decisions", "Office"].includes(app.gadget.name),
		)) {
			read("osWorkspaces/gadgets/archive", {
				workspaceId: app.gadget.workspaceId,
				gadgetId: app.gadget.id,
			});
		}
		expect(read("osWorkspaces/gadgets/workApps", { limit: 100 })).toMatchObject(
			{
				items: ["Projects", "Agents", "Outbound"].map((name) => ({
					gadget: { name },
				})),
			},
		);
		const reinstalled = read("osWorkspaces/gadgets/installWorkDefaults");
		await expectParsesAgainstContract(
			"osWorkspaces/gadgets/installWorkDefaults",
			reinstalled,
		);
		const restored = read("osWorkspaces/gadgets/workApps", {
			limit: 100,
		}) as typeof apps;
		await expectParsesAgainstContract(
			"osWorkspaces/gadgets/workApps",
			restored,
		);
		expect(restored.items.map((app) => app.gadget.name).sort()).toEqual([
			"Activity",
			"Agents",
			"Decisions",
			"Office",
			"Outbound",
			"Projects",
		]);
		expect(read("osWorkspaces/gadgets/installWorkDefaults")).toEqual(
			reinstalled,
		);
		expect(read("osWorkspaces/gadgets/workApps", { limit: 100 })).toEqual(
			restored,
		);
		sample.resetLocalFixtures();
	}
});

it("serves contract-valid cases, resource holders and budgets with matching filters", async () => {
	for (const key of [
		"workItems/listCases",
		"workItems/listResourcePools",
		"workItems/listBudgetEnvelopes",
	]) {
		const value = callLocalOk(key, {}) as { data: unknown[] };
		expect(value.data).toHaveLength(2);
		await expectParsesAgainstContract(key, value);
	}
	const saturated = callLocalOk("workItems/listResourcePools", {
		saturatedOnly: true,
	}) as { data: { pool: { resourceKey: string }; holders: unknown[] }[] };
	expect(saturated.data).toHaveLength(1);
	expect(saturated.data[0]!.holders).toHaveLength(1);
	expect(
		callLocalOk("workItems/listResourcePools", {
			resourceKey: saturated.data[0]!.pool.resourceKey,
		}),
	).toMatchObject({ data: saturated.data });
	expect(
		callLocalOk("workItems/listCases", { stages: ["planning"] }),
	).toMatchObject({ data: [expect.objectContaining({ stage: "planning" })] });
});

it("installs renderable Agents, Office and Outbound configs", () => {
	const apps = callLocalOk("osWorkspaces/gadgets/workApps", { limit: 100 }) as {
		items: {
			currentRevision: { manifest: { entry: string; config: unknown } };
		}[];
	};
	for (const [entry, schema] of [
		["agents", AgentsConfigSchema],
		["office", OfficeConfigSchema],
		["outbound-review", OutboundReviewConfigSchema],
	] as const) {
		const app = apps.items.find(
			({ currentRevision }) =>
				currentRevision.manifest.entry === `tedix:app/${entry}`,
		);
		expect(app).toBeDefined();
		expect(schema.safeParse(app!.currentRevision.manifest.config).success).toBe(
			true,
		);
	}
});

it("keeps snoozed fixture cards out of the inbox until their wake time", () => {
	resetLocalFixtures();
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
	try {
		const page = callLocalOk("workInteractions/listInbox", {
			states: ["open"],
		}) as { data: { request: { id: string; version: number } }[] };
		const request = page.data[0]!.request;
		const until = "2026-10-27T09:00:00.000Z";
		expect(
			callLocal("workInteractions/snooze", {
				requestId: request.id,
				expectedVersion: request.version + 1,
				until,
			}).status,
		).not.toBe(200);
		callLocalOk("workInteractions/snooze", {
			requestId: request.id,
			expectedVersion: request.version,
			until,
		});
		const ids = () =>
			(
				callLocalOk("workInteractions/listInbox", {
					states: ["open"],
				}) as typeof page
			).data.map((row) => row.request.id);
		expect(ids()).not.toContain(request.id);
		vi.setSystemTime(new Date(until));
		expect(ids()).toContain(request.id);
	} finally {
		vi.useRealTimers();
		resetLocalFixtures();
	}
});
