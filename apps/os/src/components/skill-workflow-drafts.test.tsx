import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
	SkillEntry,
	SkillRun,
	SkillRunSummary,
	SkillWorkflowToolCall,
} from "@tedix/api-contract/schemas/cognitive";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const harness = vi.hoisted(() => ({
	permissions: [] as string[],
	get: vi.fn(),
	listByOrg: vi.fn(),
	runWorkflowHistory: vi.fn(),
	runWorkflowStatus: vi.fn(),
	listRunArtifacts: vi.fn(),
	listWorkflowToolCalls: vi.fn(),
	getWorkflowRevision: vi.fn(),
	runWorkflow: vi.fn(),
	proposeWorkflowImprovement: vi.fn(),
	activateWorkflowImprovement: vi.fn(),
	rejectWorkshop: vi.fn(),
	tedisList: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
	osApi: {
		skills: {
			get: harness.get,
			listByOrg: harness.listByOrg,
			runWorkflowHistory: harness.runWorkflowHistory,
			runWorkflowStatus: harness.runWorkflowStatus,
			listRunArtifacts: harness.listRunArtifacts,
			listWorkflowToolCalls: harness.listWorkflowToolCalls,
			getWorkflowRevision: harness.getWorkflowRevision,
			runWorkflow: harness.runWorkflow,
			proposeWorkflowImprovement: harness.proposeWorkflowImprovement,
			activateWorkflowImprovement: harness.activateWorkflowImprovement,
			rejectWorkshop: harness.rejectWorkshop,
			listWorkflowRevisions: vi.fn(),
		},
		tedis: { list: harness.tedisList },
	},
}));
vi.mock("@/lib/use-os-preferences", () => ({
	useOsOperationalContext: () => ({
		data: {
			authority: { permissions: harness.permissions },
			organization: { id: "org-fixture" },
		},
	}),
}));
vi.mock("@tanstack/react-router", () => ({
	Link: (props: { children?: unknown }) => <a>{String(props.children)}</a>,
}));

import {
	describeCertification,
	findBaselineRun,
	isBaselineConflict,
	SkillRollbackButton,
	SkillWorkflowDrafts,
} from "./skill-workflow-drafts";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const baseline: SkillEntry = {
	id: "research-skill",
	organizationId: "org-fixture",
	tediId: "worker-1",
	title: "Research skill",
	content: "# Research",
	files: { "scripts/workflow.ts": "export default { run() { return 1; } };" },
	successCount: 0,
	failureCount: 0,
	visibility: "org",
	paceLayer: "innovation",
	revision: 4,
	lifecycleState: "active",
};
const draft: SkillEntry = {
	...baseline,
	id: "draft-1",
	title: "research-skill improvement abcd1234",
	files: { "scripts/workflow.ts": "export default { run() { return 2; } };" },
	lifecycleState: "draft",
	sourceSkillId: baseline.id,
	sourceRevision: 4,
	tags: ["workflow-improvement", "baseline-run:run-4"],
	revisionReasoning: "Workflow improvement proposed from run run-4. Score v2",
};
const run = (patch: Partial<SkillRunSummary>): SkillRunSummary => ({
	id: "run-4",
	organizationId: "org-fixture",
	skillId: baseline.id,
	tediId: "worker-1",
	workflowInstanceId: "wf",
	runtimeEnvironment: "production",
	lastReconciledAt: null,
	executionEpoch: 0,
	status: "completed",
	skillRevision: 4,
	startedAt: "2026-10-27T10:00:00Z",
	completedAt: "2026-10-27T10:05:00Z",
	hasResult: true,
	hasError: false,
	...patch,
});
const fullRun = (patch: Partial<SkillRun>): SkillRun => ({
	id: "test-1",
	organizationId: "org-fixture",
	skillId: draft.id,
	tediId: "worker-1",
	workflowInstanceId: "wf",
	runtimeEnvironment: "production",
	executionEpoch: 0,
	status: "completed",
	startedAt: "2026-10-27T11:00:00Z",
	completedAt: "2026-10-27T11:01:00Z",
	result: { certification: { passed: true } },
	certification: true,
	...patch,
});
const toolCall = (
	patch: Partial<SkillWorkflowToolCall>,
): SkillWorkflowToolCall =>
	({
		path: "calls/run/1.json",
		name: "post",
		count: 1,
		executionEpoch: 0,
		kind: "tool_call",
		outcome: "success",
		provenance: "step_artifact",
		mimeType: "application/json",
		sizeBytes: 10,
		namespace: "sheets",
		method: "append_rows",
		...patch,
	}) as SkillWorkflowToolCall;

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 8; tick += 1)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function mount(node: React.ReactNode) {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		),
	);
	await flush();
}
function button(text: string) {
	const result = [...document.querySelectorAll("button")].find((item) =>
		item.textContent?.includes(text),
	);
	if (!result) throw new Error(`Missing button: ${text}`);
	return result;
}
async function click(target: HTMLElement) {
	act(() => target.click());
	await flush();
}

