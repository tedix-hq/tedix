import { HOLDS, type ActionClass } from "./approval-holds";
import { parseDeclaredToolClass } from "./tool-declared-class";
import { z } from "zod";
import {
	DecisionEffectSchema,
	ProtectedEffectSchema,
} from "../schemas/decision-effects";
import { DecisionKindSchema } from "../schemas/os-decision-deck";
import { laneHoldDecision } from "./lane-hold-decision";

/** Intrinsic classes of finite internal adapters, never supplied by card prose. */
const INTERNAL_EFFECTS = new Set([
	"create_owner_task",
	"accept_work",
	"record_adr",
	"record_review",
	"file_request",
	"restart_work",
]);

/** Only a reviewed class with an organization-bounded effect is delegatable. */
export function delegatedClassAllowed(input: {
	actionClass: ActionClass;
	declaredClass: unknown;
}): boolean {
	const declared = parseDeclaredToolClass(input.declaredClass);
	return Boolean(
		declared &&
		HOLDS[input.actionClass].auto === "run" &&
		["read", "change"].includes(input.actionClass) &&
		((input.actionClass === "read" &&
			declared.writeCapability === "read" &&
			declared.riskTier === "read") ||
			(input.actionClass === "change" &&
				declared.writeCapability === "write" &&
				declared.riskTier === "bounded_write")) &&
		["none", "single_resource", "tenant"].includes(declared.blastRadius),
	);
}

const StructuralDecisionSchema = z.object({
	kind: DecisionKindSchema,
	protectedEffects: z.array(ProtectedEffectSchema).default([]),
	options: z
		.array(
			z.object({
				id: z.string(),
				intent: z.enum(["approve", "reject", "later", "change"]),
				effect: DecisionEffectSchema.optional(),
			}),
		)
		.refine(
			(options) =>
				new Set(options.map((option) => option.id)).size === options.length,
		),
});

/** Card effects are classified from the finite adapter, not title or reasoning. */
export function delegatedCardAllowed(
	request: {
		subject: string;
		prompt: string;
		workItemId?: string | null;
		metadata: Record<string, unknown>;
	},
	cardAction?: string,
): boolean {
	const m = request.metadata;
	if (
		m.approvalOperation !== undefined ||
		m.localImport ||
		m.schema === "tedix.outbound.v1" ||
		m.protected === true ||
		(m.protectedEffects !== undefined &&
			(!Array.isArray(m.protectedEffects) || m.protectedEffects.length > 0))
	)
		return false;
	const structuralRequest = {
		...request,
		subject: "Decision",
		prompt: "Decision",
	};
	const decision = StructuralDecisionSchema.safeParse(
		m.decisionDeck ?? laneHoldDecision(structuralRequest),
	);
	if (
		!decision.success ||
		decision.data.protectedEffects.length ||
		decision.data.kind === "outbound"
	)
		return false;
	const options = decision.data.options;
	const eligible = (kind: string) => INTERNAL_EFFECTS.has(kind);
	// A mixed runner card may offer both Retry and an irreversible Close.
	// Routing it for triage never authorizes its irreversible alternative.
	if (cardAction === undefined)
		return options.some(
			(option) => option.effect && eligible(option.effect.kind),
		);
	const selected = options.find((option) => option.id === cardAction);
	return Boolean(
		selected &&
		(selected.effect
			? eligible(selected.effect.kind)
			: selected.intent === "reject") &&
		options.some((option) => option.effect && eligible(option.effect.kind)),
	);
}
