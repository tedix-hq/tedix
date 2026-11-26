import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
import { retryWorkRead, workRetryDelay } from "@/lib/work-refresh";
import { ActivityRunningNow } from "./activity-running-now";

const api = vi.hoisted(() => ({
	attempts: vi.fn(),
	health: vi.fn(),
	metrics: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: {
			listAttemptProjection: api.attempts,
			getAgentScorecard: api.metrics,
		},
		dispatcherHealth: { list: api.health },
	},
}));
vi.mock("./work-operations-shared", () => ({
	useWorkPrincipalNames: () =>
		new Map([["external_agent:cedar", "Cedar agent"]]),
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const workId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const at = "2026-11-07T12:00:00.000Z";
const config = ActivityFeedConfigSchema.parse({
	version: 1,
	scope: "organization",
	projects: [],
});
function row() {
	return WorkAttemptProjectionSchema.parse({
		attempt: {
			id: attemptId,
			orgId: "44444444-4444-4444-8444-444444444444",
			workItemId: workId,
			executorType: "external_agent",
			executorId: "cedar",
			executorSessionId: null,
			externalSessionKey: null,
			runtimeState: "running",
			outcome: null,
			runId: null,
			admissionId: null,
			attemptNumber: 2,
			startedAt: "2026-11-07T11:50:00.000Z",
			heartbeatAt: at,
			expiresAt: "2026-11-07T12:05:00.000Z",
			finishedAt: null,
			summary: null,
			metadata: {},
		},
		workItem: {
			id: workId,
			title: "Prepare Cedar brief",
			disposition: "accepted",
			workKind: "coding",
			riskLevel: "low",
			priority: "medium",
			projectId,
			accountableOwnerType: null,
			accountableOwnerId: null,
		},
	});
}
const report = {
	reporterId: "cedar-machine",
	executor: "codex",
	lane: "codex-runner",
	running: true,
	observedAt: at,
	reportedAt: at,
	lastAdmissionAt: at,
	topReason: null,
	ageSeconds: 0,
	staleAfterSeconds: 60,
	stale: false,
};
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function scorecardResult(attempts = 3) {
	return {
		tedis: [],
		localMetrics: [],
		history: {
			observedAt: at,
			windows: ([7, 30] as const).map((days) => ({
				days,
				since: "2026-10-08T12:00:00.000Z",
				rows: [
					{
						executor: "codex",
						model: "example-model",
						attempts: days === 7 ? attempts : 8,
						items: 2,
						succeeded: 1,
						landedUnverified: 1,
						failed: 1,
						cancelled: 0,
						expired: 0,
						rejected: 0,
						unsettled: 0,
						successRate: 1 / 3,
						medianSettleMs: 60000,
						p90SettleMs: 180000,
						attemptsPerItem: 1.5,
						landedItems: 1,
						costPerLandedItemUsd: 0.12,
						tokensPerLandedItem: 4200,
						reverts: null,
						redCi: null,
						qualityObservedCommits: 0,
						landedCommits: 1,
					},
				],
			})),
		},
	};
}
beforeEach(() => {
	api.metrics.mockReset().mockResolvedValue(scorecardResult());
	vi.useFakeTimers();
	vi.setSystemTime(new Date(at));
	api.attempts
		.mockReset()
		.mockResolvedValue({ data: [row()], hasMore: false, nextCursor: null });
	api.health.mockReset().mockResolvedValue({ reportedAt: at, data: [report] });
});
afterEach(async () => {
	await act(async () => root?.unmount());
	client?.clear();
	host?.remove();
	vi.useRealTimers();
});
async function flush(ms = 5) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}
async function mount(selected?: string) {
	// The app's own read retry policy (router.tsx).
	client = new QueryClient({
		defaultOptions: {
			queries: { retry: retryWorkRead, retryDelay: workRetryDelay },
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ActivityRunningNow config={config} projectId={selected}>
					<div>Activity history</div>
				</ActivityRunningNow>
			</QueryClientProvider>,
		),
	);
	await flush();
}
/** The scorecard reads nothing until someone opens it. */
async function openScorecard() {
	const trigger = [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes("Agent scorecard"),
	)!;
	await act(async () => trigger.click());
	await flush();
}
it("shows the canonical attempt fields and polls away completed attempts without navigation", async () => {
	await mount(projectId);
	expect(api.attempts).toHaveBeenCalledWith(
		{
			projectId,
			limit: 100,
			includeLaneState: false,
			runtimeStates: ["queued", "running", "waiting", "retrying"],
		},
		expect.anything(),
	);
	expect(host.textContent).toContain("Prepare Cedar brief");
	expect(host.textContent).not.toContain(attemptId);
	expect(host.textContent).toContain("Cedar agent");
	expect(
		host.querySelector(`a[href="/work/items/${workId}"]`)?.textContent,
	).toContain("Prepare Cedar brief");
	expect(host.textContent).not.toContain("Last renewal");
	expect(api.attempts.mock.calls.every(([input]) => input.runtimeStates)).toBe(
		true,
	);
	await openScorecard();
	// A running runner shows no status line; only the missing supervisor does.
	expect(host.textContent).toContain("Supervisor not reporting");
	expect(host.textContent).not.toContain("not running");
	api.attempts.mockResolvedValue({
		data: [],
		hasMore: false,
		nextCursor: null,
	});
	await flush(30_010);
	expect(
		api.attempts.mock.calls.filter(([input]) => input.runtimeStates),
	).toHaveLength(2);
	expect(
		api.attempts.mock.calls.filter(([input]) => !input.runtimeStates),
	).toHaveLength(0);
	expect(api.metrics).toHaveBeenCalledTimes(2);
	expect(api.health).toHaveBeenCalledTimes(2);
	expect(host.textContent).not.toContain("Prepare Cedar brief");
	expect(host.textContent).toContain("No work is running here.");
});
it("ages fleet observations locally and marks elapsed leases without claiming health", async () => {
	const expired = row();
	expired.attempt.expiresAt = at;
	api.attempts.mockResolvedValue({
		data: [expired],
		hasMore: true,
		nextCursor: null,
	});
	await mount();
	expect(host.textContent).toContain("No recent update");
	const more = [...host.querySelectorAll("a")].find(
		(link) => link.textContent === "More running work",
	);
	expect(more?.getAttribute("href")).toBe("/work?view=feed&filter=queue");
	await openScorecard();
	await flush(75_010);
	expect(host.textContent).toContain("No runner report since");
});
it("names the tool and how long it has run, not the machine", async () => {
	const local = row();
	local.attempt.externalSessionKey = "codex:cedar-session";
	api.attempts.mockResolvedValue({
		data: [local],
		hasMore: false,
		nextCursor: null,
	});
	await mount();
	const item = host.querySelector('ul[aria-label="Active work"] li')!;
	expect(item.textContent).toContain("Codex · 10 min");
	expect(item.textContent).not.toContain("@");
});
it("names records in task titles instead of printing their ids", async () => {
	const named = row();
	named.workItem.title =
		"Copy skill 4f1c2a90-3b7d-4e21-9a55-0c8e7d6b1f42 (Forum Scout) into the pilot workspace";
	api.attempts.mockResolvedValue({
		data: [named],
		hasMore: false,
		nextCursor: null,
	});
	await mount();
	expect(host.textContent).toContain(
		"Copy skill Forum Scout into the pilot workspace",
	);
	expect(host.textContent).not.toContain("4f1c2a90");
});
it("keeps the first load pending while a transient failure recovers", async () => {
	api.attempts.mockRejectedValueOnce(new Error("Timed out"));
	await mount();
	expect(host.textContent).toContain("Checking running work");
	expect(host.textContent).not.toContain("Activity history");
	expect(host.textContent).not.toContain("Could not load running work");
	expect(api.health).not.toHaveBeenCalled();
	await flush(2010);
	expect(host.textContent).toContain("Activity history");
	expect(host.textContent).toContain("Prepare Cedar brief");
});

it("keeps failures distinct from a quiet fleet and exposes retry controls", async () => {
	const failure = Object.assign(new Error("No access"), { code: "FORBIDDEN" });
	api.attempts.mockRejectedValue(failure);
	api.health.mockRejectedValue(failure);
	await mount();
	expect(host.textContent).toContain("Could not load running work");
	expect(host.textContent).toContain("Activity history");
	await openScorecard();
	expect(host.textContent).toContain("Runner health unavailable");
	expect(host.textContent).toContain("Current activity is unknown.");
	expect(host.textContent).not.toContain("No active attempts");
	expect(host.textContent).not.toContain("No runner report since");
	expect(host.querySelectorAll("button").length).toBeGreaterThan(0);
});

it("switches 7/30-day evidence and refreshes without paging raw history", async () => {
	await mount(projectId);
	await openScorecard();
	const scorecard = host.querySelector(
		'section[aria-label="Agent scorecard"]',
	)!;
	expect(scorecard.textContent).toContain("3 attempts");
	expect(scorecard.textContent).toContain("Succeeded 1 · Unverified 1");
	expect(api.metrics).toHaveBeenCalledWith(
		{ projectIds: [projectId] },
		expect.anything(),
	);
	expect(
		api.attempts.mock.calls.filter(([input]) => !input.runtimeStates),
	).toHaveLength(0);
	const month = [
		...scorecard.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === "30 days")!;
	await act(async () => month.click());
	expect(scorecard.textContent).toContain("8 attempts");
	const week = [
		...scorecard.querySelectorAll<HTMLButtonElement>("button"),
	].find((button) => button.textContent === "7 days")!;
	await act(async () => week.click());
	api.metrics.mockResolvedValue(scorecardResult(4));
	await flush(30_020);
	expect(scorecard.textContent).toContain("4 attempts");
});

it("keeps forbidden scorecard evidence unknown and recovers through manual retry", async () => {
	api.metrics.mockRejectedValue(
		Object.assign(new Error("History unavailable"), { code: "FORBIDDEN" }),
	);
	await mount();
	await openScorecard();
	expect(host.textContent).toContain("Agent scorecard unavailable");
	expect(
		host.querySelector('section[aria-label="Agent scorecard"] table'),
	).toBeNull();
	api.metrics.mockResolvedValue(scorecardResult());
	const retry = [
		...host.querySelectorAll<HTMLButtonElement>(
			'section[aria-label="Agent scorecard"] button',
		),
	].find((button) => button.textContent === "Retry")!;
	await act(async () => retry.click());
	await flush();
	expect(host.textContent).not.toContain("Agent scorecard unavailable");
	expect(
		host.querySelector('section[aria-label="Agent scorecard"] tbody tr')
			?.textContent,
	).toContain("example-model");
});
