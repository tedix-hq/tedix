import * as z from "zod";
import { JsonValueSchema } from "./common";

// Nested callers retain time to return a terminal durable execution result.
export const TEDI_DURABLE_CODE_EXECUTION_TIMEOUT_MS = 300_000;
export const TEDI_DURABLE_CODE_TRANSPORT_TIMEOUT_MS = 315_000;
export const TEDI_DURABLE_CODE_GATEWAY_TIMEOUT_MS = 330_000;

const worker = { tediId: z.uuid() };
// Codemode execution ids are exec_<timestamp>_<UUID>, not bare UUIDs.
const executionId = z.string().min(1).max(256);
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const RunTediDurableCodeInputSchema = z.strictObject({
	...worker,
	code: z.string().min(1).max(1_000_000),
});
export const ListTediCodeExecutionsInputSchema = z.strictObject({
	...worker,
	limit: z.number().int().positive().max(100).default(20),
});
export const GetTediCodeExecutionInputSchema = z.strictObject({
	...worker,
	executionId,
});
export const ApproveTediCodeExecutionInputSchema =
	GetTediCodeExecutionInputSchema;
export const RollbackTediCodeExecutionInputSchema =
	GetTediCodeExecutionInputSchema;
export const RejectTediCodeExecutionInputSchema = z.strictObject({
	...worker,
	executionId,
	seq: sequence,
});

// These mirror the runtime's redacted projection, not its private replay state.
const omitted = z.number().int().nonnegative().optional();
const projectedText = (maximum: number) =>
	z.string().max(maximum + "\n…(truncated)".length);
const call = z.object({
	seq: sequence,
	connector: z.string(),
	method: z.string(),
	args: JsonValueSchema,
	result: JsonValueSchema.optional(),
	requiresApproval: z.boolean(),
	ephemeral: z.boolean().optional(),
	state: z.enum(["executing", "applied", "pending", "reverted", "error"]),
});
const calls = z.array(call).max(20);
const logs = z.array(projectedText(1_000)).max(20);
const output = {
	// Invalid source may produce an error before an execution id exists.
	executionId: z.string(),
	calls: calls.optional(),
	callsOmitted: omitted,
};
export const TediDurableCodeOutputSchema = z.discriminatedUnion("status", [
	z.object({
		...output,
		status: z.literal("completed"),
		result: JsonValueSchema.optional(),
		logs: logs.optional(),
	}),
	z.object({
		...output,
		status: z.literal("paused"),
		pending: z
			.array(
				z.object({
					executionId: z.string(),
					seq: sequence,
					connector: z.string(),
					method: z.string(),
					args: JsonValueSchema,
				}),
			)
			.max(20),
		pendingOmitted: omitted,
	}),
	z.object({
		...output,
		status: z.literal("error"),
		error: projectedText(1_000),
		logs: logs.optional(),
	}),
]);
export const TediCodeExecutionSchema = z.object({
	id: executionId,
	code: projectedText(4_000),
	status: z.enum([
		"running",
		"paused",
		"completed",
		"error",
		"rejected",
		"rolled_back",
	]),
	log: calls,
	result: JsonValueSchema.optional(),
	error: projectedText(1_000).optional(),
	logs: logs.optional(),
	connectors: z.array(z.string()).optional(),
	createdAt: z.number().finite(),
	updatedAt: z.number().finite(),
	codeTruncated: z.boolean().optional(),
	logOmitted: omitted,
	logsOmitted: omitted,
});
export const GetTediCodeExecutionOutputSchema = z.union([
	TediCodeExecutionSchema,
	z.object({
		ok: z.literal(false),
		error: z.literal("execution_not_found"),
		execution_id: executionId,
	}),
]);
export const ListTediCodeExecutionsOutputSchema = z.object({
	executions: z.array(TediCodeExecutionSchema).max(100),
});
export const RejectTediCodeExecutionOutputSchema = z.object({
	ok: z.boolean(),
	execution_id: executionId,
	seq: sequence,
});
export const RollbackTediCodeExecutionOutputSchema = z.object({
	ok: z.literal(true),
	execution_id: executionId,
});

export const RecoverTediCodeExecutionInputSchema = z.strictObject({
	...worker,
	executionId,
});
export const RecoverTediCodeExecutionOutputSchema = z.discriminatedUnion(
	"recovered",
	[
		z.object({
			recovered: z.literal(true),
			execution_id: executionId,
			execution_status: z.literal("error"),
			completion: z.literal("unconfirmed"),
			effects_may_have_occurred: z.literal(true),
		}),
		z.object({
			recovered: z.literal(false),
			execution_id: executionId,
			reason: z.enum([
				"active_pass",
				"execution_not_found",
				"not_running",
				"revision_changed",
				"too_recent",
			]),
		}),
	],
);
