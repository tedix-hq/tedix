import { parseJevSettings } from "@tedix/api-contract/schemas/jev";
import type { DbClient } from "@tedix/db/client";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import type { JevEnv } from "@tedix/workers-ai/jev";
import {
	executeJevJudgment,
	JevUsagePersistenceError,
} from "../../../services/jev-judgment";
import type { KernelContext } from "./context-assembly";
import {
	buildJevRankingRequest,
	interpretJevRanking,
	type ContextCandidateRanker,
} from "./jev-context-ranking";
import { deriveExecutionRequirement } from "./delegation-dispatch";
import type {
	KernelExecutionAttempt,
	KernelGatewayContext,
} from "./gateway-attribution";
import type { KernelRouteDecision } from "./route-schema";
import type { KernelWorkersAiEnv } from "./workers-ai-client";

// The planner can only see this many tedis in its rendered context. Do not
// introduce a model-selected target from the unrendered roster tail.
const RENDERED_TEDI_LIMIT = 12;

/** Dedicated default judgment. Existing context-ranking switches do not gate delegation fit. */
export function createJevDelegationRanker(
	db: DbClient,
	env: KernelWorkersAiEnv & JevEnv,
	context: KernelGatewayContext,
	signal?: AbortSignal,
	onExecutionAttempts?: (attempts: readonly KernelExecutionAttempt[]) => void,
): ContextCandidateRanker {
	const settings = context.organizationId
		? getOrganizationById(db, context.organizationId)
				.then((org) =>
					org
						? parseJevSettings(org.metadata)
						: parseJevSettings({ jev: { enabled: false } }),
				)
				.catch(() => parseJevSettings({ jev: { enabled: false } }))
		: Promise.resolve(parseJevSettings({ jev: { enabled: false } }));
	const cache = new Map<string, Promise<string[] | null>>();
	return (input) => {
		if (input.kind !== "tedi" || signal?.aborted) return Promise.resolve(null);
		const request = buildJevRankingRequest(input, RENDERED_TEDI_LIMIT);
		if (!request) return Promise.resolve(null);
		const { state, questions, candidates } = request;
		const cacheKey = JSON.stringify([state, input.candidates.map((c) => c.id)]);
		const existing = cache.get(cacheKey);
		if (existing) return existing;
		const pending = (async () => {
			const config = await settings;
			if (!config.enabled) return null;
			const result = await executeJevJudgment({
				db,
				env,
				context,
				state,
				questions,
				source: "kernel:delegation-fit",
				billingSource: "kernel",
				sessionType: "kernel",
				transport: config.transport,
				timeoutMs: config.timeoutMs,
				signal,
				onExecutionAttempts,
			});
			if (!result) return null;
			return interpretJevRanking(
				candidates,
				input.candidates,
				result.answers,
				config.purposes.contextRanking.minApplicability,
			);
		})();
		cache.set(cacheKey, pending);
		return pending;
	};
}

function mentionsNamedTedi(
	content: string,
	tedis: KernelContext["tedis"],
): boolean {
	const words = ` ${content.toLocaleLowerCase()} `;
	return tedis.some((tedi) =>
		[tedi.slug, tedi.name]
			.map((label) => label.trim().toLocaleLowerCase())
			.filter((label) => label.length >= 3)
			.some((label) => {
				let from = 0;
				for (;;) {
					const index = words.indexOf(label, from);
					if (index < 0) return false;
					const before = words[index - 1] ?? " ";
					const after = words[index + label.length] ?? " ";
					if (!/[\p{L}\p{N}_-]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after))
						return true;
					from = index + label.length;
				}
			}),
	);
}

function uniquelyOwnedProvider(
	content: string,
	context: KernelContext,
	eligible: KernelContext["tedis"],
): string | null {
	const request = content.toLocaleLowerCase();
	for (const app of context.apps) {
		const labels = [app.slug, app.name]
			.map((label) => label.trim().toLocaleLowerCase())
			.filter((label) => label.length >= 3);
		if (!labels.some((label) => request.includes(label))) continue;
		const owners = eligible.filter((tedi) =>
			tedi.capability?.apps.includes(app.slug),
		);
		if (owners.length === 1) return owners[0]!.id;
	}
	return null;
}

