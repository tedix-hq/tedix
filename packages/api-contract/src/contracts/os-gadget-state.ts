import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	OsGadgetStateKeySchema,
	OsGadgetStateValueSchema,
	OsGadgetStateRecordSchema,
	OsGadgetStateExecutionSchema,
	OsGadgetStateMutationResultSchema,
} from "../schemas/os-gadget-state";
const scope = z.object({
	workspaceId: z.string().uuid(),
	gadgetId: z.string().uuid(),
});
const read = scope.extend({
	execution: OsGadgetStateExecutionSchema.optional(),
});
const mutation = scope.extend({
	execution: OsGadgetStateExecutionSchema.optional(),
	key: OsGadgetStateKeySchema,
	expectedRevision: z.number().int().nonnegative(),
	idempotencyKey: z.string().min(1).max(160),
});
/** Canonical persistent application state; no provider credentials or independent execution authority. */
export const osGadgetStateContract = oc
	.route({ tags: ["os-gadget-state"], prefix: "/os-gadget-state" })
	.errors(baseErrors)
	.router({
		get: oc
			.route({
				method: "POST",
				path: "/get",
				summary: "Read one Gadget state record",
			})
			.input(read.extend({ key: OsGadgetStateKeySchema }).strict())
			.output(z.object({ record: OsGadgetStateRecordSchema.nullable() })),
		list: oc
			.route({
				method: "POST",
				path: "/list",
				summary: "List Gadget state keys with literal prefix and cursor",
			})
			.input(
				read
					.extend({
						prefix: OsGadgetStateKeySchema.optional(),
						after: OsGadgetStateKeySchema.optional(),
						limit: z.number().int().min(1).max(100).default(50),
					})
					.strict(),
			)
			.output(
				z.object({
					items: z.array(OsGadgetStateRecordSchema),
					nextAfter: OsGadgetStateKeySchema.nullable(),
				}),
			),
		put: oc
			.route({
				method: "POST",
				path: "/put",
				summary: "Compare and set durable Gadget state",
			})
			.input(mutation.extend({ value: OsGadgetStateValueSchema }).strict())
			.output(OsGadgetStateMutationResultSchema),
		delete: oc
			.route({
				method: "POST",
				path: "/delete",
				summary: "Compare and tombstone durable Gadget state",
			})
			.input(mutation.strict())
			.output(OsGadgetStateMutationResultSchema),
	});
