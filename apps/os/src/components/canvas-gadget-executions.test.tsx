import {
	focusManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { AppCallLogs } from "./app-call-logs";
import type { OsGadgetExecution } from "@tedix/api-contract/schemas/os-workspaces";
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

const api = vi.hoisted(() => ({
	tedis: { list: vi.fn() },
	osWorkspaces: {
		gadgets: { run: vi.fn() },
		executions: { list: vi.fn(), export: vi.fn() },
	},
}));

vi.mock("@/lib/api", () => ({ osApi: api }));

import {
	CanvasGadgetExecutions,
	executionStatusVariant,
	gadgetExecutionToolResult,
	parseExecutionInput,
	runStarter,
	runSummary,
} from "./canvas-gadget-executions";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GADGET_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TEDI_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXECUTION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function executionFixture(
	overrides: Partial<OsGadgetExecution> = {},
): OsGadgetExecution {
	return {
		id: EXECUTION_ID,
		organizationId: "org-1",
		workspaceId: WORKSPACE_ID,
		gadgetId: GADGET_ID,
		revisionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		revision: 3,
		status: "completed",
		grantedCapabilities: ["reports.read"],
		policyDecision: { allowed: true, reasons: [] },
		input: { region: "emea" },
		output: { summary: "ready" },
		error: null,
		costs: { totalUsd: 0.02 },
		evidenceRefs: ["artifact://report-1"],
		lineage: {
			runId: "run-1",
			workflowInstanceId: "workflow-1",
			tediId: TEDI_ID,
			workItemId: null,
			traceBundleId: "trace-1",
			billingReservationId: "billing-1",
			approvalRequestId: null,
			runtimeEnvironment: "production",
			agentSessionId: null,
			executionEpoch: 1,
		},
		createdByKind: "user",
		createdById: "user-1",
		createdAt: "2026-08-17T12:00:00.000Z",
		completedAt: "2026-08-17T12:01:00.000Z",
		...overrides,
	};
}

let container: HTMLDivElement;
let root: Root;

async function flush() {
	await act(async () => {
		for (let tick = 0; tick < 5; tick += 1) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	});
}

function renderPanel() {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<CanvasGadgetExecutions
					workspaceId={WORKSPACE_ID}
					gadgetId={GADGET_ID}
				/>
			</QueryClientProvider>,
		);
	});
}

