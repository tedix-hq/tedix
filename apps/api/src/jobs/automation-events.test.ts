import { describe, expect, it } from "vite-plus/test";
import type { AutomationQueueMessage } from "./automation-events";
import {
	buildAutomationSkillWorkflowInput,
	consumeAutomationEvents,
	handleAutomationEventMessage,
} from "./automation-events";

const ORG = "0f0f0f0f-0000-4000-8000-000000000001";
const TEDI = "5eed0024-0000-4000-8000-000000000024";

const env = {} as CloudflareEnv;

describe("handleAutomationEventMessage", () => {
	it("preserves the reviewed revision separately from untrusted workflow parameters", () => {
		const input = buildAutomationSkillWorkflowInput({
			kind: "skill_workflow",
			organizationId: ORG,
			tediId: TEDI,
			skillId: "skill",
			expectedSkillRevision: 7,
			params: { expectedSkillRevision: 99 },
			idempotencyKey: "revision:7",
		});
		expect(input.expectedSkillRevision).toBe(7);
		expect(input.params.expectedSkillRevision).toBe(99);
	});
	it("maps queue idempotency to both admission and tenant deliverable context", () => {
		expect(
			buildAutomationSkillWorkflowInput({
				kind: "skill_workflow",
				organizationId: ORG,
				tediId: TEDI,
				slug: "kitchen-sink",
				params: {
					week: "2026-07-06",
					automationIdempotencyKey: "caller-must-not-override",
				},
				idempotencyKey: "ks:2026-07-06",
			}),
		).toEqual({
			skillId: undefined,
			slug: "kitchen-sink",
			tediId: TEDI,
			idempotencyKey: "ks:2026-07-06",
			params: {
				week: "2026-07-06",
				automationIdempotencyKey: "ks:2026-07-06",
			},
		});
	});

	it("acks poison messages without dispatching (never retry-loops)", async () => {
		let dispatched = false;
		const outcome = await handleAutomationEventMessage(
			env,
			{ kind: "nope", garbage: true },
			{},
			{
				runSkillWorkflow: async () => {
					dispatched = true;
					return { status: "queued" };
				},
				enqueueTediTurn: async () => {
					dispatched = true;
					return { status: "queued" };
				},
			},
		);
		expect(outcome).toBe("ack");
		expect(dispatched).toBe(false);
	});

	it("dispatches skill_workflow events and acks", async () => {
		let seen: unknown;
		const outcome = await handleAutomationEventMessage(
			env,
			{
				kind: "skill_workflow",
				organizationId: ORG,
				tediId: TEDI,
				slug: "kitchen-sink",
				params: { week: "2026-07-06" },
				idempotencyKey: "ks:2026-07-06",
			},
			{},
			{
				runSkillWorkflow: async (e) => {
					seen = e;
					return { status: "queued" };
				},
			},
		);
		expect(outcome).toBe("ack");
		expect((seen as { slug: string }).slug).toBe("kitchen-sink");
	});

	it("dispatches tedi_turn events, retries on failed status", async () => {
		const outcome = await handleAutomationEventMessage(
			env,
			{
				kind: "tedi_turn",
				organizationId: ORG,
				tediId: TEDI,
				content: "run the weekly report",
				idempotencyKey: "turn:1",
			},
			{},
			{ enqueueTediTurn: async () => ({ status: "failed" }) },
		);
		expect(outcome).toBe("retry");
	});

	it("retries when dispatch throws (transient)", async () => {
		const outcome = await handleAutomationEventMessage(
			env,
			{
				kind: "skill_workflow",
				organizationId: ORG,
				tediId: TEDI,
				skillId: "5eed0021-0000-4000-8000-000000000021",
				idempotencyKey: "ks:throw",
			},
			{},
			{
				runSkillWorkflow: async () => {
					throw new Error("upstream 503");
				},
			},
		);
		expect(outcome).toBe("retry");
	});
});

describe("consumeAutomationEvents", () => {
	it("settles each message independently", async () => {
		const settled: string[] = [];
		const msg = (body: unknown, tag: string): AutomationQueueMessage => ({
			body,
			ack: () => settled.push(`ack:${tag}`),
			retry: () => settled.push(`retry:${tag}`),
		});
		await consumeAutomationEvents(
			env,
			[
				msg({ kind: "bogus" }, "poison"),
				msg(
					{
						kind: "tedi_turn",
						organizationId: ORG,
						tediId: TEDI,
						content: "hello",
						idempotencyKey: "a",
					},
					"good",
				),
				msg(
					{
						kind: "tedi_turn",
						organizationId: ORG,
						tediId: TEDI,
						content: "hello",
						idempotencyKey: "b",
					},
					"bad",
				),
			],
			{},
			{
				enqueueTediTurn: async (e) => ({
					status: e.idempotencyKey === "b" ? "failed" : "queued",
				}),
			},
		);
		expect(settled.sort()).toEqual(["ack:good", "ack:poison", "retry:bad"]);
	});

	it("dispatches a batch concurrently, not one message after another", async () => {
		const turn = (key: string): AutomationQueueMessage => ({
			body: {
				kind: "tedi_turn",
				organizationId: ORG,
				tediId: TEDI,
				content: "draft",
				idempotencyKey: key,
			},
			ack: () => {},
			retry: () => {},
		});
		const started: string[] = [];
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const consumed = consumeAutomationEvents(
			env,
			[turn("a"), turn("b")],
			{},
			{
				enqueueTediTurn: async (e) => {
					started.push(e.idempotencyKey);
					await held;
					return { status: "queued" };
				},
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toEqual(["a", "b"]);
		release();
		await consumed;
	});

	it("skips a fallback drafting turn once the question has a draft", async () => {
		const dispatched: string[] = [];
		const event = (key: string, interactionId: string) => ({
			kind: "tedi_turn",
			organizationId: ORG,
			tediId: TEDI,
			content: "draft",
			idempotencyKey: key,
			skipIfReplyDraftFor: interactionId,
		});
		const deps = {
			hasReplyDraft: async (_org: string, id: string) => id === "drafted",
			enqueueTediTurn: async (e: { idempotencyKey: string }) => {
				dispatched.push(e.idempotencyKey);
				return { status: "queued" };
			},
		};
		await expect(
			handleAutomationEventMessage(env, event("a", "drafted"), {}, deps),
		).resolves.toBe("ack");
		await expect(
			handleAutomationEventMessage(env, event("b", "missed"), {}, deps),
		).resolves.toBe("ack");
		expect(dispatched).toEqual(["b"]);
	});
});
