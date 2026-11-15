import { laneReservedActionMatches } from "./lane-reserved-actions";
import { withoutNegatedClauses } from "@tedix/api-contract/utils/work-instructions";

const undoGuidance: Record<string, string> = {
	public_publish: "Public copies may remain after unpublishing.",
	external_message: "Sent messages cannot reliably be recalled.",
	delete_data:
		"Recovery requires a verified restore path; this card does not verify one.",
	credentials:
		"Restoring account access or keys requires a separate verified procedure.",
	money: "A refund or cancellation is a separate action and is not guaranteed.",
	legal: "Ending a commitment requires a separate agreement or legal process.",
	customer_config:
		"Restoring the customer's setup requires a verified rollback procedure.",
};

export function lanePermissionCopy(text: string, agent: string) {
	const matches = laneReservedActionMatches(text);
	const sentences = [...new Set(matches.map((match) => match.sentence))];
	const actions = [...new Set(matches.map((match) => match.action))];
	const irreversible =
		actions.some((action) =>
			["public_publish", "external_message", "legal"].includes(action),
		) ||
		matches.some(
			(match) =>
				match.action === "delete_data" &&
				/\b(?:permanently|irreversibl\w*)\b/i.test(
					withoutNegatedClauses(match.sentence),
				),
		);
	const reversibility = irreversible ? "one_way" : "unknown";
	const undo = actions
		.map(
			(action) => undoGuidance[action] ?? "An undo path has not been verified.",
		)
		.join(" ");
	const source = sentences
		.join(" ")
		.replace(/\s+/g, " ")
		.replace(/[.!?;]+$/u, "");
	const words = source.split(/\s+/u);
	// Keep the beginning and target at the end; the full scope stays in Details.
	const excerpt =
		words.length > 20
			? `${words.slice(0, 10).join(" ")} … ${words.slice(-9).join(" ")}`
			: source;
	const scope =
		excerpt.length > 350
			? `${excerpt.slice(0, 170)}…${excerpt.slice(-170)}`
			: excerpt;
	return {
		matches,
		sentences,
		reversibility,
		undo,
		story: `${agent} needs permission: “${scope || "the step described in this task"}”. Allow records permission for this task version, then ${agent} can proceed.`,
		stakes: irreversible
			? "Some effects cannot be undone."
			: "Undo path unverified.",
	};
}