async function chooseLevel(label: string) {
	const trigger = container.querySelector<HTMLElement>(
		'[aria-label="Log level"]',
	)!;
	await act(async () => trigger.click());
	const option = [
		...document.querySelectorAll<HTMLElement>('[role="option"]'),
	].find((candidate) => candidate.textContent?.includes(label));
	if (!option) throw new Error(`level not found: ${label}`);
	await act(async () => {
		option.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function submit() {
	const form = container.querySelector('form[aria-label="Run manually"]');
	if (!(form instanceof HTMLFormElement)) throw new Error("run form missing");
	form.requestSubmit();
}

function button(label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!match) throw new Error(`button not found: ${label}`);
	return match;
}

function openRow(text: string) {
	const row = [
		...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
	].find((candidate) => candidate.textContent?.includes(text));
	if (!row) throw new Error(`run row not found: ${text}`);
	act(() => row.click());
}

function setTextarea(value: string) {
	const textarea = container.querySelector('[aria-label="Input as JSON"]');
	if (!(textarea instanceof HTMLTextAreaElement)) {
		throw new Error("App input textarea missing");
	}
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value",
	)?.set;
	if (!setter) throw new Error("textarea value setter missing");
	act(() => {
		setter.call(textarea, value);
		textarea.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	api.tedis.list.mockReset();
	api.osWorkspaces.gadgets.run.mockReset();
	api.osWorkspaces.executions.list.mockReset();
	api.osWorkspaces.executions.export.mockReset();
	api.tedis.list.mockResolvedValue({
		data: [
			{
				id: TEDI_ID,
				name: "Operator",
				displayName: "Operations tedi",
				slug: "ops",
				status: "active",
			},
		],
		pagination: { limit: 50, offset: 0, total: 1, hasMore: false },
	});
	api.osWorkspaces.executions.list.mockResolvedValue({
		items: [executionFixture()],
		truncated: false,
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

describe("parseExecutionInput", () => {
	it("omits empty input and parses JSON", () => {
		expect(parseExecutionInput("   ")).toEqual({ ok: true });
		expect(parseExecutionInput('{"region":"emea"}')).toEqual({
			ok: true,
			value: { region: "emea" },
		});
	});

	it("reports invalid JSON", () => {
		const parsed = parseExecutionInput("{");
		expect(parsed.ok).toBe(false);
	});
});

describe("run wording", () => {
	const directory = new Map([["user:user-1", { name: "Robin Example" }]]);
	it("names who started a run the way a teammate would", () => {
		expect(
			runStarter(
				executionFixture({
					grantedCapabilities: ["app.call"],
					input: { method: "rateItem", args: [5] },
				}),
				directory,
			),
		).toBe("Robin clicked Rate item");
		expect(
			runStarter(
				executionFixture({ createdByKind: "service", createdById: "cron" }),
				directory,
			),
		).toBe("Scheduled");
		expect(runStarter(executionFixture(), directory)).toBe("Robin ran it");
	});
	it("summarizes the result, or why there is none, in one line", () => {
		expect(runSummary(executionFixture({ output: { count: 1 } }))).toBe(
			"count: 1",
		);
		expect(runSummary(executionFixture({ output: {} }))).toBe(
			"Finished with no output",
		);
		expect(
			runSummary(
				executionFixture({ status: "failed", error: "Quota hit\nstack" }),
			),
		).toBe("Quota hit");
	});
});

describe("executionStatusVariant", () => {
	it("maps admitted, approval, success and denial states", () => {
		expect(executionStatusVariant("running")).toBe("info");
		expect(executionStatusVariant("awaiting_approval")).toBe("warning");
		expect(executionStatusVariant("completed")).toBe("success");
		expect(executionStatusVariant("denied")).toBe("destructive");
	});
});

describe("gadgetExecutionToolResult", () => {
	it("projects canonical output and receipt lineage into MCP Apps data", () => {
		expect(gadgetExecutionToolResult(executionFixture())).toEqual({
			content: [{ type: "text", text: '{"summary":"ready"}' }],
			structuredContent: { summary: "ready" },
			_meta: {
				"tedix/execution": {
					id: EXECUTION_ID,
					revision: 3,
					status: "completed",
					runId: "run-1",
					workflowInstanceId: "workflow-1",
				},
			},
		});
	});

	it("omits a result until the runtime records output", () => {
		expect(gadgetExecutionToolResult(executionFixture({ output: null }))).toBe(
			undefined,
		);
	});
});

describe("CanvasGadgetExecutions", () => {
	it("lists runs in plain words and opens one for its result and technical details", async () => {
		const selected = vi.fn();
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<CanvasGadgetExecutions
						workspaceId={WORKSPACE_ID}
						gadgetId={GADGET_ID}
						onSelectedExecutionChange={selected}
					/>
				</QueryClientProvider>,
			);
		});
		await flush();

		expect(api.osWorkspaces.executions.list).toHaveBeenCalledWith(
			{
				workspaceId: WORKSPACE_ID,
				gadgetId: GADGET_ID,
				limit: 20,
				includeTraces: false,
			},
			// The contract-derived option forwards TanStack Query's AbortSignal, so
			// unmounting the panel cancels the in-flight read. The hand-written
			// queryFn this replaced passed no signal at all.
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const row = container.querySelector("button[aria-expanded]")!;
		expect(row.textContent).toContain("Done");
		expect(row.textContent).toContain("A teammate ran it");
		expect(row.textContent).toContain("summary: ready");
		expect(row.textContent).toContain("1m");
		const text = container.textContent ?? "";
		for (const jargon of ["receipt", "admission", "pinned", "admitted"])
			expect(text.toLowerCase()).not.toContain(jargon);
		expect(selected).toHaveBeenLastCalledWith(
			expect.objectContaining({ id: EXECUTION_ID }),
		);

		openRow("summary: ready");
		const details = container.querySelector("[data-execution-id]")!;
		expect(details.textContent).toContain("Version 3");
		expect(details.textContent).toContain("region");
		expect(details.textContent).toContain("emea");
		expect(details.textContent).not.toContain("run-1");
		act(() => button("Technical details").click());
		await flush();
		expect(details.textContent).toContain("run-1");
		expect(details.textContent).toContain('"totalUsd": 0.02');
		expect(details.textContent).toContain("artifact://report-1");
	});

	it("shows the empty state when the app has never run", async () => {
		api.osWorkspaces.executions.list.mockResolvedValue({
			items: [],
			truncated: false,
		});
		renderPanel();
		await flush();
		expect(container.textContent).toContain("No runs yet");
		expect(container.textContent).toContain(
			"Runs appear here when someone uses the app, a schedule runs, or you run it manually.",
		);
	});

	it("dispatches through the selected active tedi with parsed JSON", async () => {
		api.osWorkspaces.gadgets.run.mockResolvedValue({
			execution: executionFixture({
				id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
				status: "awaiting_approval",
				policyDecision: {
					allowed: false,
					reasons: ["human approval required"],
				},
				lineage: {
					...executionFixture().lineage,
					runId: null,
					approvalRequestId: "approval-1",
				},
			}),
		});
		renderPanel();
		await flush();
		act(() => button("Run manually").click());
		await flush();
		expect(container.textContent).toContain("Operations tedi");
		expect(container.textContent).not.toContain(TEDI_ID);
		act(() => button("Edit as JSON").click());
		setTextarea('{"region":"apac"}');
		act(() => submit());
		await flush();

		expect(api.osWorkspaces.gadgets.run).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			tediId: TEDI_ID,
			input: { region: "apac" },
			idempotencyKey: expect.any(String),
		});
		expect(container.textContent).toContain("Needs approval");
		expect(container.textContent).toContain("Waiting for approval");
		act(() => button("Technical details").click());
		await flush();
		expect(container.textContent).toContain("human approval required");
		expect(container.textContent).toContain("approval-1");
	});

	it("rejects invalid input before admission", async () => {
		renderPanel();
		await flush();
		act(() => button("Run manually").click());
		await flush();
		act(() => button("Edit as JSON").click());
		setTextarea("{");
		act(() => submit());
		await flush();

		expect(api.osWorkspaces.gadgets.run).not.toHaveBeenCalled();
		expect(container.textContent).toContain("Input is not valid JSON");
	});

	it("downloads only a declared format from the selected completed receipt", async () => {
		api.osWorkspaces.executions.export.mockResolvedValue({
			descriptor: {
				version: 1,
				id: "calendar",
				label: "Calendar (.ics)",
				artifactPath: "outputs/calendar.json",
				mimeType: "text/calendar",
				extension: "ics",
			},
			fileName: "inbox-triage-dddddddd.ics",
			sizeBytes: 42,
			url: "https://artifacts.tedix.test/skill-media/run-1/outputs/calendar.json?exp=1&sig=x",
			urlExpiresAt: "2026-08-17T12:05:00.000Z",
		});
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);
		const client = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		act(() => {
			root.render(
				<QueryClientProvider client={client}>
					<CanvasGadgetExecutions
						workspaceId={WORKSPACE_ID}
						gadgetId={GADGET_ID}
						exportDescriptors={[
							{
								version: 1,
								id: "calendar",
								label: "Calendar (.ics)",
								artifactPath: "outputs/calendar.json",
								mimeType: "text/calendar",
								extension: "ics",
							},
						]}
					/>
				</QueryClientProvider>,
			);
		});
		await flush();
		openRow("summary: ready");
		act(() => button("Calendar (.ics)").click());
		await flush();

		expect(api.osWorkspaces.executions.export).toHaveBeenCalledWith({
			workspaceId: WORKSPACE_ID,
			gadgetId: GADGET_ID,
			executionId: EXECUTION_ID,
			exportId: "calendar",
		});
		expect(click).toHaveBeenCalledOnce();
		click.mockRestore();
	});
});

describe("connection read receipts", () => {
	it("shows who read what, the access check, and restricted data", async () => {
		api.osWorkspaces.executions.list.mockResolvedValue({
			items: [
				executionFixture({
					status: "completed",
					grantedCapabilities: ["connections.read"],
					policyDecision: {
						allowed: true,
						reasons: [
							"connection_observation",
							"own_access:no_linked_account",
							"own_access:would_deny",
						],
					},
					input: {
						kind: "connection_observation",
						toolId: "get_page",
						providerId: "notion",
						resourceName: "Roadmap",
						account: "organization",
						actingUserId: "user-2",
						ownAccess: "no_linked_account",
						mode: "audit",
						wouldDeny: true,
						containsRestrictedData: true,
					},
					output: null,
					costs: null,
				}),
			],
			truncated: false,
		});
		renderPanel();
		await flush();
		expect(container.textContent).toContain("Someone read Roadmap");
		openRow("Roadmap");
		const text = container.textContent ?? "";
		expect(text).toContain("Contains restricted data");
		expect(text).toContain("Roadmap in notion");
		expect(text).toContain("Organization account");
		expect(text).toContain(
			"They have no linked account (audit week: would be refused)",
		);
	});
});

describe("app call console logs", () => {
	function trace(
		id: string,
		callId: string,
		message: string,
	): OsGadgetExecution {
		return executionFixture({
			id,
			grantedCapabilities: [],
			policyDecision: { allowed: true, reasons: ["runtime_trace"] },
			output: {
				callId,
				events: [
					{
						timestamp: 1_000,
						logs: [
							{ level: "info", message },
							{ level: "warn", message: "careful" },
						],
						exceptions: [{ name: "Error", message: "failed call" }],
					},
				],
			},
		});
	}
	function renderLogs(callId = EXECUTION_ID) {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<AppCallLogs
						key={callId}
						workspaceId={WORKSPACE_ID}
						gadgetId={GADGET_ID}
						callId={callId}
					/>
				</QueryClientProvider>,
			),
		);
		return client;
	}
	it("selects the app call instead of a later trace and renders only its lines", async () => {
		const receipt = executionFixture({ grantedCapabilities: ["app.call"] });
		const logs = trace("trace-1", EXECUTION_ID, "hello");
		api.osWorkspaces.executions.list.mockImplementation(async (input) => ({
			items: input.callId
				? [trace("foreign", "other-call", "private"), logs]
				: [logs, receipt],
			truncated: false,
		}));
		renderPanel();
		await flush();
		openRow("Done");
		await flush();
		expect(api.osWorkspaces.executions.list).toHaveBeenCalledWith(
			{
				workspaceId: WORKSPACE_ID,
				gadgetId: GADGET_ID,
				limit: 200,
				callId: EXECUTION_ID,
			},
			expect.anything(),
		);
		const pane = container.querySelector('[role="log"]')!;
		expect(pane.textContent).toContain("hello");
		expect(pane.textContent).toContain("Error: failed call");
		expect(pane.textContent).not.toContain("private");
		await chooseLevel("Warnings");
		expect(pane.textContent).toContain("careful");
		expect(pane.textContent).not.toContain("hello");
		expect(pane.textContent).not.toContain("failed call");
		await chooseLevel("Errors");
		expect(pane.textContent).toContain("Error: failed call");
	});
	it("uses the final tail without duplicating the live console lines", async () => {
		const live = trace("live", EXECUTION_ID, "hello");
		live.output = {
			callId: EXECUTION_ID,
			events: [
				{
					live: true,
					timestamp: 1000,
					sequence: 1,
					logs: [{ level: "info", message: "hello" }],
				},
			],
		};
		api.osWorkspaces.executions.list.mockResolvedValue({
			items: [live, trace("final", EXECUTION_ID, "hello")],
			truncated: false,
		});
		renderLogs();
		await flush();
		expect(
			container.querySelector('[role="log"]')?.textContent?.match(/hello/g),
		).toHaveLength(1);
	});
	it("polls for late traces after completion and pauses and resumes polling", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		focusManager.setFocused(true);
		try {
			api.osWorkspaces.executions.list.mockResolvedValue({
				items: [],
				truncated: false,
			});
			renderLogs();
			await flush();
			expect(container.textContent).toContain("Waiting for output…");
			api.osWorkspaces.executions.list.mockResolvedValue({
				items: [trace("trace-1", EXECUTION_ID, "late line")],
				truncated: false,
			});
			await act(async () => vi.advanceTimersByTimeAsync(2_500));
			await flush();
			expect(container.querySelector('[role="log"]')?.textContent).toContain(
				"late line",
			);
			act(() => button("Live").click());
			const calls = api.osWorkspaces.executions.list.mock.calls.length;
			await act(async () => vi.advanceTimersByTimeAsync(5_000));
			expect(api.osWorkspaces.executions.list).toHaveBeenCalledTimes(calls);
			act(() => button("Paused").click());
			await act(async () => vi.advanceTimersByTimeAsync(2_500));
			expect(
				api.osWorkspaces.executions.list.mock.calls.length,
			).toBeGreaterThan(calls);
		} finally {
			vi.useRealTimers();
			focusManager.setFocused(undefined);
		}
	});
	it("switches calls without carrying old console lines into the next run", async () => {
		api.osWorkspaces.executions.list.mockImplementation(async (input) => ({
			items: [
				trace(
					input.callId,
					input.callId,
					input.callId === EXECUTION_ID ? "first call" : "second call",
				),
			],
			truncated: true,
		}));
		renderLogs();
		await flush();
		expect(container.textContent).toContain("first call");
		renderLogs("ffffffff-ffff-4fff-8fff-ffffffffffff");
		await flush();
		expect(container.querySelector('[role="log"]')?.textContent).toContain(
			"second call",
		);
		expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
			"first call",
		);
		expect(container.textContent).toContain("Showing the latest lines only.");
	});
});
