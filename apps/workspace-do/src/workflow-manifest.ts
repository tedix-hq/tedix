import * as z from "zod";
import { JsonValueSchema } from "@tedix/api-contract/schemas/common";

export const WorkflowOutputRefSchema = z.strictObject({
	outputId: z.string().min(1),
	revisionId: z.string().min(1),
});
export type WorkflowOutputRef = z.infer<typeof WorkflowOutputRefSchema>;

const stepFields = {
	id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
	/** Named inputs refer only to earlier steps; bodies stay in Outputs. */
	inputs: z.record(z.string(), z.string()).default({}),
};

const outputSchema = z
	.record(z.string(), JsonValueSchema)
	.superRefine((schema, ctx) => {
		try {
			z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
		} catch {
			ctx.addIssue({
				code: "custom",
				message: "Unsupported output JSON Schema",
			});
		}
	});

export const WorkflowStepSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		...stepFields,
		kind: z.literal("tool"),
		tool: z.string().min(1),
		args: z.record(z.string(), JsonValueSchema).default({}),
		approval: z.enum(["policy", "required"]).default("policy"),
	}),
	z.strictObject({
		...stepFields,
		kind: z.literal("agent"),
		prompt: z.string().min(1).max(32_000),
		outputSchema,
	}),
	z.strictObject({
		...stepFields,
		kind: z.literal("code"),
		code: z.string().min(1).max(32_000),
	}),
]);
export type WorkflowStep = z.infer<typeof WorkflowStepSchema>;

/** Stored with a skill revision; lifecycle and certification remain with the skill. */
export const WorkflowManifestSchema = z
	.strictObject({
		version: z.literal(1),
		skillRevisionId: z.string().min(1),
		steps: z.array(WorkflowStepSchema).min(1).max(100),
	})
	.superRefine((manifest, ctx) => {
		const seen = new Set<string>();
		for (const [index, step] of manifest.steps.entries()) {
			if (seen.has(step.id)) {
				ctx.addIssue({
					code: "custom",
					path: ["steps", index, "id"],
					message: "Duplicate step id",
				});
			}
			for (const [name, source] of Object.entries(step.inputs)) {
				if (!seen.has(source)) {
					ctx.addIssue({
						code: "custom",
						path: ["steps", index, "inputs", name],
						message: "Input must name an earlier step",
					});
				}
			}
			seen.add(step.id);
		}
	});
