import type { KernelContext } from "./context-assembly";
import { deriveExecutionRequirement } from "./delegation-dispatch";
import { mentionsLabel } from "./delegation-load";
import type { KernelRouteDecision } from "./route-schema";

/** A standby body wakes on the dispatched message, so it counts as ready. */
const READY_STATES = new Set(["running", "active", "standby"]);

type RosterEntry = KernelContext["tedis"][number];

/**
 * Pick the tedi best placed to carry workstation work: a warm workstation
 * first, then a configured repository, then a running body over a standby one.
 */
function rankEmbodiedCandidate(entry: RosterEntry): number {
	const card = entry.capability;
	if (!card) return 0;
	return (
		(card.hasWarmWorkstationLease ? 4 : 0) +
		(card.hasRepository ? 2 : 0) +
		(card.availability === "running" || card.availability === "active" ? 1 : 0)
	);
}

export function embodiedMismatchAnswer(input: {
	targetName: string;
	peerName: string | null;
}): string {
	const { targetName, peerName } = input;
	if (peerName) {
		return `${targetName} can't do this: it has no workstation or coding environment connected. ${peerName} has one. Tell me to send it to ${peerName} and I will.`;
	}
	return `${targetName} can't do this: it has no workstation or coding environment connected, and no other tedi here has one either. Connect a repository or workstation to a tedi in its settings, then ask again.`;
}

/**
 * Work that needs a workstation (shell, repository, long-running process)
 * cannot run on a tedi without one, and no approval changes that. Instead of
 * holding the turn for a person, move the route to a tedi that carries a
 * workstation, or answer in Home with what to connect.
 *
 * An explicitly named tedi is never moved behind the operator's back: Home
 * says who can do it instead. Policy still runs on the moved target, so a
 * deny, a reserved action or a missing grant holds exactly as before.
 */
export function rerouteEmbodiedMismatch<T extends KernelRouteDecision>(input: {
	content: string;
	context: Pick<KernelContext, "tedis" | "apps">;
	decision: T;
}): T {
	const { content, context, decision } = input;
	if (decision.routeKind !== "delegate_tedi" || !decision.targetTediId)
		return decision;
	const target = context.tedis.find(
		(tedi) => tedi.id === decision.targetTediId,
	);
	const card = target?.capability;
	if (!target || !card || card.embodied !== false) return decision;
	const requirement = deriveExecutionRequirement(content, decision);
	if (requirement.surface !== "workstation") return decision;

	const namedApps = context.apps
		.filter((app) => card.apps.includes(app.slug))
		.filter((app) =>
			[app.slug, app.name].some((label) => mentionsLabel(content, label)),
		)
		.map((app) => app.slug);
	const candidates = context.tedis
		.filter((tedi) => {
			const peer = tedi.capability;
			return (
				tedi.id !== target.id &&
				peer !== undefined &&
				peer !== null &&
				peer.embodied === true &&
				READY_STATES.has(peer.availability) &&
				peer.scopeGroups.length > 0 &&
				namedApps.every((slug) => peer.apps.includes(slug))
			);
		})
		.sort((a, b) => rankEmbodiedCandidate(b) - rankEmbodiedCandidate(a));
	const peer = candidates[0] ?? null;
	const targetName = card.name || target.name || target.slug;
	const peerName = peer
		? (peer.capability?.name ?? peer.name ?? peer.slug)
		: null;
	const targetNamed =
		mentionsLabel(content, target.slug) || mentionsLabel(content, target.name);

	if (peer && !targetNamed) {
		return {
			...decision,
			targetTediId: peer.id,
			targetTediLabel: peerName,
			targetActivityId: null,
			plannedToolIds: [],
			answer: null,
			rationale: `${targetName} has no workstation or coding environment, so it cannot carry this work; ${peerName} does. Dispatch remains subject to policy.`,
		};
	}
	return {
		...decision,
		routeKind: "answer_in_home",
		answer: embodiedMismatchAnswer({ targetName, peerName }),
		rationale: peer
			? `${targetName} was named but has no workstation or coding environment; ${peerName} does, so Home offers it instead of holding for an approval that cannot make ${targetName} able.`
			: `No tedi in this organization carries a workstation or coding environment, so no approval can make this work executable.`,
		targetTediId: null,
		targetTediLabel: null,
		targetActivityId: null,
		plannedToolIds: [],
		toolIntent: null,
		workflowHint: null,
		clarifyingQuestion: null,
		evidenceExpectation: null,
	};
}
