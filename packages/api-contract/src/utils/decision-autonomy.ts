import * as z from "zod";
import defaults from "../assets/decision-autonomy.v1.json";
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
import {
	decideAutonomousAction,
	type DelegationAutonomyPolicy,
} from "./approval-policy";

export const DecisionAutonomyActionSchema = z.strictObject({
	classId: z.string().min(1).max(100),
	risk: z.enum(["low", "medium", "high", "critical", "unknown"]),
	reversibility: z.enum(["two_way", "one_way", "unknown"]),
	scope: z.enum(["internal", "external", "unknown"]),
	ownerType: z.enum(["tedi", "external_agent", "user", "system"]),
	effectKind: z.string().min(1),
	validated: z.boolean().optional(),
	governed: z.boolean().optional(),
	agentOwned: z.boolean().optional(),
	actionContent: z.string().optional(),
});
export type DecisionAutonomyAction = z.infer<
	typeof DecisionAutonomyActionSchema
>;

export const DecisionAutonomyConfigSchema = z.object({
	version: z.literal(1),
	reservedClassPattern: z.string().min(1),
	rules: z.array(
		z.object({
			effectKind: z.string().min(1),
			classes: z.array(z.string().min(1)).min(1),
			actionContent: z.string().min(1),
			requirements: z.array(z.enum(["validated", "governed", "agentOwned"])),
		}),
	),
});
export type DecisionAutonomyConfig = z.infer<
	typeof DecisionAutonomyConfigSchema
>;
export const DEFAULT_DECISION_AUTONOMY =
	DecisionAutonomyConfigSchema.parse(defaults);

/** Routing eligibility only. The caller must verify the owner and adapter authority. */
export function decideDecisionAutonomy(input: {
	policy?: DelegationAutonomyPolicy | null;
	action?: unknown;
	decision?: unknown;
	config?: unknown;
}): { eligible: boolean; classId: string | null; reason: string } {
	const parsed = DecisionAutonomyActionSchema.safeParse(input.action);
	const classId = parsed.success ? parsed.data.classId : null;
	const deny = (reason: string) => ({ eligible: false, classId, reason });
	if (!parsed.success)
		return deny("explicit internal action evidence is unavailable");
	const action = parsed.data;
	const config = DecisionAutonomyConfigSchema.safeParse(
		input.config ?? DEFAULT_DECISION_AUTONOMY,
	);
	if (!config.success)
		return deny("internal action routing configuration is unavailable");
	let reserved: RegExp;
	try {
		reserved = new RegExp(
			`(?:${DEFAULT_DECISION_AUTONOMY.reservedClassPattern})|(?:${config.data.reservedClassPattern})`,
			"i",
		);
	} catch {
		return deny("internal action routing configuration is invalid");
	}
	if (reserved.test(action.classId))
		return deny("human-reserved decision class");
	if (input.decision !== undefined) {
		const decision = DecisionEnvelopeSchema.safeParse(input.decision);
		if (!decision.success) return deny("decision evidence is malformed");
		if (
			decision.data.protectedEffects.length ||
			decision.data.kind === "outbound" ||
			decision.data.kind === "approval" ||
			decision.data.reversibility !== "two_way" ||
			(decision.data.tasteOrStrategy &&
				action.effectKind !== "create_owner_task") ||
			reserved.test(decision.data.classId)
		)
			return deny(
				"decision requires human judgment or protects a critical effect",
			);
		const approvals = decision.data.options.filter(
			(option) => option.intent === "approve",
		);
		if (
			approvals.length !== 1 ||
			approvals[0]?.effect?.kind !== action.effectKind
		)
			return deny("decision must have exactly one matching internal action");
		if (input.policy?.askForClasses?.includes(decision.data.classId))
			return deny("human correction requires approval for this decision class");
	}
	if (
		action.scope !== "internal" ||
		action.reversibility !== "two_way" ||
		!["tedi", "external_agent"].includes(action.ownerType)
	)
		return deny("action must be reversible, internal, and owned by an agent");
	const rule = config.data.rules.find(
		(candidate) =>
			candidate.effectKind === action.effectKind &&
			candidate.classes.includes(action.classId),
	);
	if (!rule)
		return deny("internal action adapter is not configured for this class");
	if (rule.requirements.some((key) => action[key] !== true))
		return deny("internal action adapter prerequisites are unverified");
	// Only the adapter's action is classified. A task's draft can discuss a
	// future message without creating permission to send that message.
	const verdict = decideAutonomousAction({
		policy: input.policy,
		risk: action.risk,
		classId: action.classId,
		content: action.actionContent ?? rule.actionContent,
	});
	return { eligible: verdict.autoApprove, classId, reason: verdict.reason };
}
