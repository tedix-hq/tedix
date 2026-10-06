import type {
	SkillEntry,
	SkillSchedule,
} from "@tedix/api-contract/contracts/cognitive";
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
import type { CardRunLinkProps } from "./chat-cards";

const skillsApi = vi.hoisted(() => ({
	listByOrg: vi.fn(),
	listWorkflowSchedules: vi.fn(),
	runWorkflow: vi.fn(),
}));
const workflowsApi = vi.hoisted(() => ({
	listDefinitions: vi.fn(),
	listDefinitionHealth: vi.fn(),
}));
const tedisApi = vi.hoisted(() => ({ list: vi.fn() }));
const permissions = vi.hoisted(() => ({ canManage: true }));

vi.mock("@/lib/api", () => ({
	osApi: { skills: skillsApi, workflows: workflowsApi, tedis: tedisApi },
}));
vi.mock("@/lib/tedi-permissions", () => ({
	useCanManageTedis: () => permissions.canManage,
}));

// Catalog rows are real router links in the product. This component suite
// renders them without the application RouterProvider, so retain the anchor
// contract while isolating these tests from router context.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tanstack/react-router")>()),
	Link: ({
		to,
		params,
		children,
		className,
	}: {
		to: string;
		params?: Record<string, string>;
		children?: React.ReactNode;
		className?: string;
	}) => (
		<a
			className={className}
			href={params?.skillId ? `/skills/${params.skillId}` : to}
		>
			{children}
		</a>
	),
}));

import {
	buildSkillCatalogTree,
	driftTone,
	evidenceLabel,
	executableSkillIds,
	healthTone,
	lifecycleTone,
	scheduleSummary,
	SkillChip,
	SkillCatalogTree,
	skillOwnerLabel,
	SkillRow,
	SkillsEmpty,
	SkillsPage,
	WorkflowRow,
	workflowMetaLabel,
	WorkflowsEmpty,
} from "./skills-page";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SKILL_ID = "22222222-2222-4222-8222-222222222222";
const TEDI_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";

const baseSkill: SkillEntry = {
	id: SKILL_ID,
	organizationId: "org-1",
	tediId: null,
	title: "Weekly digest",
	slug: "weekly-digest",
	description: "Compile and send the weekly customer digest",
	content: "# Weekly digest…",
	successCount: 8,
	failureCount: 1,
	lastUsedAt: "2026-08-10T09:00:00.000Z",
	revision: 3,
	visibility: "org",
	lifecycleState: "proven",
	paceLayer: "differentiation",
	summary: "Sends the weekly digest",
};

const operatorSurfaceStatic = {
	namespace: "workflows",
	runTool: null,
	statusTool: "workflows_get_status",
	historyTool: "workflows_list_runs",
	revisionsTool: null,
	mutationMode: "deploy_main",
	mutationTool: null,
} as const;

