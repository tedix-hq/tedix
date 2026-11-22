import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AgentRunCard } from "./agent-run-card";

const api = vi.hoisted(() => ({
	steps: vi.fn(),
	attempts: vi.fn(),
	inbox: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: { listAttemptSteps: api.steps, listAttempts: api.attempts },
		workInteractions: { listInbox: api.inbox },
		userProfile: { getMine: vi.fn(async () => ({ id: "u" })) },
	},
}));
vi.mock("@/components/kumo/link-provider", () => ({
	OsRouterLink: ({ children }: { children?: React.ReactNode }) => (
		<a href="/task">{children}</a>
	),
}));

const attemptId = "44444444-4444-4444-8444-444444444444";
const attempt = (outcome: string | null) => ({
	id: attemptId,
	executorType: "external_agent",
	executorId: "codex",
	startedAt: new Date().toISOString(),
	heartbeatAt: new Date().toISOString(),
	finishedAt: outcome ? new Date().toISOString() : null,
	outcome,
});

it("moves from waiting to running to failed without a reload", async () => {
	vi.useFakeTimers();
	api.steps.mockResolvedValue({
		attemptId: null,
		live: false,
		steps: [],
		messages: [],
	});
	api.attempts.mockResolvedValue({ data: [], nextCursor: null });
	api.inbox.mockResolvedValue({ data: [] });
	const host = document.body.appendChild(document.createElement("div"));
	const root = createRoot(host);
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: 30_000, retry: false } },
	});
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ul>
					<AgentRunCard
						agentRun={{
							workItemId: "11111111-1111-4111-8111-111111111111",
							title: "Fix paging",
							executor: "codex",
							requestedAt: new Date().toISOString(),
						}}
					/>
				</ul>
			</QueryClientProvider>,
		),
	);
	// The chat is open in a window the person is not looking at.
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => "hidden",
	});
	window.dispatchEvent(new Event("visibilitychange"));
	const status = () =>
		host.querySelector('[data-slot="agent-run-status"]')?.textContent;
	await act(() => vi.advanceTimersByTimeAsync(100));
	expect(status()).toBe("Waiting for an agent to pick it up");
	const hiddenSteps = api.steps.mock.calls.length;
	const hiddenInbox = api.inbox.mock.calls.length;
	await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
	expect(api.steps).toHaveBeenCalledTimes(hiddenSteps);
	expect(api.inbox).toHaveBeenCalledTimes(hiddenInbox);
	await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
	expect(status()).toBe("No runner has picked this up for 6 minutes");
	api.inbox.mockResolvedValue({
		data: [
			{
				request: {
					metadata: { source: "lane-dispatch-blocker" },
					prompt:
						"Codex paused because this task asks it to message people outside the team. Allow: posts your permission. No: the task stays blocked.",
				},
			},
		],
	});
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => "visible",
	});
	await act(async () => {
		window.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(100);
	});
	expect(api.steps).toHaveBeenCalledTimes(hiddenSteps + 1);
	expect(api.inbox).toHaveBeenCalledTimes(hiddenInbox + 1);
	expect(status()).toContain("Waiting for your permission");
	expect(host.textContent).toContain("message people outside the team");
	expect(host.textContent).toContain("Open the task to review and answer");

	api.steps.mockResolvedValue({
		attemptId,
		live: true,
		steps: [],
		messages: [],
	});
	api.attempts.mockResolvedValue({ data: [attempt(null)], nextCursor: null });
	await act(() => vi.advanceTimersByTimeAsync(3_100));
	expect(api.steps).toHaveBeenCalledTimes(hiddenSteps + 1);
	await act(() => vi.advanceTimersByTimeAsync(3_000));
	expect(status()).toMatch(/^Running/);
	expect(host.textContent).not.toContain("message people outside the team");

	// The run ends without ever reporting a step.
	api.steps.mockResolvedValue({
		attemptId,
		live: false,
		steps: [],
		messages: [],
	});
	api.attempts.mockResolvedValue({
		data: [attempt("failed")],
		nextCursor: null,
	});
	await act(() => vi.advanceTimersByTimeAsync(3_100));
	await act(() => vi.advanceTimersByTimeAsync(100));
	expect(status()).toMatch(/^Finished.*failed/);
	act(() => root.unmount());
	Reflect.deleteProperty(document, "visibilityState");
	window.dispatchEvent(new Event("visibilitychange"));
	client.clear();
	host.remove();
	vi.useRealTimers();
});