beforeEach(() => {
	vi.resetAllMocks();
	harness.permissions = ["tedis:update"];
	harness.get.mockResolvedValue({ entry: baseline });
	harness.listByOrg.mockResolvedValue({ entries: [draft], total: 1 });
	harness.runWorkflowHistory.mockImplementation(async (input) => ({
		runs: input.skillId === baseline.id ? [run({})] : [],
	}));
	harness.runWorkflowStatus.mockResolvedValue(fullRun({}));
	harness.listRunArtifacts.mockResolvedValue({ artifacts: [] });
	harness.listWorkflowToolCalls.mockResolvedValue({
		toolCalls: [],
		truncated: false,
		nextOffset: null,
	});
	harness.tedisList.mockResolvedValue({ data: [] });
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	client.clear();
	container.remove();
});

describe("certification verdicts in plain English", () => {
	it("passes only a completed run with certification and no failed call", () => {
		expect(describeCertification(fullRun({})).state).toBe("passed");
		expect(
			describeCertification(
				fullRun({ result: { certification: { status: "passed" } } }),
				[],
				[toolCall({})],
			).detail,
		).toContain("1 call, none failed");
	});
	it("names the failed call and explains the refusal", () => {
		const verdict = describeCertification(
			fullRun({}),
			[],
			[
				toolCall({
					outcome: "failure",
					error: { message: "quota exceeded" },
					attempt: 2,
				}),
			],
		);
		expect(verdict.state).toBe("blocked");
		expect(verdict.detail).toContain(
			"sheets.append_rows (attempt 2): quota exceeded",
		);
		expect(verdict.detail).toContain("no failed call");
	});
	it("blocks on a failed call receipt even when calls are not listed", () => {
		const verdict = describeCertification(
			fullRun({}),
			[{ path: "calls/run/3.json", outcome: "failure" }],
			[],
		);
		expect(verdict.state).toBe("blocked");
		expect(verdict.detail).toContain("calls/run/3.json");
	});
	it("explains a missing or failed certification result", () => {
		expect(describeCertification(fullRun({ result: {} })).detail).toContain(
			"did not return a passing test result",
		);
		expect(
			describeCertification(
				fullRun({ result: { certification: { passed: false } } }),
			).title,
		).toBe("Test finished without passing");
		expect(
			describeCertification(fullRun({ status: "failed", error: "boom" }))
				.detail,
		).toContain("boom");
		expect(describeCertification(fullRun({ status: "running" })).state).toBe(
			"running",
		);
		expect(describeCertification(null).state).toBe("none");
	});
});

describe("baseline run selection", () => {
	it("picks the newest finished run of the live revision only", () => {
		expect(
			findBaselineRun(
				[
					run({ id: "old", completedAt: "2026-10-01T00:00:00Z" }),
					run({
						id: "stale",
						skillRevision: 3,
						completedAt: "2026-10-30T00:00:00Z",
					}),
					run({ id: "live", status: "running", completedAt: null }),
					run({ id: "new", completedAt: "2026-10-27T00:00:00Z" }),
				],
				4,
			)?.id,
		).toBe("new");
		expect(findBaselineRun([run({ skillRevision: 3 })], 4)).toBeNull();
	});
	it("recognises the server's baseline conflict by code or wording", () => {
		expect(isBaselineConflict({ code: "CONFLICT", message: "x" })).toBe(true);
		expect(
			isBaselineConflict(
				new Error(
					"Baseline advanced from observed revision 3 to 4; execute the current revision before proposing an improvement",
				),
			),
		).toBe(true);
		expect(isBaselineConflict(new Error("Skill validation failed"))).toBe(
			false,
		);
	});
});

