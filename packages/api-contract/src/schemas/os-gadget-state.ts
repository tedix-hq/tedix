import * as z from "zod";
import { OsDerivedAccessEnvelopeSchema } from "./os-workspaces";

/** Explicit capabilities a pinned Gadget revision must declare for durable state. */
export const GADGET_STATE_READ = "os.gadget.state.read";
export const GADGET_STATE_WRITE = "os.gadget.state.write";
/** A bounded application key; SQL prefixes are literal, never wildcard patterns. */
export const OsGadgetStateKeySchema = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
/** Application JSON is bounded independently of request transport limits. */
export const OsGadgetStateValueSchema = z.json().superRefine((value, ctx) => {
	if (new TextEncoder().encode(JSON.stringify(value)).length > 32768)
		ctx.addIssue({
			code: "custom",
			message: "Gadget state values cannot exceed 32768 UTF-8 bytes",
		});
});
/** One durable value, including deletion tombstones that preserve CAS and provenance. */
export const OsGadgetStateRecordSchema = z
	.object({
		key: OsGadgetStateKeySchema,
		revision: z.number().int().positive(),
		value: OsGadgetStateValueSchema.nullable(),
		deleted: z.boolean(),
		accessEnvelope: OsDerivedAccessEnvelopeSchema,
		executionId: z.string().uuid(),
		updatedAt: z.string(),
	})
	.strict();
/** Run fencing supplied by the caller and verified against trusted acting identity and live ledgers. */
export const OsGadgetStateExecutionSchema = z
	.object({
		executionId: z.string().uuid(),
		executionEpoch: z.number().int().nonnegative(),
	})
	.strict();
/** Stable settled mutation result; retries replay this even after another mutation changes the key. */
export const OsGadgetStateMutationResultSchema = z
	.object({
		outcome: z.enum(["applied", "conflict"]),
		record: OsGadgetStateRecordSchema.nullable(),
	})
	.strict();
export type OsGadgetStateRecord = z.infer<typeof OsGadgetStateRecordSchema>;
export type OsGadgetStateExecution = z.infer<
	typeof OsGadgetStateExecutionSchema
>;
export type OsGadgetStateMutationResult = z.infer<
	typeof OsGadgetStateMutationResultSchema
>;
