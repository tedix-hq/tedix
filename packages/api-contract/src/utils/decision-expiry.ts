import * as z from "zod";
import defaults from "../assets/decision-expiry.v1.json";

const lifetimes = z.record(z.string().min(1), z.number().int().min(1).max(365));
export const DecisionExpiryPolicySchema = z.strictObject({
	version: z.literal(1),
	classes: lifetimes,
	kinds: lifetimes,
});
export const DEFAULT_DECISION_EXPIRY =
	DecisionExpiryPolicySchema.parse(defaults);

/** Expiry retires a request without answering it; explicit caller timing wins. */
export function defaultDecisionExpiry(
	input: {
		classId?: string;
		kind: string;
		now: string;
		dueAt?: string | null;
		expiresAt?: string;
	},
	policy = DEFAULT_DECISION_EXPIRY,
): string | undefined {
	if (input.expiresAt !== undefined) return input.expiresAt;
	const classRule = Object.keys(policy.classes)
		.filter(
			(key) =>
				input.classId === key ||
				input.classId?.startsWith(`${key}.`) ||
				input.classId?.startsWith(`${key}:`),
		)
		.sort((a, b) => b.length - a.length)[0];
	const days =
		(classRule ? policy.classes[classRule] : undefined) ??
		policy.kinds[input.kind];
	if (days === undefined) return undefined;
	return new Date(
		Math.max(
			Date.parse(input.now) + days * 86_400_000,
			input.dueAt ? Date.parse(input.dueAt) : 0,
		),
	).toISOString();
}