describe("drafts on the versions page", () => {
	it("shows nothing to a member without the update-tedis permission", async () => {
		harness.permissions = [];
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		expect(document.querySelector("[data-skill-workflow-drafts]")).toBeNull();
		expect(harness.listByOrg).not.toHaveBeenCalled();
	});

	it("groups adoption from structured data and keeps abandoned copies collapsed", async () => {
		harness.listByOrg.mockResolvedValue({
			entries: [
				draft,
				{
					...draft,
					id: "adopted",
					title: "Old adopted copy",
					lifecycleState: "archived",
					revisionReasoning: "Unrelated text which must not determine adoption",
					improvementAdoption: {
						activatedIntoRevision: 3,
						certificationRunId: "passed-run",
						adoptedAt: "2026-10-26T10:00:00Z",
						reason: "Reduce duplicate requests",
					},
				},
				{
					...draft,
					id: "rejected",
					title: "Rejected copy",
					lifecycleState: "archived",
					revisionReasoning:
						"Activated into canonical skill research-skill revision 99.",
				},
			],
			total: 3,
		});
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		expect(harness.listByOrg).toHaveBeenCalledWith(
			expect.objectContaining({ improvementsOf: baseline.id, offset: 0 }),
		);
		expect(document.body.textContent).toContain("Adopted (1)");
		expect(document.body.textContent).toContain("Adopted as revision 3");
		expect(document.body.textContent).toContain("Reduce duplicate requests");
		expect(document.body.textContent).toContain("View passed test run");
		expect(document.body.textContent).toContain("Waiting for review (1)");
		expect(document.body.textContent).not.toContain("Rejected copy");
		await click(button("Rejected or abandoned (1)"));
		expect(document.body.textContent).toContain("Rejected copy");
		expect(document.body.textContent).not.toContain("Adopted as revision 99");
	});

	it("rejects a waiting proposal through the existing review API", async () => {
		harness.rejectWorkshop.mockResolvedValue({
			entry: { ...draft, lifecycleState: "archived" },
		});
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		await click(button("Reject draft"));
		expect(harness.rejectWorkshop).toHaveBeenCalledWith(
			expect.objectContaining({ id: draft.id, reason: expect.any(String) }),
		);
	});

	it("can load history beyond the first page of this skill's improvements", async () => {
		harness.listByOrg.mockImplementation(async ({ offset }) => ({
			entries: offset
				? [{ ...draft, id: "later-copy", title: "Later proposal" }]
				: [draft],
			total: 2,
		}));
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		await click(button("Show more improvements"));
		expect(document.body.textContent).toContain("Later proposal");
		expect(harness.listByOrg).toHaveBeenCalledWith(
			expect.objectContaining({ improvementsOf: baseline.id, offset: 1 }),
		);
	});

	it("tests a draft with a certification run and switches it on after a pass", async () => {
		harness.runWorkflowHistory.mockImplementation(async (input) => ({
			runs:
				input.skillId === baseline.id
					? [run({})]
					: harness.runWorkflow.mock.calls.length
						? [run({ id: "test-1", skillId: draft.id })]
						: [],
		}));
		harness.runWorkflow.mockResolvedValue({
			runId: "test-1",
			workflowInstanceId: "wf",
			status: "queued",
			workItemId: null,
			deduplicated: false,
		});
		harness.activateWorkflowImprovement.mockResolvedValue({
			baseline: { ...baseline, revision: 5 },
			proposal: { ...draft, lifecycleState: "archived" },
			governance: {},
		});
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		expect(document.body.textContent).toContain("Based on revision 4");
		expect(document.body.textContent).toContain("Not tested yet");
		expect(button("Switch on").disabled).toBe(true);
		await click(button("Test this draft (dry run)"));
		expect(harness.runWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				skillId: draft.id,
				tediId: "worker-1",
				certification: true,
				confirmDestructive: true,
			}),
		);
		await flush();
		expect(document.body.textContent).toContain("Test passed");
		expect(button("Switch on").disabled).toBe(false);
		await click(button("Switch on"));
		expect(harness.activateWorkflowImprovement).toHaveBeenCalledWith(
			expect.objectContaining({ id: draft.id, certificationRunId: "test-1" }),
		);
		expect(document.body.textContent).toContain("revision 5 is live");
	});

	it("refuses to switch on after a failed call and says which one", async () => {
		harness.runWorkflowHistory.mockImplementation(async (input) => ({
			runs:
				input.skillId === draft.id
					? [run({ id: "test-1", skillId: draft.id })]
					: [run({})],
		}));
		harness.listWorkflowToolCalls.mockResolvedValue({
			toolCalls: [
				toolCall({ outcome: "failure", error: "403 from the sheet" }),
			],
			truncated: false,
			nextOffset: null,
		});
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		expect(document.body.textContent).toContain("one call failed");
		expect(document.body.textContent).toContain(
			"sheets.append_rows: 403 from the sheet",
		);
		expect(button("Switch on").disabled).toBe(true);
		expect(button("Test again (dry run)").disabled).toBe(false);
	});

	it("offers the dry run of the current version when no baseline run exists, then saves the draft", async () => {
		let dispatched = false;
		harness.runWorkflowHistory.mockImplementation(async (input) => ({
			runs:
				input.skillId === baseline.id && dispatched
					? [run({ id: "base-now" })]
					: [],
		}));
		harness.listByOrg.mockResolvedValue({ entries: [], total: 0 });
		harness.runWorkflow.mockImplementation(async () => {
			dispatched = true;
			return {
				runId: "base-now",
				workflowInstanceId: "wf",
				status: "queued",
				workItemId: null,
				deduplicated: false,
			};
		});
		harness.proposeWorkflowImprovement.mockResolvedValue({
			proposal: draft,
			validation: { valid: true, errors: [], warnings: [] },
			governance: {},
		});
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		await click(button("New draft"));
		expect(document.body.textContent).toContain(
			"Revision 4 has no finished run yet",
		);
		expect(button("Save draft").disabled).toBe(true);
		await click(button("Run the current version first (dry run)"));
		expect(harness.runWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				skillId: baseline.id,
				tediId: "worker-1",
				certification: true,
			}),
		);
		await flush();
		const source = document.querySelector(
			'[aria-label="Draft automation source"]',
		) as HTMLTextAreaElement;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		for (const [label, value] of [
			["Draft automation source", "export default { run() { return 2; } };"],
			["Draft change reason", "Score with the v2 rubric"],
		]) {
			const target = document.querySelector(
				`[aria-label="${label}"]`,
			) as HTMLTextAreaElement;
			act(() => {
				setter.call(target, value);
				target.dispatchEvent(new Event("input", { bubbles: true }));
			});
		}
		await flush();
		expect(source.value).toContain("return 2");
		expect(button("Save draft").disabled).toBe(false);
		await click(button("Save draft"));
		expect(harness.proposeWorkflowImprovement).toHaveBeenCalledWith({
			baselineRunId: "base-now",
			reason: "Score with the v2 rubric",
			content: "# Research",
			files: {
				"scripts/workflow.ts": "export default { run() { return 2; } };",
			},
		});
		expect(document.body.textContent).toContain("Draft saved");
	});

	it("shows the server's real reason when a draft cannot be saved", async () => {
		harness.listByOrg.mockResolvedValue({ entries: [], total: 0 });
		harness.proposeWorkflowImprovement.mockRejectedValue(
			Object.assign(new Error("Skill validation failed: WORKFLOW_SYNTAX"), {
				code: "BAD_REQUEST",
				data: {
					errors: [
						{
							code: "WORKFLOW_SYNTAX",
							message: "Unexpected token at line 3",
							path: "scripts/workflow.ts",
						},
					],
					warnings: [],
				},
			}),
		);
		await mount(<SkillWorkflowDrafts skillId={baseline.id} />);
		await click(button("New draft"));
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)!.set!;
		for (const [label, value] of [
			["Draft automation source", "export default {"],
			["Draft change reason", "Try a broken draft"],
		]) {
			const target = document.querySelector(
				`[aria-label="${label}"]`,
			) as HTMLTextAreaElement;
			act(() => {
				setter.call(target, value);
				target.dispatchEvent(new Event("input", { bubbles: true }));
			});
		}
		await flush();
		await click(button("Save draft"));
		expect(document.body.textContent).toContain("The draft could not be saved");
		expect(document.body.textContent).toContain(
			"WORKFLOW_SYNTAX: Unexpected token at line 3 (scripts/workflow.ts)",
		);
	});
});

