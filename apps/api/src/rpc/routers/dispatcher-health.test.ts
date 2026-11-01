import { createRouterClient } from "@orpc/server";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { BaseContext } from "../orpc";

const mocks = vi.hoisted(() => ({
	listDispatcherHealthReports: vi.fn(),
	listDispatcherWorkReferences: vi.fn(),
	upsertDispatcherHealthReport: vi.fn(),
}));

vi.mock("@tedix/db/queries/work-items/dispatcher-health", () => mocks);

import { dispatcherHealthContractRouter } from "./dispatcher-health";

const NOW = "2026-10-30T10:10:00.000Z";
const row = {
	orgId: "org-1",
	reporterId: "mac-studio",
	executor: "codex",
	lane: "primary",
	running: false,
	observedAt: "2026-10-30T10:04:59.000Z",
	reportedAt: "2026-10-30T10:04:59.000Z",
	lastAdmissionAt: null,
	slotsInUse: 0,
	slotsTotal: 2,
	topReason: "session label clash",
	topReasonCount: 3,
};

function context(organizationId?: string): BaseContext {
	return {
		authType: "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test" } as CloudflareEnv,
		headers: new Headers(),
		organizationId,
		url: new URL("https://api.tedix.test/rpc/dispatcherHealth"),
		user: {
			aud: "test",
			dct: "tenant-1",
			exp: 2,
			iat: 1,
			iss: "https://auth.tedix.test",
			permissions: ["tedis:read", "tedis:update"],
			roles: [],
			sub: "user-1",
		},
	} as BaseContext;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(NOW));
	mocks.listDispatcherHealthReports.mockReset().mockResolvedValue([row]);
	mocks.listDispatcherWorkReferences.mockReset().mockResolvedValue([]);
	mocks.upsertDispatcherHealthReport
		.mockReset()
		.mockImplementation(async (_db: unknown, value: typeof row) => value);
});

afterEach(() => vi.useRealTimers());

describe("dispatcher health router", () => {
	it("derives the organization and assigns the server report timestamp", async () => {
		const client = createRouterClient(dispatcherHealthContractRouter, {
			context: context("org-1"),
		});
		const result = await client.report({
			reporterId: row.reporterId,
			executor: row.executor,
			lane: row.lane,
			running: row.running,
			observedAt: row.observedAt,
			lastAdmissionAt: null,
			slotsInUse: 0,
			slotsTotal: 2,
			topReason: { reason: row.topReason, count: row.topReasonCount },
		});

		expect(mocks.upsertDispatcherHealthReport).toHaveBeenCalledWith(
			{},
			expect.objectContaining({ orgId: "org-1", reportedAt: NOW }),
		);
		expect(result.reportedAt).toBe(NOW);
	});

	it("lists only the caller organization and exposes staleness", async () => {
		const client = createRouterClient(dispatcherHealthContractRouter, {
			context: context("org-1"),
		});
		const result = await client.list();

		expect(mocks.listDispatcherHealthReports).toHaveBeenCalledWith({}, "org-1");
		expect(result).toMatchObject({
			reportedAt: NOW,
			data: [
				{
					ageSeconds: 301,
					staleAfterSeconds: 300,
					stale: true,
					topReason: { reason: "session label clash", count: 3 },
				},
			],
		});
	});

	it("rejects an authenticated caller without an organization", async () => {
		const client = createRouterClient(dispatcherHealthContractRouter, {
			context: context(),
		});
		await expect(client.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.listDispatcherHealthReports).not.toHaveBeenCalled();
	});
});

describe("reported task references", () => {
	const own = "11111111-1111-4111-8111-111111111111";
	const foreign = "22222222-2222-4222-8222-222222222222";
	const done = "33333333-3333-4333-8333-333333333333";
	function report() {
		return {
			...row,
			executor: "tenant.build-runner",
			running: true,
			observedAt: NOW,
			reportedAt: NOW,
			duty: {
				id: "configured-service",
				kind: "service",
				state: "running",
				observedAt: NOW,
				lastRunAt: NOW,
				lastExitAt: null,
				lastExitCode: null,
				lastExecutor: "tenant.build-runner",
				restartsLastHour: 0,
				retryAt: null,
				lastProblem: null,
				activity: {
					current: [
						{ id: own, phase: "working", title: "Untrusted title" },
						{ id: foreign, phase: "working", title: "Foreign title" },
					],
					currentCount: 2,
					waiting: [{ id: foreign, reason: "reply", retryAt: null }],
					nextCheckAt: null,
					lastCompleted: {
						id: done,
						title: "Untrusted completion",
						completedAt: NOW,
					},
				},
			},
		};
	}
	it("uses caller-scoped canonical titles, strips inaccessible references and rejects cancelled completion", async () => {
		mocks.listDispatcherHealthReports.mockResolvedValue([report()]);
		mocks.listDispatcherWorkReferences.mockResolvedValue([
			{
				id: own,
				title: "Review build",
				disposition: "accepted",
				completedAt: null,
			},
			{
				id: done,
				title: "Cancelled build",
				disposition: "cancelled",
				completedAt: null,
			},
		]);
		const client = createRouterClient(dispatcherHealthContractRouter, {
			context: context("org-1"),
		});
		const out = await client.list();
		const activity = out.data[0]!.duty!.activity!;
		expect(activity.current).toEqual([
			{ id: own, title: "Review build", phase: "working" },
		]);
		expect(activity.waiting).toEqual([]);
		expect(activity.lastCompleted).toBeNull();
		expect(JSON.stringify(out)).not.toContain("Foreign title");
		expect(mocks.listDispatcherWorkReferences).toHaveBeenCalledWith(
			{},
			"org-1",
			expect.arrayContaining([own, foreign, done]),
		);
	});
	it("reports canonical completion time, not a reporter's claim", async () => {
		mocks.listDispatcherHealthReports.mockResolvedValue([report()]);
		const at = "2026-10-30T10:02:00.000Z";
		mocks.listDispatcherWorkReferences.mockResolvedValue([
			{
				id: done,
				title: "Finished review",
				disposition: "completed",
				completedAt: at,
			},
		]);
		const client = createRouterClient(dispatcherHealthContractRouter, {
			context: context("org-1"),
		});
		expect(
			(await client.list()).data[0]!.duty!.activity!.lastCompleted,
		).toEqual({ id: done, title: "Finished review", completedAt: at });
	});
});
