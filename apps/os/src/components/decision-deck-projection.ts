import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import type { DecisionLearningModel } from "@tedix/api-contract/schemas/decision-learning";
import {
	rankDeckCard,
	compareDecisionFreshness,
} from "@tedix/api-contract/utils/deck-projection";
import { factoryCardDeadline } from "@tedix/api-contract/utils/card-schedule";
import { routeFactoryCard } from "@tedix/api-contract/utils/card-review";
import { deckAsk } from "@tedix/api-contract/utils/deck-ask";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { decisionEnvelope } from "@/lib/decision-deck";
import { interactionCardKind } from "@/lib/interaction-card-kind";
import { decisionCaptureSummary } from "@/lib/work-interaction-display";
import type { CardOrigin } from "@/lib/card-source-filter";
import type { useDecisionInbox } from "@/lib/use-decision-inbox";

export function projectDecisionDeck({
	config,
	mode,
	decisions,
	history,
	learningModel,
	now,
	timeZone,
}: {
	config: DecisionDeckConfig;
	mode: string;
	decisions: ReturnType<typeof useDecisionInbox>;
	history: ReturnType<typeof useDecisionInbox>["requests"];
	learningModel: DecisionLearningModel | undefined;
	now: Date;
	timeZone: string | undefined;
}) {
	const practiceMode = mode === "practice";
	const approvals = decisions.approvals;
	const ask = (card: Parameters<typeof deckAsk>[0]) =>
		deckAsk(card, now, {
			timeZone,
			staleDraftHours: config.staleDraftHours ?? 24,
		});
	// The Waiting list is one overview: the Deck's own open cards plus every
	// open factory card, including ones routing keeps out of the decide queue.
	const browsing = mode === "waiting";
	const rows = practiceMode
		? config.examples.map((decision, i) => ({
				id: `example:${i}`,
				requestedAt: undefined,
				kind: decision.kind,
				label: decision.proposal,
				project: "Examples",
				urgency: "later",
				decision,
				row: undefined,
				sourceLabel: "Example",
				costOfWaiting: null as string | null,
				...ask({ kind: decision.kind, decision }),
			}))
		: [
				...(mode === "decide" || browsing
					? (browsing ? decisions.factoryWaiting : decisions.factoryCards).map(
							(card) => ({
								id: `factory:${card.key}`,
								requestedAt: card.runCreatedAt,
								dueAt: factoryCardDeadline(card),
								kind: "decision",
								origin: {
									factory: card.sourceLabel,
									workspaceId:
										config.factorySources[card.sourceIndex]?.workspaceId ?? "",
								} satisfies CardOrigin,
								label: card.action || card.why || card.sourceText,
								project:
									config.factorySources[card.sourceIndex]?.run?.workProjectId ??
									"Unfiled",
								urgency: "later",
								decision: null,
								row: undefined,
								sourceLabel: card.sourceLabel,
								costOfWaiting: card.timing || null,
								...ask({
									kind: "decision",
									factory: card,
									dueAt: factoryCardDeadline(card),
									requestedAt: card.runCreatedAt,
								}),
							}),
						)
					: []),
				...(mode === "history"
					? history.filter((row) => row.effectiveState === "resolved")
					: decisions.requests
				).map((row) => {
					const decision = decisionEnvelope(row.request.metadata);
					const presentation = DecisionCardPresentationSchema.safeParse(
						row.request.metadata.cardPresentation,
					).data;
					const metadata = row.request.metadata;
					const cardKind = interactionCardKind(row.request);
					return {
						id: row.request.id,
						requestedAt: row.request.requestedAt,
						kind: cardKind,
						label: row.request.subject,
						project:
							row.workItem?.projectId ?? row.request.projectId ?? "Unfiled",
						urgency: decisionCaptureSummary(metadata)?.urgency ?? "later",
						decision:
							decision && presentation
								? {
										...decision,
										proposal: presentation.title,
										preview: decision.preview ?? { body: presentation.body },
										recommendation: presentation.recommendation,
									}
								: decision,
						row,
						sourceLabel: row.askedBy ?? "Decision capture",
						costOfWaiting: decision?.costOfWaiting ?? null,
						...ask({
							kind: cardKind,
							decision,
							request: row.request,
							workItem: row.workItem,
							dueAt: row.request.dueAt,
							requestedAt: row.request.requestedAt,
						}),
					};
				}),
				...(mode === "decide" || browsing
					? decisions.work.map((row) => ({
							id: `work-approval:${row.proposal.id}`,
							requestedAt: row.proposal.requestedAt,
							kind: "approval",
							label: row.workItem.title,
							project: row.workItem.projectId ?? "Unfiled",
							urgency: "now",
							decision: null,
							row: undefined,
							sourceLabel: "Work",
							costOfWaiting: null,
							...ask({ kind: "approval" }),
						}))
					: []),
				...(!config.projectId && (mode === "decide" || browsing)
					? (approvals.data?.data ?? []).map((approval) => ({
							id: `approval:${approval.id}`,
							requestedAt: approval.createdAt,
							kind: "approval",
							label: approval.description,
							project: "Organization",
							urgency: "now",
							decision: null,
							row: undefined,
							sourceLabel: "Approval",
							costOfWaiting: null,
							...ask({ kind: "approval", runtimeApproval: approval }),
						}))
					: []),
			];
	const rank = (row: (typeof rows)[number]) =>
		rankDeckCard(row, learningModel, now, row.row?.request);
	const factoryPriority = new Map(
		(browsing ? decisions.factoryWaiting : decisions.factoryCards).map(
			(card) => {
				const route = routeFactoryCard(
					card,
					config.routing,
					now,
					learningModel,
				);
				return [
					`factory:${card.key}`,
					{
						policyCritical: route.reason === "critical",
						score: route.score ?? undefined,
					},
				];
			},
		),
	);
	// Critical detection sees the same card facts as the server projection.
	const priorityContext = (row: (typeof rows)[number]) =>
		mode === "decide" || browsing
			? {
					kind: row.kind,
					label: row.label,
					decision: row.decision,
					interaction: row.row,
					factory: factoryPriority.get(row.id),
				}
			: {};
	const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
		compareDecisionFreshness(
			{
				...priorityContext(a),
				dueAt:
					"dueAt" in a && typeof a.dueAt === "string"
						? a.dueAt
						: a.row?.request.dueAt,
				deadline: a.deadline,
				requestedAt: a.requestedAt,
				score: learningModel?.config.enabled ? rank(a).score : undefined,
			},
			{
				...priorityContext(b),
				dueAt:
					"dueAt" in b && typeof b.dueAt === "string"
						? b.dueAt
						: b.row?.request.dueAt,
				deadline: b.deadline,
				requestedAt: b.requestedAt,
				score: learningModel?.config.enabled ? rank(b).score : undefined,
			},
			now,
			timeZone,
		);

	return { rows, rank, compare };
}
