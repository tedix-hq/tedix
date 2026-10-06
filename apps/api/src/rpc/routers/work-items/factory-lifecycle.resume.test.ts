import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	external: vi.fn(),
	tediAccess: vi.fn(),
	attempts: vi.fn(),
	start: vi.fn(),
	admit: vi.fn(),
}));

vi.mock("./policy-helpers", async (importOriginal) => ({
	...(await importOriginal<typeof import("./policy-helpers")>()),
	assertWorkItemAccess: mocks.access,
}));
vi.mock("../work-items-principal", async (importOriginal) => ({
	...(await importOriginal<typeof import("../work-items-principal")>()),
	verifiedExternalAgent: mocks.external,
	assertTediAccess: mocks.tediAccess,
}));
vi.mock("@tedix/db/queries/work-items/attempts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@tedix/db/queries/work-items/attempts")
	>()),
	listWorkItemAttempts: mocks.attempts,
	startWorkItemAttempt: mocks.start,
}));
vi.mock("./attempt-admission", () => ({ admitWorkAttempt: mocks.admit }));

import { startAttemptProcedure } from "./factory-lifecycle";

const workItem = {
	id: "11111111-1111-4111-8111-111111111111",
	orgId: "org-1",
	accountableOwnerType: null,
	accountableOwnerId: null,
};
const activeAttempt = {
	id: "attempt-1",
	executorType: "tedi",
	executorId: "tedi-1",
	runtimeState: "running",
	expiresAt: "9999-01-01T00:00:00.000Z",
};

// Invoke the real lifecycle handler; identity verification and persistence are
// isolated here so this regression specifically exercises its admission order.
function start() {
	return startAttemptProcedure["~orpc"].handler!({
		input: { id: workItem.id, metadata: { delegatedAssignedWorkItem: true } },
		context: { db: {}, tediId: "tedi-1" } as BaseContext,
		path: ["workItems", "startAttempt"],
		procedure: startAttemptProcedure,
		signal: undefined,
		lastEventId: undefined,
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockResolvedValue(workItem);
	mocks.external.mockResolvedValue(null);
	mocks.tediAccess.mockResolvedValue(undefined);
	mocks.attempts.mockResolvedValue({ data: [activeAttempt] });
});

describe("delegated startAttempt resumes existing execution authority", () => {
	it("resumes the same live tedi attempt without an accountable owner", async () => {
		await expect(start()).resolves.toEqual({
			workItem,
			attempt: activeAttempt,
			resumed: true,
		});
		expect(mocks.tediAccess).toHaveBeenCalled();
		expect(mocks.admit).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it.each([
		{ ...activeAttempt, executorId: "another-tedi" },
		{ ...activeAttempt, expiresAt: "2000-01-01T00:00:00.000Z" },
		{ ...activeAttempt, expiresAt: null },
	])(
		"rejects an unassigned tedi without matching live authority: %j",
		async (attempt) => {
			mocks.attempts.mockResolvedValue({ data: [attempt] });
			await expect(start()).rejects.toMatchObject({ code: "FORBIDDEN" });
			expect(mocks.admit).not.toHaveBeenCalled();
			expect(mocks.start).not.toHaveBeenCalled();
		},
	);

	it("never resumes a tedi attempt for an external identity with the same id", async () => {
		mocks.external.mockResolvedValue({
			executor: {
				type: "external_agent",
				id: "tedi-1",
				sessionId: "session-1",
			},
			externalSessionKey: "session-key",
		});
		await expect(start()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.attempts).not.toHaveBeenCalled();
		expect(mocks.admit).not.toHaveBeenCalled();
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
