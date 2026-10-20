import { afterEach, expect, it, vi } from "vite-plus/test";
import type { BaseContext } from "../rpc/orpc";
import { queueDeckCuration } from "./deck-curation-trigger";

const { policy } = vi.hoisted(() => ({ policy: vi.fn() }));
vi.mock("@tedix/db/queries/decision-learning", () => ({
	getDecisionLearningConfig: policy,
}));

afterEach(() => vi.useRealTimers());

it("batches recipient changes under one delayed workflow admission key", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-20T07:00:01.000Z"));
	policy.mockResolvedValue({
		deckCurators: [
			{
				enabled: true,
				tediId: "curator",
				recipientId: "recipient",
				gadgetId: "deck",
				trigger: { enabled: true, skillId: "skill", debounceSeconds: 60 },
			},
		],
	});
	const send = vi.fn().mockResolvedValue(undefined);
	const context = {
		env: { AUTOMATION_EVENTS: { send } },
	} as unknown as BaseContext;
	const card = {
		orgId: "org",
		targetType: "user",
		targetId: "recipient",
		status: "open",
	};
	const actor = { type: "external_agent", id: "author" };
	await queueDeckCuration(context, card, actor);
	await queueDeckCuration(context, card, actor);
	expect(send).toHaveBeenCalledTimes(2);
	expect(send.mock.calls[0]).toEqual(send.mock.calls[1]);
	expect(send.mock.calls[0]).toEqual([
		{
			kind: "skill_workflow",
			organizationId: "org",
			tediId: "curator",
			skillId: "skill",
			params: {
				recipientId: "recipient",
				gadgetId: "deck",
				source: "recipient_card_changed",
			},
			idempotencyKey: expect.stringMatching(/^deck-curation:[a-f0-9]{64}$/),
			source: "deck-curation-trigger",
		},
		{ delaySeconds: 60 },
	]);
	await queueDeckCuration(context, card, { type: "tedi", id: "curator" });
	await queueDeckCuration(context, { ...card, targetId: "other" }, actor);
	await queueDeckCuration(context, { ...card, status: "cancelled" }, actor);
	expect(send).toHaveBeenCalledTimes(2);
});

it("keeps recipient grants separate and bounds keys for long recipient ids", async () => {
	const recipients = ["a".repeat(300), "b".repeat(300)];
	policy.mockResolvedValue({
		deckCurators: recipients.map((recipientId) => ({
			enabled: true,
			tediId: "curator",
			recipientId,
			gadgetId: "deck",
			trigger: { enabled: true, skillId: "skill", debounceSeconds: 60 },
		})),
	});
	const send = vi.fn().mockResolvedValue(undefined);
	for (const targetId of recipients)
		await queueDeckCuration(
			{ env: { AUTOMATION_EVENTS: { send } } } as unknown as BaseContext,
			{ orgId: "org", targetType: "user", targetId, status: "open" },
			{ type: "external_agent", id: "author" },
		);
	expect(send).toHaveBeenCalledTimes(2);
	const keys = send.mock.calls.map(([event]) => event.idempotencyKey);
	expect(new Set(keys).size).toBe(2);
	expect(keys.every((key) => key.length <= 128)).toBe(true);
});

it("does not queue a disabled grant", async () => {
	policy.mockResolvedValue({
		deckCurators: [{ enabled: false }],
	});
	const send = vi.fn();
	await queueDeckCuration(
		{ env: { AUTOMATION_EVENTS: { send } } } as unknown as BaseContext,
		{ orgId: "org", targetType: "user", targetId: "recipient", status: "open" },
		{ type: "tedi", id: "author" },
	);
	expect(send).not.toHaveBeenCalled();
});
