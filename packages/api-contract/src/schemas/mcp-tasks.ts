import * as z from "zod";
import { JsonValueSchema } from "./common";

export const McpTaskStatusSchema = z.enum([
	"working",
	"input_required",
	"completed",
	"cancelled",
	"failed",
]);
export type McpTaskStatus = z.infer<typeof McpTaskStatusSchema>;

export const McpTaskJsonRpcErrorSchema = z.object({
	code: z.number().int(),
	message: z.string().min(1),
	data: JsonValueSchema.optional().describe(
		"Optional provider-specific error detail; JSON-RPC errors are valid with only code and message.",
	),
});
export type McpTaskJsonRpcError = z.infer<typeof McpTaskJsonRpcErrorSchema>;

export const McpTaskInputRequestsSchema = z.record(
	z.string().min(1),
	JsonValueSchema,
);
export type McpTaskInputRequests = z.infer<typeof McpTaskInputRequestsSchema>;

export const McpTaskInputResponsesSchema = z.record(
	z.string().min(1),
	JsonValueSchema,
);
export type McpTaskInputResponses = z.infer<typeof McpTaskInputResponsesSchema>;

export const McpTaskBaseSchema = z.object({
	taskId: z.string().min(1),
	status: McpTaskStatusSchema,
	statusMessage: z
		.string()
		.optional()
		.describe(
			"Optional status-specific progress detail; task state remains authoritative when a provider emits no message.",
		),
	createdAt: z.iso.datetime(),
	lastUpdatedAt: z.iso.datetime(),
	ttlMs: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.describe("Null when the task has no server-enforced expiry."),
	pollIntervalMs: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional server polling hint; clients choose their bounded default when it is absent.",
		),
});

export const McpWorkingTaskSchema = McpTaskBaseSchema.extend({
	status: z.literal("working"),
});

export const McpInputRequiredTaskSchema = McpTaskBaseSchema.extend({
	status: z.literal("input_required"),
	inputRequests: McpTaskInputRequestsSchema,
});

export const McpCompletedTaskSchema = McpTaskBaseSchema.extend({
	status: z.literal("completed"),
	result: z.record(z.string(), JsonValueSchema),
});

export const McpFailedTaskSchema = McpTaskBaseSchema.extend({
	status: z.literal("failed"),
	error: McpTaskJsonRpcErrorSchema,
});

export const McpCancelledTaskSchema = McpTaskBaseSchema.extend({
	status: z.literal("cancelled"),
});

export const McpDetailedTaskSchema = z.discriminatedUnion("status", [
	McpWorkingTaskSchema,
	McpInputRequiredTaskSchema,
	McpCompletedTaskSchema,
	McpFailedTaskSchema,
	McpCancelledTaskSchema,
]);
export type McpDetailedTask = z.infer<typeof McpDetailedTaskSchema>;

export const McpCreateTaskResultSchema = McpDetailedTaskSchema.and(
	z.object({ resultType: z.literal("task") }),
);
export type McpCreateTaskResult = z.infer<typeof McpCreateTaskResultSchema>;

export const McpGetTaskInputSchema = z.object({
	taskId: z.string().min(1),
});
export type McpGetTaskInput = z.infer<typeof McpGetTaskInputSchema>;

export const McpGetTaskResultSchema = McpDetailedTaskSchema.and(
	z.object({ resultType: z.literal("complete") }),
);
export type McpGetTaskResult = z.infer<typeof McpGetTaskResultSchema>;

export const McpUpdateTaskInputSchema = z.object({
	taskId: z.string().min(1),
	inputResponses: McpTaskInputResponsesSchema,
});
export type McpUpdateTaskInput = z.infer<typeof McpUpdateTaskInputSchema>;

export const McpUpdateTaskResultSchema = z.object({
	resultType: z.literal("complete"),
});
export type McpUpdateTaskResult = z.infer<typeof McpUpdateTaskResultSchema>;

export const McpCancelTaskInputSchema = z.object({
	taskId: z.string().min(1),
});
export type McpCancelTaskInput = z.infer<typeof McpCancelTaskInputSchema>;

export const McpCancelTaskResultSchema = z.object({
	resultType: z.literal("complete"),
});
export type McpCancelTaskResult = z.infer<typeof McpCancelTaskResultSchema>;
