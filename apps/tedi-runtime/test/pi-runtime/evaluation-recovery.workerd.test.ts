import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import { wrapUntrustedInput } from "@tedix/chat-transport/untrusted-input";
import type { PiAccountingCheckpoint } from "../../src/pi-turn-accounting";
import type { PiSynthesisFixture } from "./worker";

const fixture = (name: string) =>
	getAgentByName(
		(
			env as unknown as {
				PI_SYNTHESIS: DurableObjectNamespace<PiSynthesisFixture>;
			}
		).PI_SYNTHESIS,
		name,
	);

it("does not redispatch an isolated evaluation after its settled receipt but before native answer commit", async () => {
	const name = crypto.randomUUID();
	const runId = "settled-evaluation";
	const agent = await fixture(name);
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.put("evaluation:receipt-failure", "hold");
	});
	const interrupted = agent.evaluation(runId).then(
		(value) => ({ value }),
		(error) => ({ error: String(error) }),
	);
	await expect
		.poll(() =>
			runInDurableObject(
				agent,
				async (_facet, ctx) =>
					(await ctx.storage.get("evaluation:receipt-held")) === true,
			),
		)
		.toBe(true);
	const before = await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.delete("evaluation:receipt-failure");
		expect(
			await ctx.storage.get(`pi:tool-free-result:tedix:synthesis:${runId}`),
		).toBeUndefined();
		return await ctx.storage.get<PiAccountingCheckpoint>(
			`pi-accounting:${runId}`,
		);
	});
	expect(before?.attempts).toHaveLength(1);
	expect(before?.attempts[0]).toMatchObject({
		phase: "completed",
		acknowledged: true,
		usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
	});
	await abortAllDurableObjects();
	await interrupted;
	const reopened = await fixture(name);
	const recovered = await reopened
		.runSynthesisTurn({
			text: wrapUntrustedInput("Judge only this blinded input.", "mcp"),
		})
		.then(
			(result) => ({ result, error: null }),
			(error) => ({ result: null, error: String(error) }),
		);
	const view = JSON.parse(await reopened.inspectToolFree());
	expect(view.stats.requests).toBe(1);
	expect(recovered.result).toBeNull();
	expect(recovered.error).toContain("Durable provider-call ceiling reached");
	await runInDurableObject(reopened, async (_facet, ctx) => {
		const after = await ctx.storage.get<PiAccountingCheckpoint>(
			`pi-accounting:${runId}`,
		);
		expect(after?.attempts).toEqual(before?.attempts);
		expect(
			ctx.storage.sql
				.exec<{ step_id: string; actual_tokens: number }>(
					"SELECT step_id, actual_tokens FROM inference_step_usage WHERE turn_id=?",
					runId,
				)
				.toArray(),
		).toEqual([{ step_id: before!.attempts[0]!.id, actual_tokens: 5 }]);
		expect(
			await ctx.storage.get(`pi:tool-free-result:tedix:synthesis:${runId}`),
		).toBeUndefined();
	});
});

it("does not issue another SDK request when a settled evaluation receipt acknowledgement fails", async () => {
	const agent = await fixture(crypto.randomUUID());
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.put("evaluation:receipt-failure", "ack");
	});
	const outcome = JSON.parse(await agent.evaluation("receipt-ack-evaluation"));
	expect(outcome.stats.requests).toBe(1);
	expect(outcome.error).not.toBeNull();
	expect(outcome.receipt.payload).toMatchObject({
		dispatched: true,
		usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
	});
});

