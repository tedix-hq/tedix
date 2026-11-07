/**
 * Card text a person cannot act on because it was written for an agent:
 * instructions about the card itself ("open this Work item and click Reply on
 * this Needs-you card") or a request to produce data only an agent can gather
 * ("provide a comparison of the source and target counts"). The person sees a
 * plain question; these sentences belong under "Details for agents".
 */

/** The person is already looking at the card; telling them how to answer it is agent copy. */
const CARD_MECHANICS =
	/\b(?:click|press|tap|hit|use)\s+(?:the\s+|on\s+)?["“'`]?(?:reply|respond|answer|submit)\b|\bneeds[- ]you\s+card\b|\bopen\s+(?:this|the)\s+(?:work\s+item|work|card|request|interaction)\b|\b(?:on|in)\s+this\s+work\s+item\b/i;

/** Asking a person to produce counts, logs, query results or diffs an agent should gather. */
const AGENT_DATA =
	/\b(?:provide|paste|produce|supply|post|attach|export)\b[^.?!\n]{0,100}?\b(?:counts?|comparison|outputs?|logs?|quer(?:y|ies)|diffs?|json|sql|stack\s*traces?|traces?|dumps?)\b/i;

/** Tool and command names a person never types: `respond_to_work_interaction`, `tedix work …`. */
const AGENT_COMMAND =
	/`(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|(?:[a-z][a-zA-Z0-9]*\.)+[a-z][a-zA-Z0-9]*)`|\btedix\s+(?:-w\s+\S+\s+)?(?:work|mcp|lane|flow)\s+[a-z-]+/;

export type AgentAddressedIssue =
	| "card_mechanics"
	| "agent_data"
	| "agent_command";

/** Why this text is addressed to an agent rather than a person, or undefined. */
export function agentAddressedIssue(
	value: string,
): AgentAddressedIssue | undefined {
	// Quoted task titles ("Let Codex work on “Export audit logs”?") are names, not instructions.
	const text = value.replace(/“[^”\n]*”|"[^"\n]*"/g, "");
	if (CARD_MECHANICS.test(text)) return "card_mechanics";
	if (AGENT_DATA.test(text)) return "agent_data";
	if (AGENT_COMMAND.test(text)) return "agent_command";
	return undefined;
}

export const AGENT_ADDRESSED_MESSAGES: Record<AgentAddressedIssue, string> = {
	card_mechanics:
		"Ask the person a plain question. They are already on the card: do not tell them to open the Work item or click Reply.",
	agent_data:
		"A person cannot produce counts, logs or query output. Ask for the decision you need (for example, grant read access) and gather the data yourself.",
	agent_command:
		"Name the change in plain words. Tool and command names belong in the prompt for agents, not in the question.",
};
