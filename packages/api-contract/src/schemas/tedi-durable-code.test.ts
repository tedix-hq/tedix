import { buildCompletionEvidence } from "./execution-evidence";
import {
	RecoverTediCodeExecutionInputSchema,
	RecoverTediCodeExecutionOutputSchema,
} from "./tedi-durable-code";
import { describe, expect, it } from "vite-plus/test";
import {
	RunTediDurableCodeInputSchema,
	ListTediCodeExecutionsInputSchema,
	GetTediCodeExecutionInputSchema,
	RejectTediCodeExecutionInputSchema,
	TediDurableCodeOutputSchema,
	TediCodeExecutionSchema,
	GetTediCodeExecutionOutputSchema,
	RejectTediCodeExecutionOutputSchema,
	RollbackTediCodeExecutionOutputSchema,
} from "./tedi-durable-code";
const tediId = "11111111-1111-4111-8111-111111111111";
const executionId =
	"exec_0001791124574000_11111111-1111-4111-8111-111111111111";
describe("durable worker operation contracts", () => {
	it("preserves exact code and validates runtime code bounds", () => {
		const code = "  async () => 'hi'\n";
		expect(RunTediDurableCodeInputSchema.parse({ tediId, code }).code).toBe(
			code,
		);
		for (const invalid of [
			{ tediId: "cto", code },
			{ tediId, code: "" },
			{ tediId, code: "x".repeat(1_000_001) },
			{ tediId, code, organizationId: tediId },
			{ tediId, code, runtimeUrl: "https://other.invalid" },
		])
			expect(RunTediDurableCodeInputSchema.safeParse(invalid).success).toBe(
				false,
			);
	});
	it("defaults and bounds execution listings", () => {
		expect(ListTediCodeExecutionsInputSchema.parse({ tediId }).limit).toBe(20);
		for (const limit of [0, -1, 1.5, 101])
			expect(
				ListTediCodeExecutionsInputSchema.safeParse({ tediId, limit }).success,
			).toBe(false);
		expect(
			ListTediCodeExecutionsInputSchema.parse({ tediId, limit: 100 }).limit,
		).toBe(100);
	});
	it("accepts actual execution ids and rejects invalid sequences", () => {
		expect(
			GetTediCodeExecutionInputSchema.parse({ tediId, executionId })
				.executionId,
		).toBe(executionId);
		for (const seq of [-1, 1.1, Number.MAX_SAFE_INTEGER + 1])
			expect(
				RejectTediCodeExecutionInputSchema.safeParse({
					tediId,
					executionId,
					seq,
				}).success,
			).toBe(false);
		expect(
			RejectTediCodeExecutionInputSchema.parse({ tediId, executionId, seq: 0 })
				.seq,
		).toBe(0);
	});
	it("preserves error and paused outcomes instead of treating them as success", () => {
		for (const result of [
			{
				status: "completed",
				executionId,
				result: { __tedix_truncated: true, preview: "sample" },
			},
			{
				status: "paused",
				executionId,
				pending: [
					{
						executionId,
						seq: 0,
						connector: "workspace",
						method: "write_file",
						args: { path: "a" },
					},
				],
				pendingOmitted: 1,
			},
			{ status: "error", executionId: "", error: "Invalid source" },
		])
			expect(TediDurableCodeOutputSchema.parse(result)).toEqual(result);
		expect(
			TediDurableCodeOutputSchema.safeParse({ status: "paused", executionId })
				.success,
		).toBe(false);
	});
	it("preserves explicit missing executions and unsuccessful rejection", () => {
		const missing = {
			ok: false,
			error: "execution_not_found",
			execution_id: executionId,
		};
		expect(GetTediCodeExecutionOutputSchema.parse(missing)).toEqual(missing);
		expect(
			RejectTediCodeExecutionOutputSchema.parse({
				ok: false,
				execution_id: executionId,
				seq: 2,
			}).ok,
		).toBe(false);
		expect(
			RollbackTediCodeExecutionOutputSchema.safeParse({
				ok: false,
				execution_id: executionId,
			}).success,
		).toBe(false);
	});
	it("accepts projected truncation suffixes and all persisted statuses", () => {
		for (const status of [
			"running",
			"paused",
			"completed",
			"error",
			"rejected",
			"rolled_back",
		]) {
			const execution = {
				id: executionId,
				code: "a".repeat(4000) + "\n…(truncated)",
				status,
				log: [],
				logs: ["b".repeat(1000) + "\n…(truncated)"],
				createdAt: 1,
				updatedAt: 2,
				codeTruncated: true,
				logOmitted: 3,
			};
			expect(TediCodeExecutionSchema.parse(execution)).toEqual(execution);
		}
	});
});

it("recovery exposes only worker and execution, with truthful unconfirmed outcomes", () => {
	const input = {
		tediId: "11111111-1111-4111-8111-111111111111",
		executionId: "exec_test",
	};
	expect(RecoverTediCodeExecutionInputSchema.parse(input)).toEqual(input);
	expect(
		RecoverTediCodeExecutionInputSchema.safeParse({
			...input,
			expectedUpdatedAt: 0,
		}).success,
	).toBe(false);
	const output = {
		recovered: true,
		execution_id: "exec_test",
		execution_status: "error",
		completion: "unconfirmed",
		effects_may_have_occurred: true,
	};
	expect(RecoverTediCodeExecutionOutputSchema.parse(output)).toEqual(output);
	expect(
		RecoverTediCodeExecutionOutputSchema.safeParse({
			...output,
			effects_may_have_occurred: false,
		}).success,
	).toBe(false);
});

it("successful recovery evidence reports the operation succeeded while the original execution remains unconfirmed", () => {
	const output = RecoverTediCodeExecutionOutputSchema.parse({
		recovered: true,
		execution_id: "exec_test",
		execution_status: "error",
		completion: "unconfirmed",
		effects_may_have_occurred: true,
	});
	for (const operation of [
		"recover_code_execution",
		"recover_tedi_code_execution",
	]) {
		const evidence = buildCompletionEvidence({
			operation,
			result: output,
			retryKey: "recovery-proof",
		});
		expect(evidence.status).toBe("succeeded");
		expect(evidence.retry.retryable).toBe(false);
	}
	expect(output.execution_status).toBe("error");
	expect(output.completion).toBe("unconfirmed");
});
