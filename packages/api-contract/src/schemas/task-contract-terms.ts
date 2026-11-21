import * as z from "zod";
import { JsonValueSchema } from "./common";

const ValueType = z.enum([
	"string",
	"number",
	"boolean",
	"object",
	"array",
	"null",
]);

/** A bounded JSON Schema subset; unsupported validation keywords fail closed. */
const TaskReturnFormatSchema = z
	.strictObject({
		type: z.literal("object"),
		properties: z.record(
			z.string().min(1),
			z.strictObject({ type: ValueType }),
		),
		required: z.array(z.string().min(1)).max(100),
		additionalProperties: z.literal(false),
	})
	.refine(
		(schema) =>
			schema.required.every((key) => Object.hasOwn(schema.properties, key)),
		"Required fields must have a declared type",
	);

export const TaskContractTermsSchema = z.strictObject({
	version: z.literal(2),
	goal: z.string().trim().min(1).max(10_000),
	successCriterion: z
		.array(
			z.strictObject({
				path: z
					.array(z.union([z.string().min(1), z.number().int().nonnegative()]))
					.max(20),
				equals: JsonValueSchema,
			}),
		)
		.min(1)
		.max(100),
	budget: z.strictObject({
		maxTokens: z.number().int().nonnegative(),
		maxCostUsd: z.number().finite().nonnegative(),
	}),
	remainingDepth: z.number().int().min(0).max(10),
	errorAllowance: z.number().int().min(0).max(19),
	returnFormat: TaskReturnFormatSchema,
	deadline: z.iso.datetime({ precision: 3 }),
});

export const TaskReturnedValueSchema = z.strictObject({
	output: JsonValueSchema,
	usage: z.strictObject({
		tokens: z.number().int().nonnegative(),
		costUsd: z.number().finite().nonnegative(),
	}),
	errors: z.number().int().nonnegative(),
});

export type TaskContractTerms = z.infer<typeof TaskContractTermsSchema>;
