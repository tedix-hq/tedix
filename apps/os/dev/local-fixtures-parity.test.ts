// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { apiContract } from "@tedix/api-contract/contracts/api";
import {
	type AstNode,
	parseModule,
	stringValue,
	walk,
} from "../../../scripts/oxc-ast";
import { describe, expect, it } from "vite-plus/test";
import { LOCAL_RPC_PROCEDURES } from "./local-fixtures";

function contractProcedures(node: unknown, path: string[] = []): string[] {
	if (typeof node !== "object" || node === null) return [];
	if ("~orpc" in node) return [path.join("/")];
	return Object.entries(node).flatMap(([key, child]) =>
		contractProcedures(child, [...path, key]),
	);
}

const procedures = new Set(contractProcedures(apiContract));

function propertyPath(node: AstNode): string[] {
	if (node.type === "Identifier") return [node.name as string];
	if (node.type === "ChainExpression")
		return propertyPath(node.expression as AstNode);
	if (node.type === "MemberExpression") {
		const property = node.property as AstNode;
		const name = node.computed
			? stringValue(property)
			: (property.name as string);
		if (name) return [...propertyPath(node.object as AstNode), name];
	}
	return [];
}

function calledProcedures(source: string, filename: string): string[] {
	const found = new Set<string>();
	walk(parseModule(filename, source), (node) => {
		// Match contract paths beneath any client name, including aliases, and
		// beneath query utilities. Only real AST accesses count, never comments
		// or strings. Prefix keys for an entire namespace are not procedure calls.
		if (node.type === "MemberExpression") {
			const path = propertyPath(node);
			for (let start = 1; start < path.length; start++) {
				const key = path.slice(start).join("/");
				if (procedures.has(key)) found.add(key);
			}
		}
	});
	return [...found].sort();
}

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = `${directory}/${entry.name}`;
		if (entry.isDirectory()) return sourceFiles(path);
		return /\.[cm]?tsx?$/.test(entry.name) &&
			!/\.(test|spec)\./.test(entry.name)
			? [path]
			: [];
	});
}