describe("roll back", () => {
	it("restores an earlier revision's pinned files as a new draft", async () => {
		harness.getWorkflowRevision.mockResolvedValue({
			provenance: "observed_executed_run",
			revision: {},
			workflowSource: "export default { run() { return 0; } };",
			skillDoc: "# Research v3",
		});
		await mount(
			<SkillRollbackButton baseline={baseline} runId="run-3" revision={3} />,
		);
		await click(button("Roll back to revision 3"));
		expect(harness.getWorkflowRevision).toHaveBeenCalledWith({
			runId: "run-3",
			includeSource: true,
		});
		expect(document.body.textContent).toContain("restores revision 3");
		expect(
			(
				document.querySelector(
					'[aria-label="Draft automation source"]',
				) as HTMLTextAreaElement
			).value,
		).toContain("return 0");
		expect(
			(
				document.querySelector(
					'[aria-label="Draft change reason"]',
				) as HTMLTextAreaElement
			).value,
		).toContain("Roll back to revision 3");
		expect(button("Save draft").disabled).toBe(false);
	});
	it("is not offered without the permission", async () => {
		harness.permissions = [];
		await mount(
			<SkillRollbackButton baseline={baseline} runId="run-3" revision={3} />,
		);
		expect(document.querySelector("button")).toBeNull();
	});
});