/**
 * Jev only advises fit within the roster the planner saw. Eligibility and
 * authorization remain deterministic: archived/thin or physically incapable
 * targets never enter the ranking. Jev cannot add a known approval gate when
 * the planner chose an ungated tedi, and a changed target loses the old
 * target's entrustment/tool plan before the dispatch gate evaluates it.
 */
export async function refineDelegationFit<
	T extends KernelRouteDecision,
>(input: {
	content: string;
	context: KernelContext;
	decision: T;
	ranker?: ContextCandidateRanker;
	signal?: AbortSignal;
}): Promise<T> {
	const { content, context, decision, ranker, signal } = input;
	if (
		!ranker ||
		signal?.aborted ||
		context.delegationAvailable === false ||
		(decision.routeKind !== "delegate_tedi" &&
			decision.routeKind !== "suggest_handoff") ||
		!decision.targetTediId
	)
		return decision;
	const visible = context.tedis.slice(0, RENDERED_TEDI_LIMIT);
	if (mentionsNamedTedi(content, visible)) return decision;
	const requirement = deriveExecutionRequirement(content, decision);
	if (!requirement.satisfiable) return decision;
	const eligible = visible.filter((tedi) => {
		const card = tedi.capability;
		return (
			card &&
			card.availability !== "archived" &&
			(requirement.surface !== "workstation" || card.embodied)
		);
	});
	if (
		eligible.length < 2 ||
		!eligible.some((tedi) => tedi.id === decision.targetTediId)
	)
		return decision;
	// Provider ownership is a stronger, deterministic signal than semantic fit.
	// The route planner or policy layer handles an apparent mismatch; Jev cannot
	// move a provider read away from its sole visible owning tedi.
	if (uniquelyOwnedProvider(content, context, eligible)) return decision;
	const original = eligible.find((tedi) => tedi.id === decision.targetTediId);
	// A semantic hint must not turn an ungated route into an approval wait. Keep
	// autonomous standby tedis eligible: the dispatch gate can wake them for a
	// cognitive turn. Other policy gates still make the final decision.
	const rankable =
		original?.capability?.requiresApproval === false
			? eligible.filter((tedi) => tedi.capability?.requiresApproval === false)
			: eligible;
	if (rankable.length < 2) return decision;
	try {
		const order = await ranker({
			kind: "tedi",
			query: content,
			candidates: rankable.map((tedi) => ({
				id: tedi.id,
				description: [
					tedi.slug,
					tedi.name,
					tedi.capability!.apps.join(" "),
					tedi.capability!.scopeGroups.join(" "),
					tedi.capability!.skills.join(" "),
					tedi.role ?? "",
					tedi.capability!.availability,
					tedi.selectionPrior && tedi.selectionPrior.total >= 3
						? `track-record ${Math.round(tedi.selectionPrior.successRate * 100)}% (${tedi.selectionPrior.total} turns)`
						: "",
					tedi.capability!.learnedCapability?.description ?? "",
				]
					.filter(Boolean)
					.join("; "),
			})),
		});
		if (
			!order ||
			order.length !== rankable.length ||
			new Set(order).size !== rankable.length ||
			order.some((id) => !rankable.some((tedi) => tedi.id === id))
		)
			return decision;
		const chosen = rankable.find((tedi) => tedi.id === order[0]);
		if (!chosen || chosen.id === decision.targetTediId) return decision;
		return {
			...decision,
			confidence: Math.min(decision.confidence, 0.75),
			targetTediId: chosen.id,
			targetTediLabel: chosen.name,
			// The planner's answer may name its original target. The durable
			// delegation response is rendered from the final target after policy.
			answer:
				decision.routeKind === "delegate_tedi"
					? null
					: `I suggest opening a session with ${chosen.name} for this work.`,
			// An activity and its tool IDs belong to the former target. A later
			// deterministic gate must establish authority for this one afresh.
			targetActivityId: null,
			plannedToolIds: [],
			rationale: `The requested task best fits ${chosen.name}'s visible capabilities; dispatch remains subject to policy.`,
		};
	} catch (error) {
		if (error instanceof JevUsagePersistenceError) throw error;
		return decision;
	}
}
