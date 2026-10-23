import {
	DEFAULT_DECK_ROUTING,
	type DeckRoutingPolicy,
} from "../schemas/os-decision-deck";
import { humanReservedActionClasses } from "./approval-policy";

/**
 * Why an ask must stay with its person: the human-reserved action classes and
 * owner-only topics its subject names. Empty means an agent may decide it.
 * Only the subject is read; the prompt carries the agent's own summary.
 */
export function humanOnlyAskReasons(
	subject: string,
	policy: DeckRoutingPolicy = DEFAULT_DECK_ROUTING,
): string[] {
	const classes =
		policy.criticalSubjectClasses ??
		DEFAULT_DECK_ROUTING.criticalSubjectClasses ??
		[];
	const patterns =
		policy.criticalSubjectPatterns ??
		DEFAULT_DECK_ROUTING.criticalSubjectPatterns ??
		[];
	return [
		...humanReservedActionClasses(subject).filter((id) => classes.includes(id)),
		...patterns
			.filter((pattern) => new RegExp(pattern, "i").test(subject))
			.map(() => "owner_only_topic"),
	];
}
