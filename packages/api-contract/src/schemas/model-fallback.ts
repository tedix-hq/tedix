import * as z from "zod";
import { ModelRefSchema } from "./model-catalog";
import platformDefault from "../assets/model-fallback.v1.json";

const modelRef = ModelRefSchema;
export const ModelFallbackPolicySchema = z
	.object({
		version: z.literal(1),
		maxTransitions: z.number().int().min(0).max(5),
		ladder: z.record(modelRef, z.array(modelRef).max(5)),
	})
	.strict()
	.superRefine((policy, ctx) => {
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (ref: string): boolean => {
			if (visiting.has(ref)) return false;
			if (visited.has(ref)) return true;
			visiting.add(ref);
			const next = policy.ladder[ref] ?? [];
			if (new Set(next).size !== next.length || !next.every(visit))
				return false;
			visiting.delete(ref);
			visited.add(ref);
			return true;
		};
		if (!Object.keys(policy.ladder).every(visit))
			ctx.addIssue({
				code: "custom",
				message: "Fallback ladder must be acyclic with unique edges",
				path: ["ladder"],
			});
	});
export type ModelFallbackPolicy = z.infer<typeof ModelFallbackPolicySchema>;
export const PLATFORM_MODEL_FALLBACK =
	ModelFallbackPolicySchema.parse(platformDefault);
export type ModelFallbackReason =
	| "credits_exhausted"
	| "quota_exhausted"
	| "provider_unavailable";
export const ModelFallbackStepSchema = z
	.object({
		from: modelRef,
		to: modelRef,
		reason: z.enum([
			"credits_exhausted",
			"quota_exhausted",
			"provider_unavailable",
		]),
		ordinal: z.number().int().min(1).max(5),
		policyVersion: z.literal(1),
	})
	.strict();
export type ModelFallbackStep = z.infer<typeof ModelFallbackStepSchema>;

/** Provider status is required: application budget/auth failures must never change the model. */
export function fallbackFailureReason(
	error: unknown,
): ModelFallbackReason | null {
	if (!error || typeof error !== "object") return null;
	const e = error as {
		statusCode?: unknown;
		status?: unknown;
		message?: unknown;
		responseBody?: unknown;
	};
	const status = e.statusCode ?? e.status;
	if (status === 402) return "credits_exhausted";
	if (typeof status === "number" && status >= 500 && status <= 599)
		return "provider_unavailable";
	if (
		status === 429 &&
		/insufficient_quota|quota[_\s-]*(?:exceeded|exhausted)|(?:out of|insufficient)\s+(?:usage\s+)?credits|usage limit reached/i.test(
			`${e.message ?? ""} ${e.responseBody ?? ""}`,
		)
	)
		return "quota_exhausted";
	return null;
}