const staticDefinition: WorkflowDefinition = {
	kind: "static_platform",
	id: "platform:memory_reflection",
	title: "Memory reflection",
	description: "Nightly memory consolidation",
	engine: "cloudflare_workflows",
	binding: "MEMORY_REFLECTION",
	entrypoint: "MemoryReflectionWorkflow",
	triggers: ["cron"],
	operatorSurface: operatorSurfaceStatic,
	scope: "platform",
	ownerKind: "platform",
	sourceKind: "deployed_entrypoint",
	workflowType: "memory_reflection",
	lifecycleState: "active",
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

const baseSchedule: SkillSchedule = {
	id: "55555555-5555-4555-8555-555555555555",
	organizationId: "org-1",
	skillId: SKILL_ID,
	tediId: TEDI_ID,
	cron: "0 9 * * 1",
	params: {},
	enabled: true,
	nextFireAt: "2026-08-17T09:00:00.000Z",
};

const StubRunLink = ({ params, children }: CardRunLinkProps) => (
	<a href={`/work/runs/${params.runId}`}>{children}</a>
);

describe("lifecycleTone", () => {
	it("maps every lifecycle state to an honest tone", () => {
		expect(lifecycleTone("draft")).toBe("neutral");
		expect(lifecycleTone("active")).toBe("active");
		expect(lifecycleTone("proven")).toBe("done");
		expect(lifecycleTone("crystallized")).toBe("done");
		expect(lifecycleTone("stale")).toBe("warn");
		expect(lifecycleTone("archived")).toBe("blocked");
		expect(lifecycleTone(null)).toBe("neutral");
		expect(lifecycleTone(undefined)).toBe("neutral");
	});
});

describe("executableSkillIds", () => {
	it("collects only dynamic_skill definition skillIds", () => {
		const ids = executableSkillIds([staticDefinition, dynamicDefinition]);
		expect(ids.has(SKILL_ID)).toBe(true);
		expect(ids.size).toBe(1);
	});
});

describe("workflow tones", () => {
	it("maps health statuses without alarming on dormant/unknown", () => {
		expect(healthTone("healthy")).toBe("done");
		expect(healthTone("active")).toBe("active");
		expect(healthTone("attention")).toBe("warn");
		expect(healthTone("degraded")).toBe("blocked");
		expect(healthTone("dormant")).toBe("neutral");
		expect(healthTone("unknown")).toBe("neutral");
	});

	it("keeps unobserved drift neutral — missing history is not failure", () => {
		expect(driftTone("in_sync")).toBe("done");
		expect(driftTone("unobserved")).toBe("neutral");
		expect(driftTone("not_applicable")).toBe("neutral");
		expect(driftTone("revision_mismatch")).toBe("warn");
		expect(driftTone("unexecuted_revision")).toBe("warn");
		expect(driftTone("unknown_revision")).toBe("warn");
		expect(driftTone("missing_execution_surface")).toBe("blocked");
	});
});

describe("labels", () => {
	it("counts usage evidence with honest empty and singular forms", () => {
		expect(evidenceLabel(baseSkill)).toBe("8 successes · 1 failure");
		expect(evidenceLabel({ successCount: 1, failureCount: 0 })).toBe(
			"1 success",
		);
		expect(evidenceLabel({ successCount: 0, failureCount: 0 })).toBe(
			"no recorded uses",
		);
	});

	it("names the owner or falls back to org baseline", () => {
		expect(skillOwnerLabel({ tediId: null })).toBe("org baseline");
		expect(skillOwnerLabel({ tediId: TEDI_ID })).toBe("a tedi");
		expect(skillOwnerLabel({ tediId: TEDI_ID }, { [TEDI_ID]: "Sana" })).toBe(
			"Sana",
		);
	});

	it("describes static definitions by workflow type and binding", () => {
		expect(workflowMetaLabel(staticDefinition)).toBe(
			"memory reflection · MEMORY_REFLECTION",
		);
	});

	it("describes dynamic definitions by skill slug, revision, and owner", () => {
		expect(workflowMetaLabel(dynamicDefinition, { [TEDI_ID]: "Sana" })).toBe(
			"weekly-digest · rev 3 · Sana",
		);
	});
});

describe("scheduleSummary", () => {
	it("is null with no schedules", () => {
		expect(scheduleSummary([])).toBeNull();
	});

	it("shows the cron for a single enabled schedule", () => {
		expect(scheduleSummary([baseSchedule])).toEqual({
			tone: "active",
			label: "scheduled · 0 9 * * 1",
		});
	});

	it("warns when an enabled schedule is failing or budget-blocked", () => {
		expect(
			scheduleSummary([{ ...baseSchedule, lastError: "boom" }])?.tone,
		).toBe("warn");
		expect(
			scheduleSummary([
				{ ...baseSchedule, lastBudgetBlockedAt: "2026-08-12T00:00:00.000Z" },
			])?.tone,
		).toBe("warn");
	});

	it("marks all-disabled schedules as off, not failing", () => {
		expect(scheduleSummary([{ ...baseSchedule, enabled: false }])).toEqual({
			tone: "neutral",
			label: "schedule off",
		});
	});

	it("counts multiple enabled schedules", () => {
		expect(
			scheduleSummary([
				baseSchedule,
				{ ...baseSchedule, id: "other", cron: "0 18 * * 5" },
			])?.label,
		).toBe("2 schedules");
	});
});

describe("SkillChip", () => {
	it("renders a Kumo Badge stamped with its tone", () => {
		const html = renderToStaticMarkup(<SkillChip tone="done">x</SkillChip>);
		expect(html).toContain('data-slot="badge"');
		expect(html).toContain('data-tone="done"');
	});
});

describe("SkillRow", () => {
	it("renders lifecycle, executable chip, title, provenance, and evidence", () => {
		const html = renderToStaticMarkup(
			<SkillRow skill={baseSkill} executable={true} />,
		);
		expect(html).toContain("Proven");
		expect(html).toContain("Executable");
		expect(html).toContain("Weekly digest");
		expect(html).toContain("weekly-digest · rev 3 · org baseline");
		expect(html).toContain("8 successes · 1 failure");
		expect(html).toContain("differentiation layer");
		expect(html).toContain("Sends the weekly digest");
		expect(html).toContain('dateTime="2026-08-10T09:00:00.000Z"');
		expect(html).toContain(`href="/skills/${SKILL_ID}"`);
		expect(html.indexOf("Weekly digest")).toBeLessThan(html.indexOf("Proven"));
		expect(html.indexOf("Proven")).toBeLessThan(html.indexOf("Open"));
		expect(html.match(/href=/g)).toHaveLength(1);
	});

	it("keeps a concise mobile summary while preserving full desktop provenance", () => {
		const html = renderToStaticMarkup(
			<SkillRow skill={baseSkill} executable={true} />,
		);
		expect(html).toContain("data-mobile-summary");
		expect(html).toContain("truncate tracking-[-0.1px] sm:hidden");
		expect(html).toContain("data-desktop-summary");
		expect(html).toContain("max-sm:hidden");
		expect(html).toContain("org baseline · 8 successes · 1 failure");
		expect(html).toContain("weekly-digest · rev 3 · org baseline");
	});

	it("marks instruction-only skills as Instructions", () => {
		const html = renderToStaticMarkup(
			<SkillRow skill={baseSkill} executable={false} />,
		);
		expect(html).toContain("Instructions");
		expect(html).not.toContain("Executable");
	});

	it("renders no execution chip while the workflow catalog is unresolved", () => {
		const html = renderToStaticMarkup(<SkillRow skill={baseSkill} />);
		expect(html).not.toContain("Instructions");
		expect(html).not.toContain("Executable");
	});

	it("names the owning tedi and omits absent nullable fields", () => {
		const html = renderToStaticMarkup(
			<SkillRow
				skill={{
					...baseSkill,
					tediId: TEDI_ID,
					lifecycleState: null,
					summary: null,
					description: null,
					lastUsedAt: null,
				}}
				tediNames={{ [TEDI_ID]: "Sana" }}
			/>,
		);
		expect(html).toContain("Sana");
		expect(html).not.toContain("Proven");
		expect(html).toContain("differentiation layer");
		expect(html).not.toContain("last used");
	});
});

describe("WorkflowRow", () => {
	it("renders kind, health, drift, schedule chips and the Activity run link", () => {
		const html = renderToStaticMarkup(
			<WorkflowRow
				definition={dynamicDefinition}
				health={dynamicHealth}
				schedules={[baseSchedule]}
				tediNames={{ [TEDI_ID]: "Sana" }}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain(">Skill<");
		expect(html).toContain("Healthy");
		expect(html).toContain("In sync");
		expect(html).toContain("Scheduled · 0 9 * * 1");
		expect(html).toContain("weekly-digest · rev 3 · Sana");
		expect(html).toContain("1 trigger");
		expect(html).toContain("last run completed");
		expect(html).toContain(`href="/work/runs/${RUN_ID}"`);
		expect(html).toContain("Run details");
		expect(html.indexOf("Weekly digest")).toBeLessThan(html.indexOf(">Skill<"));
	});

	it("never links platform run evidence into the skill-run Activity surface", () => {
		const html = renderToStaticMarkup(
			<WorkflowRow
				definition={staticDefinition}
				health={{
					...dynamicHealth,
					definitionId: staticDefinition.id,
					kind: "static_platform",
					latestRun: {
						...dynamicHealth.latestRun!,
						source: "workflow_run_ledger",
					},
				}}
				LinkComponent={StubRunLink}
			/>,
		);
		expect(html).toContain(">Platform<");
		expect(html).toContain("last run completed");
		expect(html).not.toContain("href=");
	});

	it("renders without health chips while the health read is unresolved", () => {
		const html = renderToStaticMarkup(
			<WorkflowRow definition={staticDefinition} LinkComponent={StubRunLink} />,
		);
		expect(html).toContain("Memory reflection");
		expect(html).not.toContain("Healthy");
		expect(html).not.toContain("last run");
	});
});

describe("empty states", () => {
	it("explains the empty skill catalog without implying failure", () => {
		expect(renderToStaticMarkup(<SkillsEmpty />)).toContain("No skills yet");
	});

	it("explains the empty workflow catalog and where runs land", () => {
		const html = renderToStaticMarkup(<WorkflowsEmpty />);
		expect(html).toContain("No automations yet");
		expect(html).toContain("Activity");
	});
});

// ---------------------------------------------------------------------------
// Page composition (mocked osApi)
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

function renderSkillsPage(
	props: React.ComponentProps<typeof SkillsPage> = {},
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
				<SkillsPage {...props} />
			</QueryClientProvider>,
		);
	});
	cleanups.push(() => {
		act(() => root.unmount());
		container.remove();
	});
	return container;
}

