import type { SkillSchedule } from "@tedix/api-contract/contracts/cognitive";
import type {
	WorkflowDefinition,
	WorkflowDefinitionHealth,
} from "@tedix/api-contract/contracts/workflows";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const skillsApi = vi.hoisted(() => ({
	listWorkflowSchedules: vi.fn(),
	runWorkflow: vi.fn(),
	// Run-now invalidates the run-history family by its generated key, which
	// resolves through the client proxy — the leaf has to exist on the mock.
	runWorkflowHistory: vi.fn(),
}));
const workflowsApi = vi.hoisted(() => ({
	listDefinitions: vi.fn(),
	listDefinitionHealth: vi.fn(),
}));
const tedisApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/api", () => ({
	osApi: { skills: skillsApi, workflows: workflowsApi, tedis: tedisApi },
}));

import {
	cronToHuman,
	dynamicDefinitionsBySkillId,
	sortTriggers,
	TriggerChip,
	TriggerRow,
	TriggersEmpty,
	TriggersPanel,
	triggerTitle,
} from "./triggers-panel";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_ID = "22222222-2222-4222-8222-222222222222";
const TEDI_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const SCHEDULE_ID = "55555555-5555-4555-8555-555555555555";

const baseSchedule: SkillSchedule = {
	id: SCHEDULE_ID,
	organizationId: "org-1",
	skillId: SKILL_ID,
	tediId: TEDI_ID,
	cron: "0 9 * * 1",
	params: { channel: "digest" },
	enabled: true,
	nextFireAt: "2026-08-17T09:00:00.000Z",
	lastFireAt: "2026-08-10T09:00:00.000Z",
};

const dynamicDefinition: WorkflowDefinition = {
	kind: "dynamic_skill",
	id: `skill:${SKILL_ID}`,
	title: "Weekly digest",
	description: "Runs the weekly digest workflow",
	engine: "cloudflare_workflows",
	binding: "SKILL_WORKFLOW",
	entrypoint: "SkillWorkflow",
	triggers: ["schedule"],
	operatorSurface: {
		namespace: "skills",
		runTool: "run_skill_workflow",
		statusTool: "run_skill_workflow_status",
		historyTool: "run_skill_workflow_history",
		revisionsTool: "list_skill_revisions",
		mutationMode: "governed_skill_revision",
		mutationTool: "improve_skills",
	},
	scope: "organization",
	ownerKind: "tenant",
	sourceKind: "revisioned_skill_source",
	skillId: SKILL_ID,
	skillSlug: "weekly-digest",
	skillRevision: 3,
	tediId: TEDI_ID,
	lifecycleState: "proven",
	updatedAt: "2026-08-12T09:00:00.000Z",
};

const staticDefinition: WorkflowDefinition = {
	kind: "static_platform",
	id: "platform:memory_reflection",
	title: "Memory reflection",
	description: "Nightly memory consolidation",
	engine: "cloudflare_workflows",
	binding: "MEMORY_REFLECTION",
	entrypoint: "MemoryReflectionWorkflow",
	triggers: ["cron"],
	operatorSurface: {
		namespace: "workflows",
		runTool: null,
		statusTool: "workflows_get_status",
		historyTool: "workflows_list_runs",
		revisionsTool: null,
		mutationMode: "deploy_main",
		mutationTool: null,
	},
	scope: "platform",
	ownerKind: "platform",
	sourceKind: "deployed_entrypoint",
	workflowType: "memory_reflection",
	lifecycleState: "active",
};

const dynamicHealth: WorkflowDefinitionHealth = {
	definitionId: dynamicDefinition.id,
	title: "Weekly digest",
	kind: "dynamic_skill",
	lifecycleState: "proven",
	currentRevision: 3,
	healthStatus: "healthy",
	driftStatus: "in_sync",
	executionSurface: {
		kind: "skill_runtime_service",
		binding: "SKILL_WORKFLOW",
		available: true,
		checkedAt: "2026-08-13T00:00:00.000Z",
	},
	latestRun: {
		id: RUN_ID,
		status: "completed",
		startedAt: "2026-08-12T09:00:00.000Z",
		completedAt: "2026-08-12T09:05:00.000Z",
		observedRevision: 3,
		lastReconciledAt: null,
		source: "skill_runs_snapshot",
	},
	notes: [],
};