// Existing fixture debt, explicitly bounded to these procedures. These sample
// surfaces do not model provider operations, authoring or all operational
// ledgers yet. Groups name the owning UI fallback; none grant fixture coverage.
// Add normal-page handlers rather than extending this list for new calls.
const LOCAL_UNSUPPORTED: Record<string, readonly string[]> = {
	"AppAnalyticsPage: drilldown error panel": [
		"analytics/getExecutionDrilldown",
		"analytics/getToolCallPayloads",
		"analytics/getTraceActivity",
	],
	"WidgetContacts activity error text": [
		"analytics/getEmbeddedProviderActivity",
	],
	"OsQuickChat logs telemetry error; chat continues": [
		"analytics/trackWidgetLifecycle",
	],
	"AppToolsPage: optimistic rollback and failure toast": [
		"appAdapters/disable",
		"appAdapters/enable",
		"appTools/disable",
		"appTools/enable",
	],
	"AppSettingsPage: rollback and delete-secret failure toast": [
		"appSecrets/delete",
	],
	"AppSettingsPage failure toast; AppGatewayMembership mutation error": [
		"apps/delete",
		"apps/setGatewayMembership",
	],
	// The fixture lane answers JSON envelopes only; the export is a file body.
	"AuditExportButton: export failure alert": ["audit/export"],
	"DecisionDeckApp unavailable card; deck curation/not-useful alert": [
		"attention/decideDeckCard",
		"attention/getDeckCard",
		"attention/getDeckPipelineStatus",
		"attention/markDeckCardNotUseful",
		"attention/removeDeckRule",
	],
	"Billing subscription/capacity/budget/overage action error text": [
		"billing/createCheckout",
		"billing/createInferenceCapacityCheckout",
		"billing/createPortal",
		"billing/setCreditBudget",
		"billing/setOverageSettings",
		"billing/setProviderCapacitySponsorship",
	],
	"WorkspaceCalendarCoordinator error text; CalendarResourcePicker error text":
		[
			"calendarCoordinator/activate",
			"calendarCoordinator/apply",
			"calendarCoordinator/compensate",
			"calendarCoordinator/configure",
			"calendarCoordinator/deactivate",
			"calendarCoordinator/list",
			"calendarCoordinator/listCalendars",
			"calendarCoordinator/preview",
			"calendarCoordinator/previewCompensation",
			"calendarCoordinator/recover",
			"calendarCoordinator/status",
			"calendarCoordinator/supportedAccounts",
		],
	"ConversationCapabilityPalette: capabilities query error text": [
		"capabilities/list",
	],
	"AppStorePage query error/empty state; AppStoreDetailPage install failure toast":
		[
			"catalog/getHealthSummary",
			"catalog/getStats",
			"catalog/installFromCatalog",
		],
	"ArtifactReleaseReview: unavailable review/error text and failure toast": [
		"cognitiveRuntime/createArtifactShareLink",
		"cognitiveRuntime/createRedactedArtifactRevision",
		"cognitiveRuntime/getArtifactReleaseReview",
	],
	"AdminConnectionsPage actionError; connection flow failure message": [
		"connections/bindConnectionInstance",
		"connections/createConnectionInstance",
		"connections/disconnectProvider",
		"connections/initiateConnection",
		"connections/renameConnectionInstance",
		"connections/storeApiKey",
	],
	"AppContentPage mutation failure toast": [
		"content/addSource",
		"content/ingestAll",
		"content/ingestSource",
		"content/removeSource",
	],
	"OsOrganizationIdentity fallbackLabel; CliLoginPage error state": [
		"directory/listMyWorkspaces",
		"directory/resolveWorkspace",
	],
	"SitesPage workspace error text and build mutation failure toast": [
		"docs/getWorkspace",
		"docs/publishBuild",
		"docs/rollbackBuild",
		"docs/startBuild",
	],
	"OrganizationProfileForm failure text; AppImageUpload failure toast": [
		"images/confirmUpload",
		"images/delete",
		"images/requestUpload",
	],
	"ConversationCapabilityPalette query/action error text; ChatThread send error":
		[
			"kernelRuntime/archiveConversation",
			"kernelRuntime/attachConversationArtifactPin",
			"kernelRuntime/attachConversationCapability",
			"kernelRuntime/detachConversationArtifactPin",
			"kernelRuntime/detachConversationCapability",
			"kernelRuntime/executeReadOnlyTool",
			"kernelRuntime/listConversationArtifactPins",
			"kernelRuntime/listConversationCapabilities",
		],
	"Chat direct-read shortcut falls back to normal chat": [
		"kernelRuntime/listReadOnlyTools",
	],
	"OsQuickChat catches tool-resolution failure before send": [
		"kernelRuntime/resolvePageTool",
	],
	"CardContextFeedback: Could not save. Try again.": [
		"learningFeedback/cardContext",
	],
	"FocusFeed unavailable state; feedback failure text or absent calibration": [
		"learningFeedback/cardContextPrompt",
		"learningFeedback/correct",
		"learningFeedback/listInteractions",
		"learningFeedback/model",
		"learningFeedback/recordInteraction",
	],
	"DecisionClassCalibration returns null without data": [
		"learningFeedback/getCalibration",
	],
	"Decision instrumentation catches telemetry failure; card stays visible": [
		"learningFeedback/recordExposure",
	],
	"AppDetail/AppsPage connection health failure text": ["mcpHealth/run"],
	"AppToolsPage scope preview failure text": ["mcpServer/previewToolScopes"],
	"TeamMembers action failure; MemberIdentityDialog alert": [
		"members/inviteMember",
		"members/removeMember",
		"members/setMemberIdentity",
		"members/setMemberPermissions",
		"members/updateMemberRole",
	],
	"BillingRunCosts ledger error text": ["orgUsage/getBillingLedger"],
	"Organization launcher/SSO/API keys/consent action or query error text": [
		"organizations/completeOsOnboarding",
		"organizations/configureSso",
		"organizations/create",
		"organizations/deleteApiKey",
		"organizations/disableMcpAuthorization",
		"organizations/generateSsoSetupLink",
		"organizations/getSsoStatus",
		"organizations/isSlugAvailable",
		"organizations/listMcpAuthorizations",
		"organizations/listOsMine",
		"organizations/revokeApiKey",
		"organizations/stageMultiOrgMcpConsent",
	],
	"WorkDecisionStack rule mutation error text": ["osApprovalRules/create"],
	"ShareControls error alert; SharedReviewBatch error text": [
		"osShares/reviews/create",
		"osShares/reviews/get",
		"osShares/reviews/saveFeedback",
		"osShares/shares/create",
		"osShares/shares/list",
		"osShares/shares/previewRevoke",
		"osShares/shares/revoke",
	],
	"ReviewFeedbackSummary renders no summary without data": [
		"osShares/reviews/listFeedback",
	],
	"Workspace panels action/query error text; WebMCP tool error result": [
		"osWorkspaces/blueprints/preflight",
		"osWorkspaces/executions/export",
		"osWorkspaces/outputs/history",
		"osWorkspaces/outputs/patchDocument",
		"osWorkspaces/outputs/patchSlides",
		"osWorkspaces/resources/confirmFileUpload",
		"osWorkspaces/resources/getFile",
		"osWorkspaces/resources/rebind",
		"osWorkspaces/resources/requestFileUpload",
		"osWorkspaces/resources/startRepositoryWork",
		"osWorkspaces/schedules/runNow",
		"osWorkspaces/schedules/setPersonalAccess",
	],
	"PersonalAgentValue error text": ["personalAgentInbound/value"],
	"PersonalReadConsentApp disabled allow; workspace access error text": [
		"personalResourceDelegations/create",
		"personalResourceDelegations/list",
		"personalResourceDelegations/revoke",
	],
	"WorkFactoryPages read/mutation error; WorkspaceWorkPanel sprint error": [
		"projects/addMilestoneDependency",
		"projects/assignSprintWorkItem",
		"projects/attachMilestoneWorkItem",
		"projects/createMilestone",
		"projects/recordHealthJudgment",
		"projects/updateMilestone",
	],
	"SitesPage read error or mutation failure toast": [
		"sites/beginCmsDomain",
		"sites/createCms",
		"sites/deprovision",
		"sites/getCmsDomain",
		"sites/getDeprovisionPlan",
		"sites/getDeprovisionStatus",
		"sites/getReconciliation",
		"sites/getRecoveryManifest",
		"sites/list",
		"sites/removeCmsDomain",
		"sites/runReconciliation",
		"sites/setLifecycle",
		"sites/verifyCmsDomain",
	],
	"SkillDetailLayout DetailUnavailable/alert; workspace drafts/import error text":
		[
			"skills/getWorkspaceDraftGrant",
			"skills/getWorkspaceDraftProposal",
			"skills/listWorkflowRevisions",
			"skills/listWorkspaceDraftProposals",
			"skills/move",
			"skills/proposeWorkspaceRevision",
			"skills/record",
			"skills/runWorkflow",
			"skills/runWorkflowSendEvent",
			"skills/runWorkflowStatus",
			"skills/setWorkspaceDraftGrant",
			"skills/validate",
			"skills/withdrawWorkspaceDraftProposal",
		],
	"SupportAttention error text; SupportGetHelp submission failure": [
		"support/file",
		"support/publish",
		"support/queue",
	],
	"AppTediAssignments/assignment forms rollback and failure toast": [
		"tediAppAssignments/create",
		"tediAppAssignments/delete",
		"tediAppAssignments/updateRole",
	],
	"ApprovalProvenance/ApprovalManifest unavailable state; takeover error text":
		[
			"tediApprovals/getBrowserTakeoverStatus",
			"tediApprovals/getProvenance",
			"tediApprovals/getReviewManifest",
			"tediApprovals/resolveReviewManifest",
		],
	"TediConsoleAccess grant error text and save failure toast": [
		"tediConsole/getGrant",
		"tediConsole/setGrant",
	],
	"TediMailbox query error text or mutation failure toast": [
		"tediEmail/createAddress",
		"tediEmail/deleteAddress",
		"tediEmail/listAddresses",
		"tediEmail/listInbox",
		"tediEmail/mark",
		"tediEmail/readThread",
		"tediEmail/updateAddress",
	],
	"TediSettingsPage unavailable secrets/action failure toast": [
		"tediSecrets/delete",
		"tediSecrets/list",
		"tediSecrets/set",
	],
	"TediSettingsPage action error toast; widget settings error state": [
		"tedis/addCustomDomain",
		"tedis/approveDevice",
		"tedis/approvePairing",
		"tedis/create",
		"tedis/createEmbeddedSession",
		"tedis/delete",
		"tedis/getStatus",
		"tedis/getWidgetContact",
		"tedis/inspectRuntimeRecovery",
		"tedis/listCustomDomains",
		"tedis/listDevices",
		"tedis/listPairingRequests",
		"tedis/listPortableWebMcpConfigurations",
		"tedis/listWidgetAccessConfigurations",
		"tedis/listWidgetContacts",
		"tedis/previewWidgetAccess",
		"tedis/publishPortableWebMcpProfile",
		"tedis/removeCustomDomain",
		"tedis/repair",
		"tedis/resetSandbox",
		"tedis/revokeDevice",
		"tedis/syncConfig",
		"tedis/testChannelToken",
		"tedis/update",
		"tedis/updateChannelConfig",
		"tedis/updateWidgetAccessConfiguration",
		"tedis/validateChannelToken",
		"tedis/wake",
	],
	"ProfilePage profile error and avatar/save failure text": [
		"userProfile/confirmAvatarUpload",
		"userProfile/deleteAvatar",
		"userProfile/getMine",
		"userProfile/requestAvatarUpload",
		"userProfile/updateMine",
	],
	"WorkAttentionPage unavailable badge; request mutation error": [
		"workAgentSessions/fileRequest",
		"workAgentSessions/updateRequest",
	],
	"WorkApprovalsPage WorkReadFailure/MutationError; decision failure toast": [
		"workApprovals/decide",
		"workApprovals/listInbox",
		"workApprovals/propose",
	],
	"prefetchWorkQueueRoute uses Promise.allSettled; queue retains its readiness projection":
		["workFleet/getControlTower"],
	"WorkInteractionsPages WorkReadFailure/MutationError; card action alert": [
		"workInteractions/cancel",
		"workInteractions/cardHistory",
		"workInteractions/create",
		"workInteractions/listAudit",
		"workInteractions/listOutbox",
		"workInteractions/rememberCardStyle",
		"workInteractions/requestCardChanges",
		"workInteractions/respond",
		"workInteractions/reviewCardStyleRule",
		"workInteractions/reviseCard",
	],
	"OutboundCard action failure text; draft retained": [
		"workInteractions/outbound/act",
	],
	"OutboundCard outcome error text": ["workInteractions/outbound/checkOutcome"],
	"OutboundCard style-import error text": [
		"workInteractions/outbound/importSentStyle",
	],
	"Work pages WorkReadFailure/MutationError; comment draft error alert": [
		"workItems/accept",
		"workItems/addComment",
		"workItems/create",
		"workItems/createCase",
		"workItems/getAdmissionSpecification",
		"workItems/inspectAttemptRepository",
		"workItems/listReadinessProjection",
		"workItems/listRecoveryProjection",
		"workItems/listWorkItemSources",
		"workItems/previewEvidence",
		"workItems/putBudgetEnvelope",
		"workItems/putResourcePool",
		"workItems/replaceAdmissionSpecification",
		"workItems/updateCase",
		"workItems/updateSpecification",
	],
	"ActivityFeedSources failed-source state": ["workItems/listActivity"],
	"FocusFeed catches feedback failure without removing the item": [
		"workItems/recordDelegationAutonomyFeedback",
	],
	"Scheduler query options are invalidated by Work mutations; no mounted reader":
		["workScheduler/listReady"],
	"WorkClustersPage WorkReadFailure": ["workScheduler/planClusters"],
};

