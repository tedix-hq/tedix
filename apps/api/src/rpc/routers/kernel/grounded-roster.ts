import type { KernelContext } from "./context-assembly";
import type { KernelRouteDecision } from "./route-schema";

const ROSTER_REQUEST =
	/\b(?:list|show|name|which|what)\b[\s\S]{0,48}\b(?:active|available|current)\b[\s\S]{0,32}\b(?:tedis?|workers?)\b|\b(?:active|available)\s+(?:tedis?|workers?)\b/i;
const EXPLICIT_DELEGATION =
	/\b(?:delegate|dispatch|hand[ -]?off|ask|send)\b[\s\S]{0,32}\b(?:to|tedi|worker|cto|cfo|ceo)\b/i;

function requestedCount(content: string): number | null {
	const match = content.match(
		/\b(?:exactly|first|top)?\s*(\d{1,2})\s+(?:active\s+|available\s+)?(?:tedis?|workers?)\b/i,
	);
	if (!match?.[1]) return null;
	return Math.min(12, Math.max(1, Number.parseInt(match[1], 10)));
}

/**
 * Answer the one roster question Home already has authoritative context for.
 * This is deliberately not a general heuristic router: it performs no provider
 * calls, writes, or delegation and declines any request that asks for action.
 */
export function groundedRosterDecision(
	content: string,
	context: Pick<KernelContext, "tedis">,
): KernelRouteDecision | null {
	if (!ROSTER_REQUEST.test(content) || EXPLICIT_DELEGATION.test(content))
		return null;

	const active = context.tedis.filter((tedi) => {
		const status = tedi.status?.trim().toLowerCase();
		return !status || status === "active" || status === "ready";
	});
	const count = requestedCount(content) ?? Math.min(active.length, 8);
	const selected = active.slice(0, count);
	const answer = selected.length
		? selected
				.map((tedi) => `- ${tedi.name}${tedi.role ? ` — ${tedi.role}` : ""}`)
				.join("\n")
		: "No active tedis are currently available in this workspace.";

	return {
		routeKind: "answer_in_home",
		rationale:
			"Answered from the current workspace tedi roster already assembled for Home.",
		risk: "low",
		confidence: 1,
		effortClass: "single_read",
		answer,
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation:
			"Current active tedi names and roles from workspace context.",
	};
}
