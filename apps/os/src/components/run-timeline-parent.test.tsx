import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillWorkflowTimelineEvent } from "@tedix/api-contract/schemas/cognitive";
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

const reads = vi.hoisted(() => ({ artifact: vi.fn(), activity: vi.fn() }));
vi.mock("@/lib/os-query-options", () => ({
	workflowRunTimelineQueryOptions: (runId: string) => ({
		queryKey: ["timeline", runId],
		queryFn: async () => ({}),
	}),
	workflowRunArtifactQueryOptions: (runId: string, path: string) => ({
		queryKey: ["artifact", runId, path],
		queryFn: () => reads.artifact(path),
	}),
}));
vi.mock("@/components/run-tedi-activity", () => ({
	LinkedTediActivity: () => {
		reads.activity();
		return <p>linked activity</p>;
	},
}));
vi.mock("@/components/run-step-result", () => ({
	RunStepResult: ({ value }: { value: unknown }) => (
		<div>{typeof value === "string" ? value : JSON.stringify(value)}</div>
	),
	RunStepConversation: () => <p>conversation</p>,
}));
import { RunTimelineStep } from "./run-timeline";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const parentPath = "epochs/2/steps/x:review/4/attempts/3.json";
const childPath = "epochs/2/steps/x:review/4/attempts/3/calls/run/1.json";
const event = {
	schemaVersion: 1,
	id: childPath,
	path: childPath,
	executionEpoch: 2,
	kind: "mcp",
	name: "review",
	count: 7,
	attempt: 3,
	phase: "run",
	lane: "tedi",
	namespace: "tedi",
	method: "run_tedi_turn",
	startedAt: null,
	endedAt: null,
	durationMs: null,
	status: "succeeded",
	outcome: "success",
} as SkillWorkflowTimelineEvent;
const child = {
	kind: "workflow_mcp_call",
	executionEpoch: 2,
	attempt: 3,
	phase: "run",
	ordinal: 1,
	namespace: "tedi",
	method: "run_tedi_turn",
	step: { id: "step", name: "review", count: 7 },
	request: { value: { text: "private child input" } },
	response: { value: "private child result" },
};
const parent = {
	kind: "workflow_step_attempt",
	executionEpoch: 2,
	attempt: 3,
	step: { id: "step", name: "review", count: 4 },
	sensitiveOutput: false,
	authorMetadata: { purpose: "private parent purpose" },
};
let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
async function flush() {
	await act(async () => {
		for (let i = 0; i < 8; i++)
			await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
beforeEach(() => {
	vi.resetAllMocks();
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
	client.clear();
});
async function mount() {
	act(() =>
		root.render(
			<QueryClientProvider client={client}>
				<RunTimelineStep runId="run" event={event} />
			</QueryClientProvider>,
		),
	);
	await flush();
}
describe("parent step receipt access", () => {
	it("withholds child activity while the parent is loading", async () => {
		let resolveParent: ((value: unknown) => void) | undefined;
		reads.artifact.mockImplementation((path: string) =>
			path === childPath
				? Promise.resolve({ content: JSON.stringify(child) })
				: new Promise((resolve) => {
						resolveParent = resolve;
					}),
		);
		await mount();
		expect(host.textContent).toContain("Loading parent step details");
		expect(host.textContent).not.toContain("private child result");
		expect(host.textContent).not.toContain("linked activity");
		await act(async () => resolveParent?.({ content: JSON.stringify(parent) }));
		await flush();
		expect(host.textContent).toContain("private parent purpose");
		expect(host.textContent).toContain("private child result");
		expect(host.textContent).toContain("linked activity");
	});
	it.each(["parent", "child"] as const)(
		"withholds cached data after a %s receipt is denied on refetch",
		async (denied) => {
			let deny = false;
			reads.artifact.mockImplementation(async (path: string) => {
				if (deny && path === (denied === "parent" ? parentPath : childPath))
					throw new Error("Access denied");
				return { content: JSON.stringify(path === childPath ? child : parent) };
			});
			await mount();
			expect(host.textContent).toContain("private parent purpose");
			expect(host.textContent).toContain("private child result");
			const buttons = Array.from(host.querySelectorAll("button"));
			const inputButton = buttons.find((button) =>
				button.textContent?.includes("Recorded inputs and instructions"),
			);
			const detailsButton = buttons.find((button) =>
				button.textContent?.includes("Technical details"),
			);
			expect(inputButton).toBeDefined();
			expect(detailsButton).toBeDefined();
			await act(async () => {
				inputButton!.click();
				detailsButton!.click();
			});
			expect(host.textContent).toContain("private child input");
			const activityCalls = reads.activity.mock.calls.length;
			deny = true;
			await act(async () => {
				await client.invalidateQueries({
					queryKey: [
						"artifact",
						"run",
						denied === "parent" ? parentPath : childPath,
					],
				});
			});
			await flush();
			expect(host.textContent).not.toContain("private parent purpose");
			expect(host.textContent).not.toContain("private child input");
			expect(host.textContent).not.toContain("private child result");
			expect(host.textContent).not.toContain("linked activity");
			expect(reads.activity.mock.calls.length).toBe(activityCalls);
		},
	);
	it("withholds cached output and conversation after output access is denied", async () => {
		const outputPath = "outputs/review.json";
		const stepEvent = {
			...event,
			kind: "step",
			id: parentPath,
			path: parentPath,
			count: 4,
		} as SkillWorkflowTimelineEvent;
		const step = { ...parent, outputArtifactPath: outputPath };
		const output = {
			executionEpoch: 2,
			stepCount: 4,
			attempt: 3,
			value: {
				answer: "private output",
				tediId: "11111111-1111-4111-8111-111111111111",
				conversationId: "private-conversation",
			},
		};
		let denyOutput = false;
		reads.artifact.mockImplementation(async (path: string) => {
			if (path === outputPath && denyOutput) throw new Error("Access denied");
			return { content: JSON.stringify(path === outputPath ? output : step) };
		});
		act(() =>
			root.render(
				<QueryClientProvider client={client}>
					<RunTimelineStep runId="run" event={stepEvent} />
				</QueryClientProvider>,
			),
		);
		await flush();
		expect(host.textContent).toContain("private output");
		expect(host.textContent).toContain("conversation");
		const details = Array.from(host.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Technical details"),
		);
		expect(details).toBeDefined();
		await act(async () => details!.click());
		denyOutput = true;
		await act(async () => {
			await client.invalidateQueries({
				queryKey: ["artifact", "run", outputPath],
			});
		});
		await flush();
		expect(host.textContent).not.toContain("private output");
		expect(host.textContent).not.toContain("private-conversation");
		expect(host.textContent).not.toContain("conversation");
		expect(host.textContent).toContain("Output unavailable");
	});
});
