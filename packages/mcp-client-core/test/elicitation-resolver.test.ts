/**
 * Agent-to-agent elicitation resolver: a tedi answers another server's
 * `input_required` round-trip from its own reasoning (model seam) or a
 * deterministic schema fill — no human prompt.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import {
	createAgentElicitationResolver,
	deterministicElicitationAnswer,
	type ElicitationModel,
} from "../src/elicitation-resolver";

const FORM_SCHEMA = {
	type: "object" as const,
	properties: {
		reason: { type: "string", title: "Reason" },
		urgency: { type: "string", enum: ["low", "high"] },
		count: { type: "number" },
		confirm: { type: "boolean", default: true },
	},
	required: ["reason", "urgency", "count"],
};

describe("deterministicElicitationAnswer", () => {
	it("fills enum/default and typed zero-values for required fields", () => {
		const answer = deterministicElicitationAnswer(FORM_SCHEMA);
		expect(answer).toEqual({
			reason: "", // required string, no default → zero value
			urgency: "low", // first enum member
			count: 0, // required number → 0
			confirm: true, // default echoed even though optional
		});
	});

	it("backfills a required field with no property definition", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {},
			required: ["mystery"],
		});
		expect(answer).toEqual({ mystery: "" });
	});

	it("picks the first enum member for a titled enum (SEP-1330 enumNames)", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {
				tier: {
					type: "string",
					enum: ["free", "pro", "ent"],
					enumNames: ["Free", "Pro", "Enterprise"],
				},
			},
			required: ["tier"],
		});
		// Answer carries the raw enum VALUE, never the display label.
		expect(answer).toEqual({ tier: "free" });
	});

	it("multi-select: honors minItems by picking items.enum members (SEP-1330)", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {
				scopes: {
					type: "array",
					items: { type: "string", enum: ["read", "write", "admin"] },
					minItems: 2,
					uniqueItems: true,
				},
			},
			required: ["scopes"],
		});
		expect(answer).toEqual({ scopes: ["read", "write"] });
	});

	it("multi-select: required array with minItems 0/undefined → empty array", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {
				scopes: {
					type: "array",
					items: { type: "string", enum: ["read", "write"] },
				},
			},
			required: ["scopes"],
		});
		expect(answer).toEqual({ scopes: [] });
	});

	it("multi-select: an array-level default is echoed (SEP-1034)", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {
				scopes: {
					type: "array",
					items: { type: "string", enum: ["read", "write", "admin"] },
					default: ["admin"],
					minItems: 1,
				},
			},
			required: ["scopes"],
		});
		// The default wins over the minItems-derived pick.
		expect(answer).toEqual({ scopes: ["admin"] });
	});

	it("honors per-type defaults for boolean and number (SEP-1034)", () => {
		const answer = deterministicElicitationAnswer({
			type: "object",
			properties: {
				dryRun: { type: "boolean", default: false },
				retries: { type: "number", default: 3 },
			},
			required: ["dryRun", "retries"],
		});
		expect(answer).toEqual({ dryRun: false, retries: 3 });
	});
});

describe("createAgentElicitationResolver — deterministic (no model)", () => {
	it("resolves an elicitation/create-shaped request keyed identically", async () => {
		const resolve = createAgentElicitationResolver();
		const responses = await resolve({
			taskId: "task_1",
			inputRequests: {
				form_a: {
					method: "elicitation/create",
					params: { message: "Why?", requestedSchema: FORM_SCHEMA },
				},
			},
		});
		// Spec-shaped ElicitResult envelope (MRTR): { action, content }.
		expect(responses).toEqual({
			form_a: {
				action: "accept",
				content: { reason: "", urgency: "low", count: 0, confirm: true },
			},
		});
	});

	it("returns null when there are no pending requests", async () => {
		const resolve = createAgentElicitationResolver();
		expect(await resolve({ taskId: "t", inputRequests: {} })).toBeNull();
	});
});

describe("createAgentElicitationResolver — model seam (agent reasoning)", () => {
	it("uses the model answer and reconciles missing required fields", async () => {
		const model: ElicitationModel = vi.fn(
			async ({ requestedSchema, message }) => {
				expect(message).toBe("Why?");
				expect(requestedSchema.required).toContain("reason");
				// Model answers reason + urgency but forgets the required `count`.
				return { reason: "deploy hotfix", urgency: "high" };
			},
		);
		const resolve = createAgentElicitationResolver({ model });
		const responses = await resolve({
			taskId: "task_2",
			inputRequests: {
				form_a: {
					method: "elicitation/create",
					params: { message: "Why?", requestedSchema: FORM_SCHEMA },
				},
			},
		});
		expect(model).toHaveBeenCalledTimes(1);
		expect(responses).toMatchObject({
			form_a: {
				action: "accept",
				content: {
					reason: "deploy hotfix",
					urgency: "high",
					count: 0, // backfilled required field
				},
			},
		});
	});

	it("passes boolean/number model answers through reconcileWithSchema unchanged", async () => {
		const schema = {
			type: "object" as const,
			properties: {
				dryRun: { type: "boolean", default: true },
				retries: { type: "number", default: 3 },
			},
			required: ["dryRun", "retries"],
		};
		// Model returns falsy-but-valid values that must NOT be clobbered by the
		// schema defaults during reconciliation.
		const model: ElicitationModel = async () => ({ dryRun: false, retries: 0 });
		const resolve = createAgentElicitationResolver({ model });
		const responses = await resolve({
			taskId: "task_defaults",
			inputRequests: { form_a: { requestedSchema: schema } },
		});
		expect(responses).toEqual({
			form_a: { action: "accept", content: { dryRun: false, retries: 0 } },
		});
	});

	it("falls back to deterministic fill when the model throws", async () => {
		const warn = vi.fn();
		const model: ElicitationModel = vi.fn(async () => {
			throw new Error("model down");
		});
		const resolve = createAgentElicitationResolver({
			model,
			logger: { warn },
		});
		const responses = await resolve({
			taskId: "task_3",
			inputRequests: { form_a: { requestedSchema: FORM_SCHEMA } },
		});
		expect(warn).toHaveBeenCalled();
		expect(responses).toEqual({
			form_a: {
				action: "accept",
				content: { reason: "", urgency: "low", count: 0, confirm: true },
			},
		});
	});

	it("resolves multiple requests independently", async () => {
		const model: ElicitationModel = async ({ key }) =>
			key === "first" ? { reason: "a", urgency: "high", count: 1 } : null;
		const resolve = createAgentElicitationResolver({ model });
		const responses = await resolve({
			taskId: "task_4",
			inputRequests: {
				first: { requestedSchema: FORM_SCHEMA },
				second: { requestedSchema: FORM_SCHEMA },
			},
		});
		expect(responses?.first).toMatchObject({
			action: "accept",
			content: { reason: "a", count: 1 },
		});
		// second → null model answer → deterministic
		expect(responses?.second).toMatchObject({
			action: "accept",
			content: { reason: "", urgency: "low" },
		});
	});
});
