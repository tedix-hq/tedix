import type { AgentsConfig } from "@tedix/api-contract/schemas/os-session-apps";
import { WorkspaceAppRenderer } from "./workspace-app-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	projectListQueryOptions,
	workAgentSessionsQueryOptions,
} from "@/lib/os-query-options";
import { AgentStateBadge, filterAgentSessions } from "./work-agents-page";

const NOW = Date.parse("2026-06-15T12:34:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

type State = "needs_you" | "error" | "done" | "working" | "idle" | "ended";

const PROJECT_A = "00000076-0000-4000-8000-00000000000a";
const PROJECT_B = "00000076-0000-4000-8000-00000000000b";
const PROJECT_MISSING = "00000076-0000-4000-8000-0000000000ff";

function session(
	n: number,
	effectiveState: State,
	summary: string,
	projectId: string | null = null,
) {
	return {
		id: `0000000${n}-0000-4000-8000-000000000001`,
		harness: n % 2 ? ("claude-code" as const) : ("codex" as const),
		sessionKey: `session-${n}`,
		label: `repo-${n} · branch-${n}`,
		state: effectiveState === "idle" ? ("done" as const) : effectiveState,
		effectiveState,
		summary,
		projectId,
		workItemId: null,
		stateSince: ago(n * 5),
		lastEventAt: ago(n * 5),
	};
}

async function render(
	sessions: ReturnType<typeof session>[],
	config: AgentsConfig = { version: 1 },
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const counts = {
		needs_you: 0,
		error: 0,
		done: 0,
		working: 0,
		idle: 0,
		ended: 0,
	};
	for (const row of sessions) counts[row.effectiveState] += 1;
	client.setQueryData(
		workAgentSessionsQueryOptions(config.states?.includes("ended")).queryKey,
		{
			sessions,
			counts,
		},
	);
	client.setQueryData(projectListQueryOptions(100).queryKey, {
		data: [
			{ id: PROJECT_A, name: "Billing revamp" },
			{ id: PROJECT_B, name: "Docs refresh" },
		],
		pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
	} as never);
	const stream = await renderToReadableStream(
		<QueryClientProvider client={client}>
			<WorkspaceAppRenderer
				workspaceId={PROJECT_A}
				manifest={{ entry: "tedix:app/agents", capabilities: [], config }}
			/>
		</QueryClientProvider>,
	);
	await stream.allReady;
	const html = await new Response(stream).text();
	client.clear();
	return new DOMParser().parseFromString(html, "text/html");
}

describe("Agents board", () => {
	it("leads with the page title and keeps decision context collapsed", async () => {
		const doc = await render([
			session(1, "working", "Running tests", PROJECT_A),
		]);
		const app = doc.querySelector('[data-workspace-app-entry="agents"]')!;
		expect(app.firstElementChild?.querySelector("h1")?.textContent).toBe(
			"Agents",
		);
		expect(app.querySelector("[data-agent-state]")).not.toBeNull();
		const context = [...app.querySelectorAll("button")].find(
			(button) => button.textContent === "Decision context",
		)!;
		expect(context.getAttribute("aria-expanded")).toBe("false");
		expect(app.querySelector('[aria-label="Decision attention"]')).toBeNull();
	});

	it("shows the last observed time for inactive sessions without a device explanation", () => {
		const html = renderToStaticMarkup(
			<AgentStateBadge state="idle" lastSeenAt={ago(12)} now={new Date(NOW)} />,
		);
		expect(html).toContain("Inactive · last seen 12 min ago");
		expect(html).not.toMatch(/\b(laptop|offline|asleep|Lead|Aaron)\b/i);
	});
	it("polls every 10 seconds and on window focus", () => {
		const options = workAgentSessionsQueryOptions() as {
			refetchInterval?: unknown;
			refetchOnWindowFocus?: unknown;
		};
		expect(options.refetchInterval).toBe(10_000);
		expect(options.refetchOnWindowFocus).toBe(true);
	});

	it("groups sessions by project with unbound sessions last", async () => {
		const doc = await render([
			session(1, "working", "Running tests", PROJECT_B),
			session(2, "needs_you", "Approve the migration?"),
			session(3, "done", "Pushed to main", PROJECT_A),
			session(4, "idle", "Finished earlier", PROJECT_A),
			session(5, "ended", "Closed", PROJECT_A),
			session(6, "error", "Type-check failed", PROJECT_MISSING),
			session(7, "needs_you", "Which tax regime?", PROJECT_A),
		]);
		const sections = [...doc.querySelectorAll("section[aria-label]")].map(
			(node) => node.getAttribute("aria-label"),
		);
		expect(sections).toEqual([
			"Billing revamp",
			"Project unavailable",
			"Docs refresh",
			"No project",
		]);
		expect(doc.body.textContent).not.toContain("Closed");
		expect(doc.body.textContent).toContain("Local session (Claude)");
		expect(doc.body.textContent).toContain("Codex");
		const strip = doc.querySelector('[aria-label="Agent session counts"]');
		expect(strip?.textContent).toContain("Waiting on you2");
		expect(strip?.textContent).toContain("Blocked1");
	});

	it("keeps urgency order and a state badge inside a project group", async () => {
		const doc = await render([
			session(1, "working", "Running", PROJECT_A),
			session(2, "done", "Shipped", PROJECT_A),
			session(3, "needs_you", "Approve?", PROJECT_A),
		]);
		const group = doc.querySelector('section[aria-label="Billing revamp"]');
		const states = [...(group?.querySelectorAll("li") ?? [])].map((row) =>
			row.getAttribute("data-agent-state"),
		);
		expect(states).toEqual(["needs_you", "done", "working"]);
		expect(group?.textContent).toContain("Billing revamp (3)");
		expect(group?.querySelector("li")?.textContent).toContain("Waiting on you");
	});

	it("tints only needs_you and done rows and keeps the full summary on hover", async () => {
		const summary = "A very long summary ".repeat(8).trim();
		const doc = await render([
			session(1, "needs_you", summary),
			session(2, "error", "Type-check failed"),
			session(3, "done", "Shipped"),
			session(4, "working", "Running"),
		]);
		const tint = (state: string) =>
			doc.querySelector(`li[data-agent-state="${state}"]`)?.className ?? "";
		expect(tint("needs_you")).toContain("bg-kumo-warning-tint");
		expect(tint("done")).toContain("bg-kumo-success-tint");
		for (const state of ["error", "working"]) {
			expect(tint(state)).not.toMatch(/bg-kumo-(warning|success)-tint/);
		}
		expect(doc.querySelector(`[title="${summary}"]`)?.textContent).toBe(
			summary,
		);
	});

	it("collapses idle sessions inside their group by default", async () => {
		const doc = await render([session(4, "idle", "Quiet session summary")]);
		const group = doc.querySelector('section[aria-label="No project"]');
		expect(group?.textContent).toContain("Inactive (1)");
		expect(group?.querySelector("li")).toBeNull();
	});

	it("explains how to turn reporting on when no session reports", async () => {
		const doc = await render([session(5, "ended", "Closed")]);
		expect(doc.body.textContent).toContain("No agent sessions reporting");
		expect(doc.body.textContent).toContain("~/.tedix/agent-status.json");
		expect(doc.body.textContent).toContain('"enabled": true');
		expect(doc.querySelector("section[aria-label]")).toBeNull();
	});
});

it("shows measured lane facts, estimates and a daily roll-up", async () => {
	const lane = {
		...session(1, "done", "Done", PROJECT_A),
		telemetry: {
			executor: "codex",
			model: "fictional-model",
			provider: "openai",
			reasoningEffort: "medium",
			brief: "Fix a widget",
			startedAt: ago(1),
			finishedAt: ago(0),
			heartbeatAt: ago(0),
			outcome: "succeeded",
			finalMessage: "Fixed",
			tools: { Read: 2 },
			usage: { input: 100, cached: 80, output: 10, reasoning: 5 },
			shas: [],
			workItems: [],
			corrections: [],
			source: "import",
			estimatedCostUsd: 0.0123,
			rateVersionId: "fictional-rate",
			lesson: "Read the owning query",
			lessonStatus: "extracted",
		},
	};
	const doc = await render([lane]);
	expect(doc.body.textContent).toContain("fictional-model");
	expect(doc.body.textContent).toContain("110 tokens");
	expect(doc.body.textContent).toContain("$0.0123 estimated");
	expect(doc.body.textContent).toContain("100% executor success");
	expect(doc.body.textContent).toContain(
		"What we learned: Read the owning query",
	);
});

it("scopes configured projects, states and harnesses through the generic renderer", async () => {
	const doc = await render(
		[
			session(2, "working", "Selected lane", PROJECT_A),
			session(4, "error", "Wrong state", PROJECT_A),
			session(1, "working", "Wrong harness", PROJECT_A),
			session(6, "working", "Other project", PROJECT_B),
		],
		{
			version: 1,
			projectId: PROJECT_A,
			states: ["working"],
			harnesses: ["codex"],
		},
	);
	expect(
		doc.querySelector('[data-workspace-app-entry="agents"]'),
	).not.toBeNull();
	expect(doc.body.textContent).toContain("Selected lane");
	for (const hidden of ["Wrong state", "Wrong harness", "Other project"])
		expect(doc.body.textContent).not.toContain(hidden);
	expect(doc.querySelectorAll("li[data-agent-state]")).toHaveLength(1);
});
it("screen selections cannot widen manifest scope and recompute counts", () => {
	const sessions = [
		session(2, "working", "One", PROJECT_A),
		session(4, "error", "Two", PROJECT_B),
	];
	const data = {
		sessions,
		counts: { needs_you: 0, error: 1, done: 0, working: 1, idle: 0, ended: 0 },
	};
	expect(
		filterAgentSessions(data, { version: 1, projectId: PROJECT_A }).counts,
	).toEqual({ ...data.counts, error: 0 });
	expect(
		filterAgentSessions(
			data,
			{ version: 1, projectId: PROJECT_A },
			{ project: PROJECT_B, state: "all", harness: "all" },
		).sessions,
	).toEqual([]);
	expect(
		filterAgentSessions(
			data,
			{ version: 1 },
			{ project: "all", state: "error", harness: "codex" },
		).sessions,
	).toEqual([sessions[1]]);
});

it("can explicitly show ended sessions through its configured state scope", async () => {
	const doc = await render(
		[session(2, "ended", "Finished local lane", PROJECT_A)],
		{
			version: 1,
			states: ["ended"],
		},
	);
	expect(doc.body.textContent).toContain("Finished local lane");
	expect(doc.querySelector('li[data-agent-state="ended"]')).not.toBeNull();
});
