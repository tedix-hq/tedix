import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	listRuns: vi.fn(),
	sumCharges: vi.fn(),
	sumChargesByRun: vi.fn(),
}));
vi.mock("../kernel/run-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../kernel/run-store")>()),
	ensureHomeConversationAccess: mocks.access,
}));
vi.mock("@tedix/db/queries/kernel-runtime-runs", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/kernel-runtime-runs")
	>()),
	listKernelRuntimeRuns: mocks.listRuns,
}));
vi.mock("@tedix/db/queries/billing/spending", () => ({
	sumRunInferenceCharges: mocks.sumCharges,
	sumRunInferenceChargesByRun: mocks.sumChargesByRun,
}));
// Terminal delegated rows otherwise repair their completion message through
// the database; this file only tests what the run set reads.
vi.mock("../kernel/run-store-reconciliation", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../kernel/run-store-reconciliation")
	>()),
	reconcileHomeRunRowsFromChildStatus: async (
		_context: unknown,
		input: { rows: unknown[] },
	) => input.rows,
}));

import { kernelRuntimeContractRouter } from "../kernel-runtime";

const ORG_ID = "org-fictional";

function client() {
	const context = {
		apiKey: {
			id: "api-key-1",
			name: "test",
			organizationId: ORG_ID,
			scopes: ["*"],
		},
		authType: "apikey",
		db: {},
		env: { ENVIRONMENT: "test" },
		headers: new Headers(),
		organizationId: ORG_ID,
		rateLimiter: { limit: vi.fn(async () => ({ success: true })) },
		url: new URL("https://api.tedix.test/rpc/kernel-runtime"),
		waitUntil: () => {},
	} as unknown as BaseContext;
	return createRouterClient(kernelRuntimeContractRouter, { context });
}

const run = (id: string, childRunId: string | null = null) => ({
	id,
	childRunId,
});

/** A finished delegated Home run row, as listKernelRuntimeRuns returns it. */
const delegatedRow = (id: string, childRunId: string | null) => ({
	id,
	organizationId: ORG_ID,
	conversationId: "home:fictional",
	status: "completed",
	inputMessageId: `${id}:user`,
	outputMessageId: `${id}:assistant`,
	delegatedTediId: childRunId ? "tedi-fictional" : null,
	childRunId,
	childConversationId: null,
	progressValue: 100,
	progressLabel: "Complete",
	progressDetail: null,
	latestEventKind: null,
	latestEventAt: null,
	preview: null,
	runtimeBackend: "custom",
	runtimeExternalId: null,
	runtimeExternalUrl: null,
	runtimeMetadata: null,
	metadata: null,
	startedAt: "2026-10-25T10:00:00.000Z",
	completedAt: "2026-10-25T10:08:03.000Z",
	createdAt: "2026-10-25T10:00:00.000Z",
	updatedAt: "2026-10-25T10:08:03.000Z",
	outputRevisionId: null,
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(undefined);
	mocks.sumCharges.mockResolvedValue({ chargedMicros: 1234, chargeCount: 3 });
	mocks.sumChargesByRun.mockResolvedValue(new Map());
});

describe("readRunSet settled delegated charges", () => {
	it("attaches each delegated run's own settled EUR charge by its child run", async () => {
		mocks.listRuns.mockResolvedValueOnce([
			delegatedRow("run-1", "tedi:child-1"),
			delegatedRow("run-2", "tedi:child-2"),
			delegatedRow("run-3", null),
		]);
		mocks.sumChargesByRun.mockResolvedValueOnce(
			new Map([["tedi:child-1", { chargedMicros: 40_000, chargeCount: 2 }]]),
		);
		const result = await client().readRunSet({
			conversationId: "home:fictional",
		});
		expect(mocks.sumChargesByRun.mock.calls[0]![1]).toEqual({
			organizationId: ORG_ID,
			runIds: ["tedi:child-1", "tedi:child-2"],
		});
		expect(result.runSet.runs.map((run) => run.settledCharge)).toEqual([
			{ currency: "eur", chargedMicros: 40_000, chargeCount: 2 },
			undefined,
			undefined,
		]);
	});

	it("skips the charge read without delegations and survives a failed one", async () => {
		mocks.listRuns.mockResolvedValueOnce([delegatedRow("run-1", null)]);
		await client().readRunSet({ conversationId: "home:fictional" });
		expect(mocks.sumChargesByRun).not.toHaveBeenCalled();

		mocks.listRuns.mockResolvedValueOnce([delegatedRow("run-2", "tedi:c")]);
		mocks.sumChargesByRun.mockRejectedValueOnce(new Error("D1 busy"));
		const result = await client().readRunSet({
			conversationId: "home:fictional",
		});
		expect(result.runSet.runs).toHaveLength(1);
		expect(result.runSet.runs[0]).not.toHaveProperty("settledCharge");
	});
});

describe("readConversationCharges", () => {
	it("sums settled EUR charges over the conversation's runs and delegated child runs", async () => {
		mocks.listRuns.mockResolvedValueOnce([
			run("run-1", "tedi:child-1"),
			run("run-2"),
		]);
		const result = await client().readConversationCharges({
			conversationId: "home:fictional",
		});
		expect(result).toEqual({
			currency: "eur",
			chargedMicros: 1234,
			chargeCount: 3,
			runCount: 2,
		});
		expect(mocks.access.mock.calls[0]![1]).toEqual({
			conversationId: "home:fictional",
			organizationId: ORG_ID,
			required: "read",
		});
		expect(mocks.listRuns.mock.calls[0]![1]).toMatchObject({
			organizationId: ORG_ID,
			conversationId: "home:fictional",
			offset: 0,
		});
		expect(mocks.sumCharges.mock.calls[0]![1]).toEqual({
			organizationId: ORG_ID,
			runIds: ["run-1", "tedi:child-1", "run-2"],
		});
	});

	it("pages through long conversations and stops at a short page", async () => {
		const page = (start: number, size: number) =>
			Array.from({ length: size }, (_, index) => run(`run-${start + index}`));
		mocks.listRuns
			.mockResolvedValueOnce(page(0, 100))
			.mockResolvedValueOnce(page(100, 7));
		const result = await client().readConversationCharges({
			conversationId: "home:long",
		});
		expect(result.runCount).toBe(107);
		expect(mocks.listRuns).toHaveBeenCalledTimes(2);
		expect(mocks.listRuns.mock.calls[1]![1]).toMatchObject({ offset: 100 });
		expect(mocks.sumCharges.mock.calls[0]![1].runIds).toHaveLength(107);
	});

	it("refuses a conversation the caller may not read", async () => {
		mocks.access.mockRejectedValue(new Error("conversation not accessible"));
		await expect(
			client().readConversationCharges({ conversationId: "home:other" }),
		).rejects.toThrow();
		expect(mocks.listRuns).not.toHaveBeenCalled();
		expect(mocks.sumCharges).not.toHaveBeenCalled();
	});
});
