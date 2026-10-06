import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DbClient } from "@tedix/db/client";
import {
	buildJevActionQuestion,
	resolveJevAction,
	selectJevAction,
} from "./jev-action-selection";
const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../../../services/jev-judgment", () => ({
	executeJevJudgment: mocks.execute,
}));
const candidates = [
	{ id: "invoices.create", description: "Create a draft invoice" },
	{ id: "invoices.delete", description: "Delete an invoice permanently" },
];
const choice = (key: string, confidence = 0.95) => ({
	type: "choice" as const,
	choice: key,
	confidence,
	probabilities: { [key]: confidence },
});
beforeEach(() => {
	mocks.execute.mockReset();
});

describe("bounded action judgment", () => {
	it("encodes exact eligible choices plus explicit abstention, without argument generation", () => {
		const question = buildJevActionQuestion(candidates);
		expect(question.type).toBe("choice");
		if (question.type !== "choice") throw Error("wrong type");
		expect(Object.keys(question.criteria)).toEqual(["NONE", "a0", "a1"]);
		expect(question.instructions).toContain("not authorization");
		expect(question.instructions).toContain("untrusted");
	});
	it.each([
		["a0", 0.95, "invoices.create", "selected"],
		["a1", 0.95, "invoices.delete", "selected"],
		["NONE", 0.99, null, "none"],
		["a0", 0.79, null, "uncertain"],
		["a2", 0.99, null, "unavailable"],
		["a00", 0.99, null, "unavailable"],
		["a0", NaN, null, "uncertain"],
	] as const)(
		"%s at %s resolves only into exact catalog",
		(key, confidence, toolName, reason) => {
			expect(resolveJevAction(choice(key, confidence), candidates)).toEqual({
				toolName,
				reason,
			});
		},
	);
	it("dispatches the default judgment with org/run attribution and bounded deadline", async () => {
		mocks.execute.mockResolvedValue({ answers: { action: choice("a0") } });
		const context = { organizationId: "org", runId: "run" };
		const onExecutionAttempts = vi.fn();
		expect(
			await selectJevAction({
				db: {} as DbClient,
				env: {},
				context,
				content: "Create an invoice",
				candidates,
				timeoutMs: 60000,
				onExecutionAttempts,
			}),
		).toEqual({ toolName: "invoices.create", reason: "selected" });
		expect(mocks.execute).toHaveBeenCalledWith(
			expect.objectContaining({
				context,
				source: "kernel:action-selection",
				billingSource: "kernel",
				sessionType: "kernel",
				timeoutMs: 5000,
				onExecutionAttempts,
			}),
		);
	});
	it("declines duplicate IDs before paid dispatch", async () => {
		const result = await selectJevAction({
			db: {} as DbClient,
			env: {},
			context: { organizationId: "org" },
			content: "create",
			candidates: [candidates[0]!, candidates[0]!],
		});
		expect(result.reason).toBe("invalid_candidates");
		expect(mocks.execute).not.toHaveBeenCalled();
	});
	it.each([null, "provider unavailable", "receipt persistence failed"])(
		"failure safely declines with no resend",
		async (failure) => {
			if (failure) mocks.execute.mockRejectedValue(new Error(failure));
			else mocks.execute.mockResolvedValue(failure);
			expect(
				(
					await selectJevAction({
						db: {} as DbClient,
						env: {},
						context: { organizationId: "org" },
						content: "create",
						candidates,
					})
				).reason,
			).toBe("unavailable");
			expect(mocks.execute).toHaveBeenCalledTimes(1);
		},
	);
});

/** Held-out synthetic labels for provider evaluation; not a claim of live model accuracy. */
export const ACTION_SELECTION_CASES = [
	{
		id: "create-en",
		request: "Create a draft invoice for this customer",
		expected: "invoices.create",
	},
	{
		id: "create-es",
		request: "Crea una factura en borrador para este cliente",
		expected: "invoices.create",
	},
	{
		id: "delete-explicit",
		request: "Permanently delete the invoice I selected",
		expected: "invoices.delete",
	},
	{ id: "read-only", request: "Show me the current invoice", expected: null },
	{
		id: "negated",
		request: "Do not create or delete an invoice",
		expected: null,
	},
	{
		id: "multiple-actions",
		request: "Create a new invoice and delete the old one",
		expected: null,
	},
	{ id: "unrelated", request: "Send an email to the customer", expected: null },
] as const;
