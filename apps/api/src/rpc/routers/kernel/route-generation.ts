import { jsonSchema, zodSchema } from "ai";
import type * as z from "zod";
import {
	KernelRouteDecisionSchema,
	normalizeRouteDecisionCandidate,
	type KernelRouteDecision,
} from "./route-schema";

const DetailsSchema = KernelRouteDecisionSchema.omit({
	routeKind: true,
	answer: true,
	confidence: true,
});

export const KernelRouteGenerationObjectSchema = KernelRouteDecisionSchema.pick(
	{
		routeKind: true,
		answer: true,
		confidence: true,
	},
).extend({ details: DetailsSchema.nullable() });

const DIRECT_ANSWER_DETAILS: z.infer<typeof DetailsSchema> = {
	rationale: "Answered directly without taking external action.",
	risk: "low",
	effortClass: "single_read",
	targetTediId: null,
	targetTediLabel: null,
	targetActivityId: null,
	plannedToolIds: [],
	toolIntent: null,
	workflowHint: null,
	clarifyingQuestion: null,
	evidenceExpectation: null,
};

/** Direct answers omit dispatch metadata from the model response. */
export const kernelRouteGenerationSchema = jsonSchema<
	KernelRouteDecision & {
		details?: Partial<z.infer<typeof DetailsSchema>> | null;
	}
>(zodSchema(KernelRouteGenerationObjectSchema).jsonSchema, {
	validate: (value) => {
		const candidate = normalizeRouteDecisionCandidate(value);
		const full = KernelRouteDecisionSchema.safeParse(candidate);
		if (full.success) return { success: true, value: full.data };
		const wire = KernelRouteGenerationObjectSchema.safeParse(
			candidate && typeof candidate === "object" && "details" in candidate
				? {
						...candidate,
						details: normalizeRouteDecisionCandidate(candidate.details),
					}
				: candidate,
		);
		if (!wire.success) return { success: false, error: wire.error };
		if (wire.data.details === null && wire.data.routeKind !== "answer_in_home")
			return {
				success: false,
				error: new Error("Action route requires details"),
			};
		const parsed = KernelRouteDecisionSchema.safeParse({
			...wire.data,
			...(wire.data.details ?? DIRECT_ANSWER_DETAILS),
		});
		return parsed.success
			? { success: true, value: parsed.data }
			: { success: false, error: parsed.error };
	},
});