describe("skill catalog hierarchy", () => {
	it("projects catalog folders without changing skill identity", () => {
		const nested = {
			...baseSkill,
			id: "nested-skill",
			title: "Monthly digest",
			slug: "monthly-digest",
			folderPath: "operations/reports",
		};
		const tree = buildSkillCatalogTree([nested, baseSkill]);
		expect(tree.skills.map((skill) => skill.slug)).toEqual(["weekly-digest"]);
		expect(tree.children[0]).toMatchObject({
			name: "operations",
			path: "operations",
		});
		expect(tree.children[0]?.children[0]?.skills[0]).toMatchObject({
			slug: "monthly-digest",
			folderPath: "operations/reports",
		});
	});

	it("renders nested folder labels and skills with Kumo catalog rows", () => {
		const markup = renderToStaticMarkup(
			<SkillCatalogTree
				entries={[{ ...baseSkill, folderPath: "operations/reports" }]}
				executableIds={new Set([baseSkill.id])}
				executableResolved
				tediNames={{}}
			/>,
		);
		expect(markup).toContain('data-folder-path="operations"');
		expect(markup).toContain('data-folder-path="operations/reports"');
		expect(markup).toContain("Weekly digest");
		expect(markup).toContain("Executable");
	});
});

/** One macrotask tick is occasionally not enough for a query to settle. */
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

