import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WorkItem } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../../orpc";

const attempts = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/attempts", () => ({
	listWorkItemAttempts: attempts.list,
	getRecordedWorkItemAttempt: vi.fn(),
}));

import {
	canCompleteOwnSucceededAttempt,
	workItemStewardActor,
} from "./policy-helpers";

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

	it("rejects completion outside the caller's organization before resolving an actor", async () => {
		await expect(
			workItemStewardActor(
				{ ...context, organizationId: "other-organization" },
				item({ workKind: "operations" }),
				"completion",
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(attempts.list).not.toHaveBeenCalled();
	});

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

	it.each(["completed", "already_satisfied"])(
		"requires an exact %s declaration for a dispatcher Attempt",
		async (outcome) => {
			const work = item({
				version: 2,
				acceptanceContract: {
					version: 1,
					doneLooksLike: "The entire accepted result is verified.",
				},
			});
			const result = {
				outcome,
				workItemId: work.id,
				workVersion: 2,
				contractVersion: 1,
				outcomeText: work.acceptanceContract!.doneLooksLike,
			};
			for (const laneResult of [
				undefined,
				{ ...result, outcome: "incomplete" },
				{ ...result, workItemId: "other" },
				{ ...result, workVersion: 1 },
				{ ...result, contractVersion: 2 },
				{ ...result, outcomeText: "Only a subtask was done" },
			]) {
				attempts.list.mockResolvedValue({
					data: [
						attempt({
							metadata: {
								dispatchVersion: 2,
								laneResult,
								settlement: { commitSha: SHA },
							},
						}),
					],
				});
				await expect(allowed(work)).resolves.toBe(false);
			}
			attempts.list.mockResolvedValue({
				data: [
					attempt({
						metadata: {
							dispatchVersion: 2,
							laneResult: result,
							settlement: { commitSha: SHA },
						},
					}),
				],
			});
			await expect(allowed(work)).resolves.toBe(true);
		},
	);
	it("refuses an item that is not accepted, or a caller without a session", async () => {
		await expect(allowed(item({ disposition: "proposed" }))).resolves.toBe(
			false,
		);
		await expect(allowed(item(), null)).resolves.toBe(false);
		attempts.list.mockResolvedValue({ data: [], nextCursor: null });
		await expect(allowed()).resolves.toBe(false);
	});

	it.each(["research", "operations", "document"] as const)(
		"allows its own succeeded %s without inventing a code commit",
		async (workKind) => {
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {} })],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind }))).resolves.toBe(true);
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {}, executorSessionId: "other" })],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind }))).resolves.toBe(false);
			await expect(
				allowed(item({ workKind, title: "Send a customer email" })),
			).resolves.toBe(false);
		},
	);

	it("uses the accepted verification outcome instead of credential incident history", async () => {
		attempts.list.mockResolvedValue({
			data: [attempt({ metadata: {} })],
			nextCursor: null,
		});
		await expect(
			allowed(
				item({
					workKind: "operations",
					title: "Verify gateway session audit deployment",
					description:
						"Earlier incident: access tokens expired. Preserve existing grants and user consent. No new user sign-in needed for the token proof already collected.",
					acceptanceContract: {
						version: 1,
						doneLooksLike:
							"Observe managed delivery without changing release gates: verify the live API revision and audit results, and record evidence.",
					},
				}),
			),
		).resolves.toBe(true);
	});

	it.each([
		{ executorId: "other-agent" },
		{ executorSessionId: "other-session" },
		{ outcome: "failed" },
		{ metadata: { dispatchVersion: 1 } },
	])(
		"retains attempt fences for non-coding verification: %j",
		async (overrides) => {
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {}, ...overrides })],
				nextCursor: null,
			});
			await expect(allowed(item({ workKind: "operations" }))).resolves.toBe(
				false,
			);
		},
	);

	it.each([
		"Rotate the provider API key",
		"Pay the supplier invoice",
		"Send a customer email",
	])(
		"keeps accepted reserved actions owner-only: %s",
		async (doneLooksLike) => {
			attempts.list.mockResolvedValue({
				data: [attempt({ metadata: {} })],
				nextCursor: null,
			});
			await expect(
				allowed(
					item({
						workKind: "operations",
						title: "Verify provider recovery",
						description: "Read-only checks only.",
						acceptanceContract: { version: 1, doneLooksLike },
					}),
				),
			).resolves.toBe(false);
		},
	);

	it("retains reserved title and description checks when the outcome is harmless or empty", async () => {
		await expect(
			allowed(
				item({
					title: "Rotate the provider API key",
					acceptanceContract: {
						version: 1,
						doneLooksLike: "Record the result.",
					},
				}),
			),
		).resolves.toBe(false);
		await expect(
			allowed(
				item({
					description: "Pay the supplier invoice.",
					acceptanceContract: { version: 1, doneLooksLike: "  " },
				}),
			),
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
