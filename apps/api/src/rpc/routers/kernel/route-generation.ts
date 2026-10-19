import { jsonSchema, zodSchema } from "ai";
import type * as z from "zod";
import {
	KernelRouteDecisionSchema,
	normalizeRouteDecisionCandidate,
	type KernelRouteDecision,
} from "./route-schema";

/** Remove presentation text around one complete JSON object; never repair its fields. */
export async function repairRouteDecisionText({
	text,
}: {
	text: string;
}): Promise<string | null> {
	try {
		JSON.parse(text);
		return null;
	} catch {
		const first = text.indexOf("{");
		const last = text.lastIndexOf("}");
		if (first < 0 || last <= first) return null;
		const candidate = text.slice(first, last + 1);
		try {
			JSON.parse(candidate);
			return candidate;
		} catch {
			return null;
		}
	}
}

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
		const normalized = normalizeRouteDecisionCandidate(value);
		// Unusable self-reported confidence means no confidence. It must not
		// invalidate an otherwise typed route or increase action authority.
		const candidate =
			normalized !== null &&
			typeof normalized === "object" &&
			!Array.isArray(normalized)
				? {
						...normalized,
						confidence:
							"confidence" in normalized &&
							typeof normalized.confidence === "number"
								? normalized.confidence
								: 0,
					}
				: normalized;
		const full = KernelRouteDecisionSchema.safeParse(candidate);
		if (full.success) return { success: true, value: full.data };
		const wire = KernelRouteGenerationObjectSchema.safeParse(
			candidate && typeof candidate === "object"
				? {
						...candidate,
						details:
							"details" in candidate
								? normalizeRouteDecisionCandidate(candidate.details)
								: "routeKind" in candidate &&
									  candidate.routeKind === "answer_in_home"
									? null
									: undefined,
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
