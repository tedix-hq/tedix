import { z } from "zod";

// https://docs.devin.ai/cli/extensibility/hooks/overview#hook-format
const handler = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("command"),
		command: z.string().min(1),
		timeout: z.number().positive().optional(),
	}),
	z.strictObject({
		type: z.literal("prompt"),
		prompt: z.string().min(1),
		timeout: z.number().positive().optional(),
	}),
]);
const definitions = z
	.array(
		z.strictObject({
			matcher: z.string().optional(),
			hooks: z.array(handler),
		}),
	)
	.optional();

export const devinHooksSchema = z.strictObject({
	PreToolUse: definitions,
	PostToolUse: definitions,
	PermissionRequest: definitions,
	UserPromptSubmit: definitions,
	Stop: definitions,
	PostCompaction: definitions,
	SessionStart: definitions,
	SessionEnd: definitions,
});
