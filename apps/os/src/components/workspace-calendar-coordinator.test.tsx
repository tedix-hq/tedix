import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	CalendarPreview,
	WorkspaceCalendarCoordinator,
	coordinatorStatusText,
	declaredCalendarTools,
	grantCoversCalendar,
	calendarSkillReady,
	compensationCandidates,
	type BoundCalendarResource,
} from "./workspace-calendar-coordinator";
import {
	osQuery,
	workspaceResourcesQueryOptions,
} from "@/lib/os-query-options";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const resource = {
	id: RESOURCE,
	workspaceId: WORKSPACE,
	connectionInstanceId: ACCOUNT,
	personalOwnerUserId: "owner",
	providerResourceId: "calendar",
	name: "Agency meetings",
	connectionScope: "user",
	resourceType: "calendar",
	status: "active",
} as BoundCalendarResource;
const grant = {
	id: "grant",
	ownerUserId: "owner",
	workspaceId: WORKSPACE,
	resourceId: RESOURCE,
	connectionInstanceId: ACCOUNT,
	providerResourceId: "calendar",
	tediId: "worker",
	skillId: "skill",
	skillRevision: 2,
	revokedAt: null,
	expiresAt: "2030-01-01T00:00:00Z",
	operations: ["read", "subscribe", "create", "update", "delete"],
	toolIds: ["list_events", "create_event"],
} as Parameters<typeof grantCoversCalendar>[0];
describe("calendar setup authority and status", () => {
	it("requires a live grant for the same resource/account/worker/revision/actions/tools", () => {
		const valid = (value = grant) =>
			grantCoversCalendar(
				value,
				resource,
				"worker",
				"skill",
				2,
				["create", "delete"],
				["list_events", "create_event"],
				Date.parse("2026-10-06T00:00:00Z"),
			);
		expect(valid()).toBe(true);
		for (const changed of [
			{ revokedAt: "2026-10-06" },
			{ expiresAt: "2020-01-01" },
			{ connectionInstanceId: "other" },
			{ ownerUserId: "other" },
			{ providerResourceId: "other" },
			{ workspaceId: "other" },
			{ resourceId: "other" },
			{ tediId: "other" },
			{ skillRevision: 3 },
			{ operations: ["read", "create"] },
			{ toolIds: ["list_events"] },
		])
			expect(valid({ ...grant, ...changed })).toBe(false);
	});
	it("does not equate active configuration with active notification monitoring", () => {
		expect(coordinatorStatusText("active", "not_installed")).toContain(
			"monitoring is not active",
		);
		expect(coordinatorStatusText("active", "needs_attention")).toContain(
			"needs attention",
		);
		expect(coordinatorStatusText("active", "active")).toContain(
			"incoming changes are monitored",
		);
		expect(coordinatorStatusText("preview", "active")).toContain("disabled");
	});
	it("projects only declared tools into the personal consent review", () => {
		expect(
			declaredCalendarTools(
				"---\ncapabilities:\n  mcp:\n    calendar: [list_events, create_event]\n---\n# Coordinate",
			),
		).toEqual(["list_events", "create_event"]);
	});
	it("admits only the selected worker's eligible executable reconciliation skill", () => {
		const skill = {
			tediId: "worker",
			lifecycleState: "active",
			content: "",
			files: {
				"scripts/workflow.ts": "export default async()=>{}",
				"SKILL.md":
					"---\ncapabilities:\n  mcp:\n    calendar_coordinator: [reconcile_calendar_subscription]\n---\n",
			},
		};
		expect(calendarSkillReady(skill, "worker")).toBe(true);
		for (const lifecycleState of ["proven", "crystallized"])
			expect(calendarSkillReady({ ...skill, lifecycleState }, "worker")).toBe(
				true,
			);
		for (const changed of [
			{ tediId: "other" },
			{ tediId: null },
			{ lifecycleState: "draft" },
			{ lifecycleState: "archived" },
			{ files: { "SKILL.md": skill.files["SKILL.md"] } },
			{
				files: {
					"scripts/workflow.ts": "workflow",
					"SKILL.md": "---\nmcp:\n  calendar:\n    - list_events\n---\n",
				},
			},
		])
			expect(calendarSkillReady({ ...skill, ...changed }, "worker")).toBe(
				false,
			);
	});
	it("offers undo only for server-confirmed eligible mutations and caps its batch", () => {
		const eligible = {
			actionId: "safe",
			state: "confirmed",
			compensationEligible: true,
		};
		expect(
			compensationCandidates([
				eligible,
				{ ...eligible, actionId: "deleted", compensationEligible: false },
				{ actionId: "legacy", state: "confirmed" },
				{ ...eligible, actionId: "unknown", state: "uncertain" },
			]),
		).toEqual(["safe"]);
		expect(
			compensationCandidates(
				Array.from({ length: 25 }, (_, i) => ({
					...eligible,
					actionId: String(i),
				})),
			),
		).toHaveLength(20);
	});

	it("renders a private blocker preview without source event IDs or payload JSON", () => {
		const plan = {
			id: "plan",
			configurationId: "config",
			configurationRevision: 1,
			purpose: "reconcile",
			complete: true,
			createdAt: "2026-10-06",
			window: { start: "2026-10-06T00:00:00Z", end: "2026-10-07T00:00:00Z" },
			conflicts: [],
			snapshotFingerprints: {},
			actions: [
				{
					id: "action",
					kind: "create",
					destinationKey: RESOURCE,
					sourceKey: "private-source-event",
					sourceRouteKey: "source",
					sourceEventId: "secret-meeting-id",
					sourceRevision: null,
					destinationEventId: "new",
					expectedDestinationRevision: null,
					ownership: "platform",
					before: null,
					after: { start: "2026-10-06T10:00:00Z", end: "2026-10-06T11:00:00Z" },
				},
			],
		} as Parameters<typeof CalendarPreview>[0]["plan"];
		const html = renderToStaticMarkup(
			<CalendarPreview plan={plan} resources={[resource]} />,
		);
		expect(html).toContain("Agency meetings");
		expect(html).toContain("has not changed any calendar");
		expect(html).toContain("Add Busy blocker");
		expect(html).not.toContain("secret-meeting-id");
		expect(html).not.toContain("private-source-event");
	});
	it("identifies an undo preview without exposing provider identifiers", () => {
		const html = renderToStaticMarkup(
			<CalendarPreview
				plan={{
					id: "plan",
					configurationId: "config",
					configurationRevision: 2,
					purpose: "compensate",
					complete: true,
					createdAt: "2026-10-06",
					window: {
						start: "2026-10-06T00:00:00Z",
						end: "2026-10-07T00:00:00Z",
					},
					actions: [],
					conflicts: [],
					snapshotFingerprints: {},
				}}
				resources={[]}
			/>,
		);
		expect(html).toContain("Proposed undo");
		expect(html).toContain("has not changed any calendar");
		expect(html).not.toContain("configurationId");
	});

	it("starts with enable/apply disabled and no raw account identifiers", () => {
		const queryClient = new QueryClient();
		queryClient.setQueryData(
			osQuery.calendarCoordinator.list.queryOptions({
				input: { workspaceId: WORKSPACE },
			}).queryKey,
			[],
		);
		queryClient.setQueryData(
			workspaceResourcesQueryOptions(WORKSPACE).queryKey,
			{ items: [], truncated: false },
		);
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<WorkspaceCalendarCoordinator workspaceId={WORKSPACE} />
			</QueryClientProvider>,
		);
		expect(html).toContain("Calendar blocking");
		expect(html).toContain("Personal access");
		expect(html).toContain("access expiry");
		expect(html).not.toContain("input JSON");
		expect(html).not.toContain(WORKSPACE);
		const container = document.createElement("div");
		container.innerHTML = html;
		const enable = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Enable blocker changes",
		);
		expect(enable?.disabled).toBe(true);
	});
});
