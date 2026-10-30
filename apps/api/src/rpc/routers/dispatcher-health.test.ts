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