function missingFixtures(
	calls: Iterable<string>,
	supported: ReadonlySet<string>,
	unsupported: ReadonlySet<string>,
): string[] {
	return [...calls]
		.filter((key) => !supported.has(key) && !unsupported.has(key))
		.sort();
}

describe("local fixture procedure parity", () => {
	it("rejects an OS call when its fixture handler is missing", () => {
		const calls = calledProcedures("client.apps.list({})", "new-call.ts");
		const handlers = new Set(LOCAL_RPC_PROCEDURES);
		expect(missingFixtures(calls, handlers, new Set())).toEqual([]);
		handlers.delete("apps/list");
		expect(missingFixtures(calls, handlers, new Set())).toEqual(["apps/list"]);
	});
	it("finds nested, aliased, optional and computed client accesses", () => {
		expect(
			calledProcedures(
				`alias.apps.list({}); client?.osWorkspaces.outputs.list({});
				 osQuery['externalAgentIdentity'].listPrincipals.queryOptions({});
				 // osApi.apps.getByIdWithTools({})
				 const text = 'osApi.apps.getByIdWithTools'; osQuery.apps.key();`,
				"example.ts",
			),
		).toEqual([
			"apps/list",
			"externalAgentIdentity/listPrincipals",
			"osWorkspaces/outputs/list",
		]);
	});

	it("answers every contract procedure referenced by OS source", () => {
		const files = sourceFiles(
			fileURLToPath(new URL("../src", import.meta.url)),
		);
		const calls = new Set(
			files.flatMap((file) =>
				calledProcedures(readFileSync(file, "utf8"), file),
			),
		);
		expect(calls.size).toBeGreaterThan(0);
		const supported = new Set(LOCAL_RPC_PROCEDURES);
		const unsupported = new Set<string>();
		for (const [fallback, keys] of Object.entries(LOCAL_UNSUPPORTED)) {
			expect(fallback.trim().length).toBeGreaterThan(0);
			for (const key of keys) {
				expect(calls.has(key), `Stale unsupported procedure: ${key}`).toBe(
					true,
				);
				expect(supported.has(key), `Fixture now supports ${key}`).toBe(false);
				expect(
					unsupported.has(key),
					`Duplicate unsupported procedure: ${key}`,
				).toBe(false);
				unsupported.add(key);
			}
		}
		const missing = missingFixtures(calls, supported, unsupported);
		expect(
			missing,
			`${calls.size} OS procedures checked; missing fixtures`,
		).toEqual([]);
	});
});
