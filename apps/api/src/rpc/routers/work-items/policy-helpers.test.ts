import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

const attempts = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: attempts.list,
}));

import { canCompleteOwnSucceededAttempt } from "./policy-helpers";

const AGENT = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const SHA = "a".repeat(40);
const context = { db: {} } as unknown as BaseContext;

function item(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: "33333333-3333-4333-8333-333333333333",
		orgId: "44444444-4444-4444-8444-444444444444",
		disposition: "accepted",
		workKind: "coding",
		title: "Fence the provider registration cache",
		description: "Keep stale loads from refilling scopes.",
		...overrides,
	} as WorkItem;
}

function attempt(overrides: Record<string, unknown> = {}) {
	return {
		executorType: "external_agent",
		executorId: AGENT,
		executorSessionId: SESSION,
		outcome: "succeeded",
		metadata: { settlement: { mode: "commit", commitSha: SHA } },
		...overrides,
	};
}

describe("canCompleteOwnSucceededAttempt", () => {
	beforeEach(() => {
		attempts.list.mockReset();
		attempts.list.mockResolvedValue({ data: [attempt()], nextCursor: null });
	});

	const allowed = (work = item(), sessionId: string | null = SESSION) =>
		canCompleteOwnSucceededAttempt(context, work, { id: AGENT, sessionId });

	it("lets the agent complete an accepted item its own succeeded settle proved with a commit", async () => {
		await expect(allowed()).resolves.toBe(true);
		expect(attempts.list).toHaveBeenCalledWith(context.db, {
			orgId: item().orgId,
			workItemId: item().id,
			limit: 1,
		});
	});

	it.each([
		["another agent's attempt", { executorId: "other-agent" }],
		["another session of the same agent", { executorSessionId: "other" }],
		["a failed settle", { outcome: "failed" }],
		["a settle without a commit", { metadata: {} }],
		[
			"a malformed commit",
			{ metadata: { settlement: { mode: "commit", commitSha: "abc" } } },
		],
		["a tedi attempt", { executorType: "tedi" }],
		[
			"an earlier Work revision",
			{ metadata: { dispatchVersion: 1, settlement: { commitSha: SHA } } },
		],
	])("refuses %s", async (_label, overrides) => {
		attempts.list.mockResolvedValue({
			data: [attempt(overrides)],
			nextCursor: null,
		});
		await expect(allowed()).resolves.toBe(false);
	});

	it("refuses an item that is not accepted, or a caller without a session", async () => {
		await expect(allowed(item({ disposition: "proposed" }))).resolves.toBe(
			false,
		);
		await expect(allowed(item(), null)).resolves.toBe(false);
		attempts.list.mockResolvedValue({ data: [], nextCursor: null });
		await expect(allowed()).resolves.toBe(false);
	});

	it("allows its own succeeded research without inventing a code commit", async () => {
		attempts.list.mockResolvedValue({
			data: [attempt({ metadata: {} })],
			nextCursor: null,
		});
		await expect(allowed(item({ workKind: "research" }))).resolves.toBe(true);
		attempts.list.mockResolvedValue({
			data: [attempt({ metadata: {}, executorSessionId: "other" })],
			nextCursor: null,
		});
		await expect(allowed(item({ workKind: "research" }))).resolves.toBe(false);
		await expect(
			allowed(item({ workKind: "research", title: "Send a customer email" })),
		).resolves.toBe(false);
	});

	it("does not turn a research prohibition into a reserved action", async () => {
		attempts.list.mockResolvedValue({
			data: [attempt({ metadata: {} })],
			nextCursor: null,
		});
		await expect(
			allowed(
				item({
					workKind: "research",
					title: "Verify recovery pickup",
					description:
						"Read the assigned Work and post a timestamped comment. No code edits, deployment, sign-in or consent.",
				}),
			),
		).resolves.toBe(true);
	});

	it.each([
		"Do not wait — rotate the provider API key",
		"No need to ask, send a customer email",
		"No credential changes. Pay the supplier invoice.",
		"Rotate the provider API key and paste the new credentials",
		"Pay the supplier invoice by bank transfer",
		"Send the weekly summary email to every customer",
	])("keeps owner completion for reserved work: %s", async (title) => {
		await expect(allowed(item({ title }))).resolves.toBe(false);
	});
});
