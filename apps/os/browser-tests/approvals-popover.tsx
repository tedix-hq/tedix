import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ApprovalNotifications } from "../src/components/approval-notifications";
import {
	approvalHistoryQueryOptions,
	approvalRulesQueryOptions,
	operationalContextQueryOptions,
	pendingApprovalsQueryOptions,
	pendingHomeDelegationsQueryOptions,
	recentToolActivityQueryOptions,
	tediNamesQueryOptions,
	workPendingApprovalsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

// Real component, seeded reads: three held delegations (two tedis) or none.
// `activity` adds an approver, raw-slug action requests (two identical), saved
// rules, decided requests and tool calls for the three Activity tabs.
const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
const probe = params.has("probe");
const empty = params.has("empty") || probe;
const activity = params.has("activity") || probe;
document.documentElement.classList.toggle("dark", dark);
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const now = Date.now();
const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
const held = (input: {
	id: string;
	tedi: string;
	label: string;
	reason: string;
	request: string;
	createdHoursAgo: number;
}) => ({
	id: input.id,
	organizationId: "org",
	conversationId: `home:os:${input.id}`,
	status: "requires_approval" as const,
	createdAt: at(-input.createdHoursAgo),
	updatedAt: at(-input.createdHoursAgo),
	metadata: {
		homeDelegation: {
			decision: { mode: "needs_approval", reason: input.reason },
			workOrder: {
				kind: "tedi.delegate",
				status: "draft",
				targetTediId: input.tedi,
				targetTediLabel: input.label,
				sourceContent: input.request,
			},
			expiresAt: at(24 - input.createdHoursAgo),
		},
	},
});

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const fictionalTedi = "00000000-0000-4000-8000-0000000000c3";
const request = (input: {
	id: string;
	title: string;
	appSlug: string;
	toolName: string;
	status?: string;
	resolvedBy?: string | null;
	resolution?: string | null;
	riskTier?: string;
	hoursAgo: number;
}) => ({
	id: input.id,
	tediId: fictionalTedi,
	orgId: "org",
	actionType: "home.tool_write",
	description: input.title,
	payload: {
		appSlug: input.appSlug,
		toolName: input.toolName,
		conversationId: "home:os:example",
		args: { skillSlug: "weekly-sales-report" },
		...(input.riskTier ? { riskTier: input.riskTier } : {}),
	},
	status: input.status ?? "pending",
	createdAt: at(-input.hoursAgo),
	expiresAt: at(24 - input.hoursAgo),
	resolvedAt: input.status ? at(-input.hoursAgo + 0.1) : null,
	resolvedBy: input.resolvedBy ?? null,
	resolution: input.resolution ?? null,
	workflowId: null,
	review: {
		intent: "tool_write",
		state: input.status ? "resolved" : "requires_decision",
		decisionMode: input.status ? "no_action" : "approve_or_reject",
		outcome: null,
		safetyDefault: "deny_on_timeout",
		summary: input.title,
		operatorQuestion: "",
		timeout: {
			expired: false,
			terminalStatus: null,
			defaultDecision: null,
			reason: "",
		},
		evidenceRefs: [],
		interaction: null,
	},
});
// Without a context entry the authority is still loading, which shows Home
// decisions only; `activity` signs in an approver so action requests show too.
if (activity)
	client.setQueryData(operationalContextQueryOptions().queryKey, {
		authority: { role: "admin", permissions: ["os:approve", "tedis:update"] },
	} as never);
client.setQueryData<unknown>(workPendingApprovalsQueryOptions().queryKey, {
	data: params.has("work-start")
		? [{ effectiveStatus: "pending", canDecide: true }]
		: [],
});
client.setQueryData(tediNamesQueryOptions().queryKey, {
	data: [{ id: fictionalTedi, name: "ops", displayName: "Ops" }],
} as never);
client.setQueryData(pendingApprovalsQueryOptions().queryKey, {
	data: probe
		? [
				{
					...request({
						id: "00000000-0000-4000-8000-0000000000b1",
						title:
							"Run skill: nightly-check improvement abc12345. Nothing has run yet; approving allows one identical retry of this call.",
						appSlug: "tedix-unified",
						toolName: "cto__run_skill_workflow",
						hoursAgo: 1,
					}),
					actionType: "mcp.tool_call",
					payload: {
						kind: "mcp_tool_call",
						appSlug: "tedix-unified",
						target: { transport: "rpc", endpoint: "skills/runWorkflow" },
						args: { params: { probe: true } },
					},
				},
			]
		: activity
			? [
					request({
						id: "00000000-0000-4000-8000-0000000000b1",
						title: "example-unified:tedi_146194__run_skill_workflow",
						appSlug: "example-unified",
						toolName: "tedi_146194__run_skill_workflow",
						hoursAgo: 2,
					}),
					request({
						id: "00000000-0000-4000-8000-0000000000b2",
						title: "example-unified:tedi_146194__run_skill_workflow",
						appSlug: "example-unified",
						toolName: "tedi_146194__run_skill_workflow",
						hoursAgo: 1,
					}),
					request({
						id: "00000000-0000-4000-8000-0000000000b3",
						title:
							"Approve Kernel write: google_gmail.create_draft on google-gmail-tedix",
						appSlug: "google-gmail-tedix",
						toolName: "google_gmail.create_draft",
						riskTier: "high",
						hoursAgo: 4,
					}),
				]
			: [],
} as never);
client.setQueryData(approvalHistoryQueryOptions().queryKey, {
	data: activity
		? [
				request({
					id: "00000000-0000-4000-8000-0000000000d1",
					title: "Run work.create_work_items",
					appSlug: "tedix-unified",
					toolName: "work.create_work_items",
					status: "approved",
					resolvedBy: "policy",
					resolution: "autonomy v1: low risk",
					hoursAgo: 1,
				}),
				request({
					id: "00000000-0000-4000-8000-0000000000d2",
					title: "Update role",
					appSlug: "tedix",
					toolName: "connections.update_role",
					status: "rejected",
					resolvedBy: "person",
					resolution: "Rejected",
					hoursAgo: 5,
				}),
				request({
					id: "00000000-0000-4000-8000-0000000000d3",
					title: "Create file — title: October review",
					appSlug: "google-drive-tedix",
					toolName: "google_drive.create_file",
					status: "expired",
					hoursAgo: 30,
				}),
			]
		: [],
	pagination: { total: activity ? 3 : 0, limit: 50, offset: 0, hasMore: false },
} as never);
client.setQueryData(approvalRulesQueryOptions().queryKey, {
	items: activity
		? [
				{
					id: "00000000-0000-4000-8000-0000000000e1",
					organizationId: "org",
					actionKind: "home.tool_write",
					toolSlug: "example-crm.crm.add_note",
					verb: "add",
					decision: "approve",
					enabled: true,
					createdByKind: "user",
					createdById: "person",
					createdAt: at(-48),
					disabledAt: null,
				},
			]
		: [],
} as never);
const principal = (label: string) => ({
	id: label,
	type: "tedi",
	label,
	secondary: null,
	slug: null,
	avatarUrl: null,
	unresolved: false,
});
client.setQueryData(recentToolActivityQueryOptions().queryKey, {
	items: activity
		? [
				{
					timestamp: at(-0.5),
					actorId: "ops",
					actorType: "tedi",
					actor: principal("Ops"),
					subject: null,
					agent: null,
					attribution: {},
					identityCoverage: { warnings: [] },
					action: "mcp.tool.execute",
					success: false,
					toolName: "crm.add_note",
					tool: null,
					appId: "app-1",
					app: {
						id: "app-1",
						label: "Example CRM",
						slug: null,
						unresolved: false,
					},
					executionId: null,
					traceId: "trace-1",
					clientId: null,
					delegationMode: null,
					durationMs: 120,
					errorCode: "TIMEOUT",
					securityDecision: {
						disposition: "executed",
						denialReason: null,
						httpStatus: null,
						mcpMethod: null,
						riskTier: "bounded_write",
					},
				},
			]
		: [],
} as never);
client.setQueryData(pendingHomeDelegationsQueryOptions().queryKey, {
	runSet: {
		organizationId: "org",
		conversationId: "__pending-home-delegations__",
		activeRunIds: [],
		approvalMirrors: {},
		updatedAt: null,
		runs: empty
			? []
			: [
					held({
						id: "00000000-0000-4000-8000-0000000000a1",
						tedi: "00000000-0000-4000-8000-0000000000c1",
						label: "CFO",
						reason: "human-reserved: money, external_message",
						request:
							"Create the sevDesk invoice draft for Example GmbH, EUR 8,000 net, 7-day payment terms. Draft only.",
						createdHoursAgo: 3,
					}),
					held({
						id: "00000000-0000-4000-8000-0000000000a2",
						tedi: "00000000-0000-4000-8000-0000000000c2",
						label: "CTO",
						reason: "high risk requires human approval",
						request:
							"Refactor the scheduler module and open a branch with the change and its tests.",
						createdHoursAgo: 20,
					}),
					held({
						id: "00000000-0000-4000-8000-0000000000a3",
						tedi: "00000000-0000-4000-8000-0000000000c2",
						label: "CTO",
						reason: "human-reserved: public_publish",
						request: "Publish the release notes for the October update.",
						createdHoursAgo: 1,
					}),
				],
	},
} as never);

createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<header style={{ display: "flex", justifyContent: "flex-end", padding: 8 }}>
			<ApprovalNotifications />
		</header>
	</QueryClientProvider>,
);
