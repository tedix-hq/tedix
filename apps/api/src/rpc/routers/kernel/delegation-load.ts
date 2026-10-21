import type { KernelContext } from "./context-assembly";
import { deriveExecutionRequirement } from "./delegation-dispatch";
import type { KernelRouteDecision } from "./route-schema";
import {
	DEFAULT_DELEGATION_CONCURRENCY,
	type TediCapabilityCard,
} from "./tedi-capabilities";

/** Active delegated runs per target tedi id. */
export type DelegationLoad = ReadonlyMap<string, number>;

/**
 * Unsettled rows older than this no longer count as load. The orphan sweep
 * settles a dropped child and its Home run within minutes, so anything older
 * is a stale row, not work the tedi is carrying.
 */
export const DELEGATION_LOAD_WINDOW_MS = 6 * 60 * 60_000;

export interface DelegationCapacity {
	active: number;
	limit: number;
}

export function delegationCapacity(
	card: TediCapabilityCard,
	load: DelegationLoad,
): DelegationCapacity {
	return {
		active: load.get(card.tediId) ?? 0,
		limit: card.delegationConcurrency ?? DEFAULT_DELEGATION_CONCURRENCY,
	};
}

function mentionsLabel(content: string, label: string): boolean {
	const words = ` ${content.toLocaleLowerCase()} `;
	const needle = label.trim().toLocaleLowerCase();
	if (needle.length < 3) return false;
	for (let from = 0; ;) {
		const index = words.indexOf(needle, from);
		if (index < 0) return false;
		const before = words[index - 1] ?? " ";
		const after = words[index + needle.length] ?? " ";
		if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after))
			return true;
		from = index + needle.length;
	}
}

/**
 * Spread a coding delegation across the tedis configured for the same
 * repository by live load, instead of stacking every run on the planner's
 * pick until its isolate runs out of memory.
 *
 * Only a peer that could have been chosen in the target's place is eligible:
 * same configured repository, not archived or sleeping (standby wakes on
 * dispatch), no approval gate the target does not have, a body when the work
 * needs a workstation, and every provider app the request names that the
 * target carries. An explicitly named tedi is never moved. The least-loaded
 * tedi under its concurrency limit wins; the target keeps ties. A full pool
 * leaves the target in place for the dispatch gate's capacity hold.
 *
 * Like the delegation-fit refinement, a moved route drops the old target's
 * activity and tool plan so the dispatch gate establishes authority afresh.
 */
export function spreadDelegationLoad<T extends KernelRouteDecision>(input: {
	content: string;
	context: Pick<KernelContext, "tedis" | "apps">;
	decision: T;
	load: DelegationLoad;
}): T {
	const { content, context, decision, load } = input;
	if (decision.routeKind !== "delegate_tedi" || !decision.targetTediId)
		return decision;
	const target = context.tedis.find(
		(tedi) => tedi.id === decision.targetTediId,
	);
	const card = target?.capability;
	const repository = card?.repositoryUrl;
	if (!card || !repository) return decision;
	if (
		context.tedis.some(
			(tedi) =>
				mentionsLabel(content, tedi.slug) || mentionsLabel(content, tedi.name),
		)
	)
		return decision;
	const requirement = deriveExecutionRequirement(content, decision);
	const needsBody = requirement.surface === "workstation";
	const namedApps = context.apps
		.filter((app) => card.apps.includes(app.slug))
		.filter((app) =>
			[app.slug, app.name].some((label) => mentionsLabel(content, label)),
		)
		.map((app) => app.slug);
	const peers = context.tedis.filter((tedi) => {
		const peer = tedi.capability;
		return (
			tedi.id !== target.id &&
			peer !== undefined &&
			peer !== null &&
			peer.repositoryUrl === repository &&
			(peer.availability === "running" || peer.availability === "standby") &&
			(card.requiresApproval || !peer.requiresApproval) &&
			(!needsBody || peer.embodied) &&
			peer.scopeGroups.length > 0 &&
			namedApps.every((slug) => peer.apps.includes(slug))
		);
	});
	if (peers.length === 0) return decision;
	let chosen = target;
	let chosenCapacity = delegationCapacity(card, load);
	for (const peer of peers) {
		const capacity = delegationCapacity(peer.capability!, load);
		if (capacity.active >= capacity.limit) continue;
		const chosenFull = chosenCapacity.active >= chosenCapacity.limit;
		if (chosenFull || capacity.active < chosenCapacity.active) {
			chosen = peer;
			chosenCapacity = capacity;
		}
	}
	if (chosen.id === target.id) return decision;
	const label = chosen.capability?.name ?? chosen.name;
	return {
		...decision,
		targetTediId: chosen.id,
		targetTediLabel: label,
		targetActivityId: null,
		plannedToolIds: [],
		answer: null,
		rationale: `${label} works on the same repository and is carrying less delegated work than ${card.name}; dispatch remains subject to policy.`,
	};
}
