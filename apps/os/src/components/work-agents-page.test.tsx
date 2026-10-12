import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	projectListQueryOptions,
	workAgentSessionsQueryOptions,
} from "@/lib/os-query-options";
import { WorkAgentsPage } from "./work-agents-page";

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

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

function render(sessions: ReturnType<typeof session>[]) {
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
	client.setQueryData(workAgentSessionsQueryOptions().queryKey, {
		sessions,
		counts,
	});
	client.setQueryData(projectListQueryOptions(100).queryKey, {
		data: [
			{ id: PROJECT_A, name: "Billing revamp" },
			{ id: PROJECT_B, name: "Docs refresh" },
		],
		pagination: { limit: 100, offset: 0, total: 2, hasMore: false },
	} as never);
	return new DOMParser().parseFromString(
		renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<WorkAgentsPage />
			</QueryClientProvider>,
		),
		"text/html",
	);
}

describe("Agents board", () => {
	it("polls every 10 seconds and on window focus", () => {
		const options = workAgentSessionsQueryOptions() as {
			refetchInterval?: unknown;
			refetchOnWindowFocus?: unknown;
		};
		expect(options.refetchInterval).toBe(10_000);
		expect(options.refetchOnWindowFocus).toBe(true);
	});

	it("groups sessions by project with unbound sessions last", () => {
		const doc = render([
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
			"00000076",
			"Docs refresh",
			"No project",
		]);
		expect(doc.body.textContent).not.toContain("Closed");
		expect(doc.body.textContent).toContain("Claude Code");
		expect(doc.body.textContent).toContain("Codex");
		const strip = doc.querySelector('[aria-label="Agent session counts"]');
		expect(strip?.textContent).toContain("Needs you2");
		expect(strip?.textContent).toContain("Errors1");
	});

	it("keeps urgency order and a state badge inside a project group", () => {
		const doc = render([
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
		expect(group?.querySelector("li")?.textContent).toContain("Needs you");
	});

	it("tints only needs_you and done rows and keeps the full summary on hover", () => {
		const summary = "A very long summary ".repeat(8).trim();
		const doc = render([
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

	it("collapses idle sessions inside their group by default", () => {
		const doc = render([session(4, "idle", "Quiet session summary")]);
		const group = doc.querySelector('section[aria-label="No project"]');
		expect(group?.textContent).toContain("Idle (1)");
		expect(group?.querySelector("li")).toBeNull();
	});

	it("explains how to turn reporting on when no session reports", () => {
		const doc = render([session(5, "ended", "Closed")]);
		expect(doc.body.textContent).toContain("No agent sessions reporting");
		expect(doc.body.textContent).toContain("~/.tedix/agent-status.json");
		expect(doc.body.textContent).toContain('"enabled": true');
		expect(doc.querySelector("section[aria-label]")).toBeNull();
	});
});
