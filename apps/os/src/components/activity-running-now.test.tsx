import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ActivityFeedConfigSchema } from "@tedix/api-contract/schemas/os-activity-feed";
import { WorkAttemptProjectionSchema } from "@tedix/api-contract/schemas/work-items";
import { ActivityRunningNow } from "./activity-running-now";

const api = vi.hoisted(() => ({ attempts: vi.fn(), health: vi.fn() }));
vi.mock("@/lib/api", () => ({
	osApi: {
		workItems: { listAttemptProjection: api.attempts },
		dispatcherHealth: { list: api.health },
	},
}));
vi.mock("./work-operations-shared", () => ({
	useWorkPrincipalNames: () =>
		new Map([["external_agent:cedar", "Cedar agent"]]),
	namedWorkPrincipal: (type: string, id: string, names: Map<string, string>) =>
		names.get(`${type}:${id}`),
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
	slotsInUse: 1,
	slotsTotal: 2,
	topReason: null,
	ageSeconds: 0,
	staleAfterSeconds: 60,
	stale: false,
};
let client: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
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
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<ActivityRunningNow config={config} projectId={selected} />
			</QueryClientProvider>,
		),
	);
	await flush();
}
it("shows the canonical attempt fields and polls away completed attempts without navigation", async () => {
	await mount(projectId);
	expect(api.attempts).toHaveBeenCalledWith(
		{
			projectId,
			limit: 100,
			runtimeStates: ["queued", "running", "waiting", "retrying"],
		},
		expect.anything(),
	);
	expect(host.textContent).toContain("Prepare Cedar brief");
	expect(host.textContent).toContain(`Attempt 2 · ${attemptId}`);
	expect(host.textContent).toContain("Cedar agent");
	expect(host.textContent).toContain("10 min elapsed");
	expect(
		host.querySelectorAll(`time[datetime="${at}"]`).length,
	).toBeGreaterThan(0);
	expect(host.textContent).toContain("Runners up: 1 / 1");
	expect(host.textContent).toContain("Last renewal: unknown");
	api.attempts.mockResolvedValue({
		data: [],
		hasMore: false,
		nextCursor: null,
	});
	await flush(30_010);
	expect(api.attempts).toHaveBeenCalledTimes(2);
	expect(api.health).toHaveBeenCalledTimes(2);
	expect(host.textContent).not.toContain("Prepare Cedar brief");
	expect(host.textContent).toContain("No active attempts in this scope.");
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
	expect(host.textContent).toContain(
		"Lease elapsed · current activity unknown",
	);
	expect(host.textContent).toContain("More active attempts in Work");
	await flush(75_010);
	expect(host.textContent).toContain("Runners up: unknown");
	expect(host.textContent).toContain("1 stale reports");
});
it("keeps failures distinct from a quiet fleet and exposes retry controls", async () => {
	const failure = Object.assign(new Error("No access"), { code: "FORBIDDEN" });
	api.attempts.mockRejectedValue(failure);
	api.health.mockRejectedValue(failure);
	await mount();
	expect(host.textContent).toContain("Active attempts unavailable");
	expect(host.textContent).toContain("Fleet health unavailable");
	expect(host.textContent).toContain("Current activity is unknown.");
	expect(host.textContent).not.toContain("No active attempts");
	expect(host.textContent).not.toContain("Runners up: 0");
	expect(host.querySelectorAll("button").length).toBeGreaterThan(0);
});
