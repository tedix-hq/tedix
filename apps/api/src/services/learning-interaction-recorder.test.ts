import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { recordLearningInteraction } = vi.hoisted(() => ({
	recordLearningInteraction: vi.fn(),
}));

vi.mock("@tedix/db/queries/learning-feedback", () => ({
	recordLearningInteraction,
}));

import {
	observedLearningActor,
	observedLearningEventId,
	recordObservedLearningInteraction,
} from "./learning-interaction-recorder";

describe("observed learning interaction recorder", () => {
	beforeEach(() => {
		recordLearningInteraction.mockReset();
		recordLearningInteraction.mockResolvedValue({ duplicate: false });
	});

	it("derives a personal scope for a human approval", async () => {
		const recorded = await recordObservedLearningInteraction(
			{
				db: {} as never,
				authType: "user",
				user: { sub: "user-1" } as never,
			},
			{
				organizationId: "org-1",
				clientEventId: "approval:req-1:approved",
				eventKind: "accepted",
				surface: "tedi-approvals",
				tediId: "tedi-1",
				targetType: "approval_request",
				targetId: "req-1",
			},
		);

		expect(recorded).toBe(true);
		expect(recordLearningInteraction).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				actorType: "user",
				actorId: "user-1",
				tediId: "tedi-1",
				scopeKind: "personal",
				scopeId: "user-1",
			}),
		);
	});

	it("derives tedi and organization scopes without trusting caller ids", async () => {
		await recordObservedLearningInteraction(
			{ db: {} as never, authType: "tedi", tediId: "tedi-1" },
			{
				organizationId: "org-1",
				clientEventId: "retry:run-1",
				eventKind: "retried",
				surface: "kernel",
			},
		);
		await recordObservedLearningInteraction(
			{ db: {} as never, authType: "service-binding" },
			{
				organizationId: "org-1",
				clientEventId: "retry:run-2",
				eventKind: "retried",
				surface: "kernel",
			},
		);

		expect(recordLearningInteraction.mock.calls[0]?.[1]).toMatchObject({
			actorType: "tedi",
			actorId: "tedi-1",
			scopeKind: "tedi",
			scopeId: "tedi-1",
		});
		expect(recordLearningInteraction.mock.calls[1]?.[1]).toMatchObject({
			actorType: "service",
			actorId: null,
			scopeKind: "organization",
			scopeId: "org-1",
		});
	});

	it("prefers the acting human on service-binding requests", () => {
		expect(
			observedLearningActor({
				authType: "service-binding",
				descopeUserId: "user-through-tedix-os",
			}),
		).toEqual({ actorType: "user", actorId: "user-through-tedix-os" });
	});

	it("fails soft after the primary product mutation", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		recordLearningInteraction.mockRejectedValueOnce(
			new Error("D1 unavailable"),
		);

		await expect(
			recordObservedLearningInteraction(
				{ db: {} as never, authType: "user", user: { sub: "u-1" } as never },
				{
					organizationId: "org-1",
					clientEventId: "approval:req-2:rejected",
					eventKind: "rejected",
					surface: "tedi-approvals",
				},
			),
		).resolves.toBe(false);
		expect(warn).toHaveBeenCalledOnce();
		warn.mockRestore();
	});

	it("hashes the complete canonical identity into a bounded stable key", async () => {
		const first = await observedLearningEventId(
			"kernel-approval",
			"run-with-a-long-identity",
			"approve",
			"assignment-a,assignment-b",
		);
		const same = await observedLearningEventId(
			"kernel-approval",
			"run-with-a-long-identity",
			"approve",
			"assignment-a,assignment-b",
		);
		const different = await observedLearningEventId(
			"kernel-approval",
			"run-with-a-long-identity",
			"approve",
			"assignment-b",
		);
		expect(first).toBe(same);
		expect(first).not.toBe(different);
		expect(first.length).toBeLessThanOrEqual(128);
	});
});