// ---------------------------------------------------------------------------
// cronToHuman
// ---------------------------------------------------------------------------

describe("cronToHuman", () => {
	it("translates the common frequency shapes", () => {
		expect(cronToHuman("* * * * *")).toBe("every minute");
		expect(cronToHuman("*/5 * * * *")).toBe("every 5 minutes");
		expect(cronToHuman("15 * * * *")).toBe("hourly at :15");
		expect(cronToHuman("0 */6 * * *")).toBe("every 6 hours");
	});

	it("translates daily times in the 12-hour dialect", () => {
		expect(cronToHuman("0 9 * * *")).toBe("daily at 9 AM");
		expect(cronToHuman("30 18 * * *")).toBe("daily at 6:30 PM");
		expect(cronToHuman("0 0 * * *")).toBe("daily at 12 AM");
		expect(cronToHuman("0 12 * * *")).toBe("daily at 12 PM");
	});

	it("translates weekly, weekday, weekend, and listed days", () => {
		expect(cronToHuman("0 9 * * 1")).toBe("weekly on Monday at 9 AM");
		expect(cronToHuman("0 9 * * MON")).toBe("weekly on Monday at 9 AM");
		expect(cronToHuman("0 0 * * 7")).toBe("weekly on Sunday at 12 AM");
		expect(cronToHuman("0 9 * * 1-5")).toBe("weekdays at 9 AM");
		expect(cronToHuman("0 9 * * 0,6")).toBe("weekends at 9 AM");
		expect(cronToHuman("0 9 * * 1,3")).toBe("on Monday, Wednesday at 9 AM");
		expect(cronToHuman("0 9 * * 2-4")).toBe("Tuesday through Thursday at 9 AM");
	});

	it("translates monthly day-of-month schedules", () => {
		expect(cronToHuman("0 9 1 * *")).toBe("monthly on day 1 at 9 AM");
	});

	it("falls back to the raw expression for anything it cannot honestly paraphrase", () => {
		expect(cronToHuman("0 9 * 2 *")).toBe("0 9 * 2 *"); // month restriction
		expect(cronToHuman("0 9 1 * 1")).toBe("0 9 1 * 1"); // dom+dow OR semantics
		expect(cronToHuman("0 0 0 * * *")).toBe("0 0 0 * * *"); // six fields
		expect(cronToHuman("99 * * * *")).toBe("99 * * * *"); // out of range
		expect(cronToHuman("0 25 * * *")).toBe("0 25 * * *"); // out of range
		expect(cronToHuman("not a cron")).toBe("not a cron");
		expect(cronToHuman("0 9 * * 9")).toBe("0 9 * * 9"); // bad weekday
	});
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("dynamicDefinitionsBySkillId", () => {
	it("keys only dynamic_skill definitions by their skill id", () => {
		const map = dynamicDefinitionsBySkillId([
			staticDefinition,
			dynamicDefinition,
		]);
		expect(map[SKILL_ID]?.id).toBe(dynamicDefinition.id);
		expect(Object.keys(map)).toHaveLength(1);
	});
});

describe("triggerTitle", () => {
	it("uses the workflow definition title when the catalog resolved it", () => {
		expect(triggerTitle(baseSchedule, dynamicDefinition)).toBe("Weekly digest");
	});

	it("falls back to the short skill id without a definition", () => {
		expect(triggerTitle(baseSchedule)).toBe(`skill ${SKILL_ID.slice(0, 8)}`);
	});
});

describe("sortTriggers", () => {
	it("puts enabled triggers first, each group by soonest next fire", () => {
		const disabled = {
			...baseSchedule,
			id: "a",
			enabled: false,
			nextFireAt: "2026-08-15T00:00:00.000Z",
		};
		const later = {
			...baseSchedule,
			id: "b",
			nextFireAt: "2026-08-20T00:00:00.000Z",
		};
		const sorted = sortTriggers([disabled, later, baseSchedule]);
		expect(sorted.map((schedule) => schedule.id)).toEqual([
			SCHEDULE_ID,
			"b",
			"a",
		]);
	});
});

// ---------------------------------------------------------------------------
// Presentational components
// ---------------------------------------------------------------------------

describe("TriggerChip", () => {
	it("renders a Kumo Badge stamped with its tone", () => {
		const html = renderToStaticMarkup(<TriggerChip tone="warn">x</TriggerChip>);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="warn"');
	});
});

describe("TriggerRow", () => {
	it("renders state, last-run chip, title, cadence, next run, owner, and Run now", () => {
		const html = renderToStaticMarkup(
			<TriggerRow
				schedule={baseSchedule}
				definition={dynamicDefinition}
				health={dynamicHealth}
				tediNames={{ [TEDI_ID]: "Sana" }}
			/>,
		);
		expect(html).toContain(">On<");
		expect(html).toContain('data-status="completed"');
		expect(html).toContain("Weekly digest");
		expect(html).toContain("weekly on Monday at 9 AM");
		expect(html).toContain('dateTime="2026-08-17T09:00:00.000Z"');
		expect(html).toContain("Sana");
		expect(html).toContain("last fired");
		expect(html).toContain("Run now");
	});

	it("renders a read-only Off chip for disabled schedules — no fake pause verb", () => {
		const html = renderToStaticMarkup(
			<TriggerRow schedule={{ ...baseSchedule, enabled: false }} />,
		);
		expect(html).toContain(">Off<");
		expect(html).not.toContain(">On<");
	});

	it("warns on lastError and budget blocks only while enabled", () => {
		const failing = renderToStaticMarkup(
			<TriggerRow
				schedule={{
					...baseSchedule,
					lastError: "boom",
					lastBudgetBlockedAt: "2026-08-12T00:00:00.000Z",
				}}
			/>,
		);
		expect(failing).toContain("Last fire failed");
		expect(failing).toContain("Budget blocked");
		const disabled = renderToStaticMarkup(
			<TriggerRow
				schedule={{ ...baseSchedule, enabled: false, lastError: "boom" }}
			/>,
		);
		expect(disabled).not.toContain("Last fire failed");
	});

	it("renders no last-run chip while health is unresolved", () => {
		const html = renderToStaticMarkup(
			<TriggerRow schedule={baseSchedule} definition={dynamicDefinition} />,
		);
		expect(html).not.toContain("data-status=");
	});
});

describe("TriggersEmpty", () => {
	it("points at skill authoring instead of implying failure", () => {
		const html = renderToStaticMarkup(<TriggersEmpty />);
		expect(html).toContain("No ambient triggers yet");
		expect(html).toContain("skill");
	});
});

// ---------------------------------------------------------------------------
// Panel behavior (mocked osApi)
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderPanel(
	props: React.ComponentProps<typeof TriggersPanel> = {},
): HTMLElement {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<TriggersPanel {...props} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function findButton(container: Element, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((button) =>
		(button.textContent ?? "").includes(label),
	);
	if (!match) throw new Error(`button not found: ${label}`);
	return match;
}

function click(element: HTMLElement) {
	act(() => {
		element.click();
	});
}

beforeEach(() => {
	for (const mock of [
		...Object.values(skillsApi),
		...Object.values(workflowsApi),
		...Object.values(tedisApi),
	]) {
		mock.mockReset();
	}
	skillsApi.listWorkflowSchedules.mockResolvedValue({
		schedules: [],
		total: 0,
		offset: 0,
		limit: 20,
		nextOffset: null,
	});
	workflowsApi.listDefinitions.mockResolvedValue({
		definitions: [],
		counts: { total: 0 },
		truncated: false,
	});
	workflowsApi.listDefinitionHealth.mockResolvedValue({ health: [] });
	tedisApi.list.mockResolvedValue({ data: [] });
});

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

describe("TriggersPanel", () => {
	it("renders every schedule as a trigger row with its workflow name", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
			total: 1,
			offset: 0,
			limit: 20,
			nextOffset: null,
		});
		workflowsApi.listDefinitions.mockResolvedValue({
			definitions: [staticDefinition, dynamicDefinition],
			counts: { total: 2 },
			truncated: false,
		});
		workflowsApi.listDefinitionHealth.mockResolvedValue({
			health: [dynamicHealth],
		});
		tedisApi.list.mockResolvedValue({
			data: [{ id: TEDI_ID, name: "sana", displayName: "Sana" }],
		});
		const container = renderPanel();
		await flush();
		expect(skillsApi.listWorkflowSchedules).toHaveBeenCalledWith(
			{ limit: 20, offset: 0 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(workflowsApi.listDefinitions).toHaveBeenCalledWith(
			{ limit: 200, offset: 0 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("Weekly digest");
		expect(container.textContent).toContain("weekly on Monday at 9 AM");
		expect(container.textContent).toContain("Sana");
		expect(container.innerHTML).toContain('data-status="completed"');
	});

	it("shows the honest empty state when no schedules exist", async () => {
		const container = renderPanel();
		await flush();
		expect(container.textContent).toContain("No ambient triggers yet");
	});

	it("surfaces the schedules read failure", async () => {
		skillsApi.listWorkflowSchedules.mockRejectedValue(new Error("nope"));
		const container = renderPanel();
		await flush();
		expect(container.textContent).toContain("Triggers are unavailable");
		expect(container.textContent).toContain("nope");
	});

	it("still lists triggers with fallback titles when the workflow catalog fails", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
		});
		workflowsApi.listDefinitions.mockRejectedValue(new Error("catalog down"));
		workflowsApi.listDefinitionHealth.mockRejectedValue(new Error("down"));
		const container = renderPanel();
		await flush();
		expect(container.textContent).toContain(`skill ${SKILL_ID.slice(0, 8)}`);
		expect(container.textContent).toContain("Run now");
	});

	it("dispatches Run now through skills.runWorkflow with the schedule identity", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
		});
		skillsApi.runWorkflow.mockResolvedValue({
			runId: RUN_ID,
			workflowInstanceId: "wf-1",
			status: "queued",
			workItemId: null,
			deduplicated: false,
		});
		const container = renderPanel();
		await flush();
		click(findButton(container, "Run now"));
		await flush();
		expect(skillsApi.runWorkflow).toHaveBeenCalledTimes(1);
		const input = skillsApi.runWorkflow.mock.calls[0]?.[0];
		expect(input).toMatchObject({
			skillId: SKILL_ID,
			tediId: TEDI_ID,
			params: { channel: "digest" },
			confirmDestructive: true,
		});
		expect(typeof input.idempotencyKey).toBe("string");
		expect(container.textContent).toContain(
			`Run ${RUN_ID.slice(0, 8)} dispatched`,
		);
	});

	it("reports a deduplicated dispatch honestly", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
		});
		skillsApi.runWorkflow.mockResolvedValue({
			runId: RUN_ID,
			workflowInstanceId: "wf-1",
			status: "running",
			workItemId: null,
			deduplicated: true,
		});
		const container = renderPanel();
		await flush();
		click(findButton(container, "Run now"));
		await flush();
		expect(container.textContent).toContain("already in flight");
	});

	it("surfaces a failed dispatch", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
		});
		skillsApi.runWorkflow.mockRejectedValue(new Error("budget exhausted"));
		const container = renderPanel();
		await flush();
		click(findButton(container, "Run now"));
		await flush();
		expect(container.textContent).toContain("Could not dispatch the run");
		expect(container.textContent).toContain("budget exhausted");
	});
});
