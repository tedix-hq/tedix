import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	listRuns: vi.fn(),
	sumCharges: vi.fn(),
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

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue(undefined);
	mocks.sumCharges.mockResolvedValue({ chargedMicros: 1234, chargeCount: 3 });
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
