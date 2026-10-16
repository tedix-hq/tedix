import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	persistKernelTurnSettlement,
	type KernelTurnSettlementInput,
} from "./run-store";

const mocks = vi.hoisted(() => ({ settle: vi.fn(), project: vi.fn() }));
vi.mock("@tedix/db/queries/kernel-runtime-runs", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/kernel-runtime-runs")>()),
	settleKernelRuntimeTurn: mocks.settle,
}));
vi.mock("./conversation-index", async (original) => ({
	...(await original<typeof import("./conversation-index")>()),
	applyKernelConversationEvent: mocks.project,
}));

const context = { db: {} } as BaseContext;
const input: KernelTurnSettlementInput = {
	run: {
		id: "run-1",
		organizationId: "org-1",
		fromStatus: "running",
		patch: { status: "completed" },
	},
	events: ["message.completed", "run.completed"].map((kind) => ({
		id: `event:${kind}`,
		organizationId: "org-1",
		conversationId: "home:main",
		runId: "run-1",
		kind,
		payload: { content: "Final answer" },
		createdAt: "2026-10-16T00:00:00.000Z",
	})) as KernelTurnSettlementInput["events"],
};

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.settle.mockImplementation(async (_db, value) => ({
		runTransitioned: true,
		events: value.events.map((row: unknown) => ({ row, inserted: true })),
	}));
	mocks.project.mockResolvedValue(undefined);
});

describe("terminal conversation projection", () => {
	it("commits the run and receipt before handing off a pending projection", async () => {
		const commit = deferred();
		const projection = deferred();
		const committed = mocks.settle.getMockImplementation()!;
		mocks.settle.mockImplementation(async (...args) => {
			await commit.promise;
			return committed(...args);
		});
		mocks.project.mockReturnValue(projection.promise);
		const held: Promise<void>[] = [];
		const work = persistKernelTurnSettlement(context, {
			...input,
			holdAfterSettle: (promise) => held.push(promise),
		});
		expect(mocks.project).not.toHaveBeenCalled();
		expect(held).toHaveLength(0);
		commit.resolve();
		const result = await work;
		expect(result.assistantEvent.payload?.content).toBe("Final answer");
		expect(result.terminalEvent.kind).toBe("run.completed");
		expect(held).toHaveLength(1);
		let drained = false;
		void held[0]!.then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		projection.resolve();
		await held[0];
		expect(drained).toBe(true);
	});

	it("waits for the projection without a lifetime holder", async () => {
		const projection = deferred();
		mocks.project.mockReturnValue(projection.promise);
		let finished = false;
		const work = persistKernelTurnSettlement(context, input).then(() => {
			finished = true;
		});
		await vi.waitFor(() => expect(mocks.project).toHaveBeenCalled());
		expect(finished).toBe(false);
		projection.resolve();
		await work;
		expect(finished).toBe(true);
	});

	it("does not project or double-count replayed events", async () => {
		mocks.settle.mockImplementation(async (_db, value) => ({
			runTransitioned: false,
			events: value.events.map((row: unknown) => ({ row, inserted: false })),
		}));
		await persistKernelTurnSettlement(context, input);
		expect(mocks.project).not.toHaveBeenCalled();
	});

	it("does not hand off anything when canonical settlement fails", async () => {
		mocks.settle.mockRejectedValue(new Error("receipt insert failed"));
		const holdAfterSettle = vi.fn();
		await expect(
			persistKernelTurnSettlement(context, { ...input, holdAfterSettle }),
		).rejects.toThrow("receipt insert failed");
		expect(holdAfterSettle).not.toHaveBeenCalled();
		expect(mocks.project).not.toHaveBeenCalled();
	});
});
