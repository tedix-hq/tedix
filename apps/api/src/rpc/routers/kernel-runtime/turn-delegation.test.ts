import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const claim = vi.fn();
const insertEvent = vi.fn();
const insertRun = vi.fn();
const existingCause = vi.fn();

vi.mock("../../../kernel/runtime-submission-bridge", () => ({
	claimKernelExecutionPolicy: (...args: unknown[]) => claim(...args),
}));
vi.mock("../kernel/run-store", async (importOriginal) => ({
	...(await importOriginal<typeof import("../kernel/run-store")>()),
	existingRunStartedCause: (...args: unknown[]) => existingCause(...args),
	insertKernelRuntimeEvent: (...args: unknown[]) => insertEvent(...args),
	insertKernelRuntimeRun: (...args: unknown[]) => insertRun(...args),
}));
vi.mock("./policy-normalization", async (importOriginal) => ({
	...(await importOriginal<typeof import("./policy-normalization")>()),
	readOrgGovernancePolicy: vi.fn(async () => null),
	readSessionWriteAllowlist: vi.fn(async () => []),
}));

import {
	kernelDelegationRecommendationFromRun,
	startKernelTurn,
} from "./turn-delegation";

function context(): BaseContext {
	return {
		db: {} as BaseContext["db"],
		env: {} as CloudflareEnv,
	} as BaseContext;
}

describe("startKernelTurn execution policy claim", () => {
	beforeEach(() => {
		claim.mockReset();
		insertEvent.mockReset();
		insertRun.mockReset();
		existingCause.mockReset();
		claim.mockResolvedValue({});
		existingCause.mockResolvedValue(undefined);
		insertEvent.mockResolvedValue({ id: "input-event" });
		insertRun.mockResolvedValue({});
	});

	it("claims the exact normal identity before the first transcript or run write", async () => {
		const order: string[] = [];
		claim.mockImplementation(async () => order.push("claim"));
		insertEvent.mockImplementation(async () => {
			order.push("event");
			return { id: "input-event" };
		});
		insertRun.mockImplementation(async () => order.push("run"));

		const turn = await startKernelTurn(context(), {
			organizationId: "org-1",
			conversationId: "home:main",
			content: "voice transcript",
			runId: "run-1",
		});

		expect(order).toEqual(["claim", "event", "event", "run"]);
		expect(claim).toHaveBeenCalledWith(expect.anything(), {
			runId: "run-1",
			organizationId: "org-1",
			conversationId: "home:main",
			idempotencyKey: "run-1",
			delegatedTediId: null,
			executionPolicy: "normal",
		});
		expect(turn.executionPolicy).toBe("normal");
		expect(turn.runtimeMetadata.executionPolicy).toBe("normal");
		expect(turn.runRowMetadata.executionPolicy).toBe("normal");
		expect(insertEvent.mock.calls[1]?.[1]).toMatchObject({
			causeEventId: "input-event",
		});
	});

	it.each([null, "original-cause"])(
		"preserves a legacy run start cause on replay: %s",
		async (causeEventId) => {
			existingCause.mockResolvedValue(causeEventId);
			await startKernelTurn(context(), {
				organizationId: "org-1",
				conversationId: "home:main",
				content: "voice transcript",
				runId: "run-1",
			});
			expect(insertEvent.mock.calls[1]?.[1]).toMatchObject({
				causeEventId,
			});
		},
	);

	it("fails before every transcript/run write when the durable claim conflicts", async () => {
		claim.mockRejectedValue(new Error("immutable policy conflict"));
		await expect(
			startKernelTurn(context(), {
				organizationId: "org-1",
				conversationId: "home:main",
				content: "wake",
				runId: "run-1",
				executionPolicy: "observe_only",
			}),
		).rejects.toThrow(/immutable policy conflict/);
		expect(insertEvent).not.toHaveBeenCalled();
		expect(insertRun).not.toHaveBeenCalled();
	});

	it("does not let caller metadata widen or replace the authoritative policy", async () => {
		const turn = await startKernelTurn(context(), {
			organizationId: "org-1",
			conversationId: "home:main",
			content: "observe",
			runId: "run-1",
			executionPolicy: "observe_only",
			metadata: { executionPolicy: "normal", source: "spoofed" },
		});
		expect(turn.executionPolicy).toBe("observe_only");
		expect(turn.runtimeMetadata.executionPolicy).toBe("observe_only");
		expect(turn.runRowMetadata.executionPolicy).toBe("observe_only");
		expect(insertEvent.mock.calls[0]?.[1]).toMatchObject({
			runtimeMetadata: { executionPolicy: "observe_only" },
		});
	});
});

describe("kernelDelegationRecommendationFromRun", () => {
	const metadata = {
		homeDelegation: {
			decision: { mode: "needs_approval", reason: "target not active" },
			workOrder: { targetTediId: "target-tedi", status: "draft" },
		},
	};
	function run(
		status: Parameters<
			typeof kernelDelegationRecommendationFromRun
		>[0]["status"],
	) {
		return { status, metadata } as Parameters<
			typeof kernelDelegationRecommendationFromRun
		>[0];
	}
	it.each(["completed", "failed", "canceled"] as const)(
		"does not reopen a %s run from its retained draft proposal",
		(status) => {
			const original = structuredClone(metadata);
			expect(kernelDelegationRecommendationFromRun(run(status))).toBeNull();
			expect(metadata).toEqual(original);
		},
	);
	it.each(["queued", "running", "requires_approval"] as const)(
		"preserves the existing recommendation for a live %s run",
		(status) => {
			expect(kernelDelegationRecommendationFromRun(run(status))).toMatchObject({
				targetTediId: "target-tedi",
				delegation: metadata.homeDelegation,
			});
		},
	);
});