it("preserves an unknown evaluation attempt across cold recovery without a second SDK call", async () => {
	const name = crypto.randomUUID();
	const runId = "unknown-evaluation";
	const agent = await fixture(name);
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.put("tool-free:hold-sdk", true);
	});
	const interrupted = agent.evaluation(runId).catch(String);
	await expect
		.poll(() =>
			runInDurableObject(
				agent,
				async (_facet, ctx) =>
					(await ctx.storage.get("tool-free:sdk-held")) === true,
			),
		)
		.toBe(true);
	const before = await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.delete("tool-free:hold-sdk");
		expect(await ctx.storage.get("evaluation:receipt")).toBeUndefined();
		return await ctx.storage.get<PiAccountingCheckpoint>(
			`pi-accounting:${runId}`,
		);
	});
	expect(before?.attempts).toHaveLength(1);
	expect(before?.attempts[0]).toMatchObject({ phase: "started", usage: null });
	await abortAllDurableObjects();
	await interrupted;
	const reopened = await fixture(name);
	const recovered = await reopened
		.runSynthesisTurn({
			text: wrapUntrustedInput("Judge only this blinded input.", "mcp"),
		})
		.then(
			(result) => ({ result, error: null }),
			(error) => ({ result: null, error: String(error) }),
		);
	expect(recovered.result).toBeNull();
	expect(recovered.error).toContain("Durable provider-call ceiling reached");
	expect(JSON.parse(await reopened.inspectToolFree()).stats.requests).toBe(1);
	await runInDurableObject(reopened, async (_facet, ctx) => {
		const after = await ctx.storage.get<PiAccountingCheckpoint>(
			`pi-accounting:${runId}`,
		);
		expect(after?.attempts).toHaveLength(1);
		expect(after?.attempts[0]).toMatchObject({
			id: before?.attempts[0]?.id,
			phase: "unknown",
			usage: null,
		});
		expect(await ctx.storage.get("evaluation:receipt")).toBeUndefined();
		expect(
			await ctx.storage.get(`pi:tool-free-result:tedix:synthesis:${runId}`),
		).toBeUndefined();
	});
});

it("keeps ordinary tool-free recovery behavior and both measured usage receipts", async () => {
	const name = crypto.randomUUID();
	const agent = await fixture(name);
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.put("tool-free:hold-budget-receipt", true);
	});
	const interrupted = agent.turn("ordinary-retry").catch(String);
	await expect
		.poll(() =>
			runInDurableObject(
				agent,
				async (_facet, ctx) =>
					(await ctx.storage.get("tool-free:budget-receipt-held")) === true,
			),
		)
		.toBe(true);
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.delete("tool-free:hold-budget-receipt");
	});
	await abortAllDurableObjects();
	await interrupted;
	const reopened = await fixture(name);
	const result = await reopened.runSynthesisTurn({ text: "ordinary-retry" });
	expect(result.assistantText).toBe("synthesis-model:ordinary-retry");
	expect(result.usage).toMatchObject({
		inputTokens: 6,
		outputTokens: 4,
		totalTokens: 10,
	});
	expect(JSON.parse(await reopened.inspectToolFree()).stats.requests).toBe(2);
	await runInDurableObject(reopened, async (_facet, ctx) => {
		const checkpoint = await ctx.storage.get<PiAccountingCheckpoint>(
			"pi-accounting:ordinary-retry",
		);
		expect(checkpoint?.attempts).toHaveLength(2);
		for (const attempt of checkpoint!.attempts)
			expect(attempt).toMatchObject({
				phase: "completed",
				acknowledged: true,
				usage: { totalTokens: 5 },
			});
	});
});

it("uses an unused prepared reservation for the first isolated SDK call", async () => {
	const agent = await fixture(crypto.randomUUID());
	const runId = "prepared-evaluation";
	await runInDurableObject(agent, async (_facet, ctx) => {
		const checkpoint: PiAccountingCheckpoint = {
			version: 1,
			runId,
			fault: null,
			attempts: [
				{
					id: "unused-reservation",
					estimatedTokens: 100,
					phase: "prepared",
					usage: null,
					acknowledged: false,
					effectsStarted: false,
				},
			],
		};
		await ctx.storage.put(`pi-accounting:${runId}`, checkpoint);
	});
	const outcome = JSON.parse(await agent.evaluation(runId));
	expect(outcome.error).toBeNull();
	expect(outcome.stats.requests).toBe(1);
	expect(outcome.stats.reservations).toEqual(["unused-reservation"]);
	expect(outcome.receipt.payload.providerAttempt.attemptId).toBe(
		"unused-reservation",
	);
});

it("keeps canceled evaluation authority fenced before SDK dispatch", async () => {
	const agent = await fixture(crypto.randomUUID());
	await runInDurableObject(agent, async (_facet, ctx) => {
		await ctx.storage.put("tool-free:cancel:canceled-evaluation", true);
	});
	const outcome = JSON.parse(await agent.evaluation("canceled-evaluation"));
	expect(outcome.error).toContain("authority cancelled");
	expect(outcome.stats.requests).toBe(0);
	expect(outcome.stats.reservations).toEqual([]);
	expect(outcome.receipt).toBeUndefined();
});