beforeEach(() => {
	permissions.canManage = true;
	for (const mock of [
		...Object.values(skillsApi),
		...Object.values(workflowsApi),
		...Object.values(tedisApi),
	]) {
		mock.mockReset();
	}
	skillsApi.listByOrg.mockResolvedValue({ entries: [], total: 0 });
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

describe("SkillsPage", () => {
	it("groups server result count and search in a Kumo toolbar", async () => {
		skillsApi.listByOrg.mockResolvedValue({ entries: [baseSkill], total: 21 });
		const onSearchChange = vi.fn();
		const container = renderSkillsPage({ onSearchChange });
		await flush();
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="Search skills"]',
		);
		expect(input?.closest('[data-slot="page-toolbar"]')).not.toBeNull();
		expect(
			container.querySelector('[aria-label="21 results"]')?.textContent,
		).toBe("21 results");
		expect(
			container.querySelector(
				'[data-slot="section-header"] [data-slot="badge"]',
			),
		).toBeNull();
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			setValue.call(input, "digest");
			input!.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onSearchChange).toHaveBeenCalledWith({ q: "digest", page: 1 });
	});

	it("shows bundle import only to managers on the skills section", async () => {
		const container = renderSkillsPage();
		await flush();
		expect(container.textContent).toContain("Import bundle");
		permissions.canManage = false;
		const readOnly = renderSkillsPage();
		await flush();
		expect(readOnly.textContent).not.toContain("Import bundle");
	});
	it("mounts Triggers as a URL-backed section without loading inactive panels", async () => {
		skillsApi.listByOrg.mockResolvedValue({ entries: [baseSkill], total: 1 });
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
			total: 1,
			offset: 0,
			limit: 20,
			nextOffset: null,
		});
		workflowsApi.listDefinitions.mockResolvedValue({
			definitions: [dynamicDefinition],
			counts: { total: 1 },
			truncated: false,
		});
		// latestRun stays null here: the run evidence chip renders a router Link,
		// and this harness mounts no RouterProvider — the linked path is covered
		// by the pure WorkflowRow tests above.
		workflowsApi.listDefinitionHealth.mockResolvedValue({
			health: [{ ...dynamicHealth, latestRun: null }],
		});
		const container = renderSkillsPage({
			search: { section: "triggers", q: "digest", page: 1 },
		});
		await flush();
		expect(skillsApi.listByOrg).not.toHaveBeenCalled();
		expect(skillsApi.listWorkflowSchedules).toHaveBeenCalledWith(
			{ limit: 20, offset: 0, query: "digest" },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("Triggers");
		expect(container.textContent).toContain("Run now");
		expect(container.textContent).toContain("weekly on Monday at 9 AM");
	});

	it("shows the honest trigger empty state when no schedules exist", async () => {
		const container = renderSkillsPage({
			search: { section: "triggers", q: "", page: 1 },
		});
		await flush();
		expect(container.textContent).toContain("No ambient triggers yet");
	});

	it("keeps workflow schedule enrichment independent from the definition page", async () => {
		skillsApi.listWorkflowSchedules.mockResolvedValue({
			schedules: [baseSchedule],
			total: 1,
			offset: 0,
			limit: 200,
			nextOffset: null,
		});
		workflowsApi.listDefinitions.mockResolvedValue({
			definitions: [dynamicDefinition],
			counts: { total: 21 },
			truncated: false,
		});
		workflowsApi.listDefinitionHealth.mockResolvedValue({
			health: [{ ...dynamicHealth, latestRun: null }],
		});

		const container = renderSkillsPage({
			search: { section: "workflows", q: "", page: 2 },
		});
		await flush();

		expect(workflowsApi.listDefinitions).toHaveBeenCalledWith(
			{ limit: 20, offset: 20 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(skillsApi.listWorkflowSchedules).toHaveBeenCalledWith(
			{ limit: 200, offset: 0 },
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.textContent).toContain("Scheduled · 0 9 * * 1");
	});
});
