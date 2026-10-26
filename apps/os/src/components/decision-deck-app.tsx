import { useDeckDecision } from "./use-deck-decision";
import { projectDecisionDeck } from "./decision-deck-projection";
import { DecisionDeckToolbar } from "./decision-deck-toolbar";
import { DeckWaitingList } from "./decision-deck-waiting";
import { useCardSourceFilter } from "./use-card-source-filter";
import {
	ALL_CARD_SOURCES,
	matchesCardSource,
	type CardOrigin,
} from "@/lib/card-source-filter";
import { DeckAskStrip } from "@/components/deck-ask-strip";
import { DeckCurationFooter } from "@/components/deck-curation-footer";
import { DeckNotUseful } from "@/components/deck-not-useful";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import type { DecisionCardContextItem } from "@tedix/api-contract/schemas/user-settings";
import { recordDecisionCardContextUse } from "@tedix/api-contract/utils/decision-card-preferences";
import { useOsPreferences } from "@/lib/use-os-preferences";
import { DecisionCardSettings } from "@/components/decision-card-settings";
import { workRefreshOptions } from "@/lib/work-refresh";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import {
	DECK_DETAIL_WINDOW,
	prefetchDeckDetails,
} from "@/lib/deck-detail-prefetch";
import {
	DecisionContextRail,
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import { workActorReference } from "@/lib/work-actor";
import { useDeckProgress } from "@/lib/use-deck-progress";
import {
	DeckProgress,
	DeckCompletion,
	DeckCardSkeleton,
} from "@/components/deck-progress";
import { LearnedToday } from "@/components/learned-today";
import { DeckAttentionMetrics } from "@/components/deck-attention-metrics";
import {
	DeckRemainingContext,
	DeckCurationContext,
	DeckFooterContext,
	DeckNoticeContext,
	CardFaceContext,
} from "@/components/deck-presentation-context";
import {
	cardDecisionTiming,
	cardFirstView,
	readCardFirstView,
	markCardDetails,
	cardDetailsOpened,
} from "@/lib/card-first-view";
import { CardContextFeedback } from "@/components/card-context-feedback";
import { useDeckViewport } from "@/lib/use-deck-viewport";
import { useDecisionInstrumentation } from "@/lib/use-decision-instrumentation";
import { DecisionClassCalibration } from "@/components/decision-class-calibration";
import { DecisionLearningContext } from "@/components/decision-learning-context";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	DeckClosure,
	ProposerContext,
	ShortcutTooltip,
} from "@/components/feed-deck-primitives";
import {
	createElement,
	lazy,
	Suspense,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DEFAULT_DECK_ROUTING,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionAttentionContext } from "@/components/decision-attention-context";
import { DecisionEnvelopeCard } from "@/components/decision-envelope-card";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { ApprovalDecisionCard } from "@/components/work-decision-stack";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { Button } from "@/components/kumo/button";
import { WorkReadRegion, WorkReadNotice } from "@/components/work-read-region";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";

import { osApi } from "@/lib/api";
import {
	osQuery,
	projectListQueryOptions,
	userProfileQueryOptions,
	workItemListQueryOptions,
} from "@/lib/os-query-options";
import {
	decisionDeadlinePassed,
	workIsUnowned,
	classReadiness,
	decisionFeedbackMetadata,
	type DecisionLearningReceipt,
} from "@/lib/decision-deck";
import {
	buildDecisionDeckPageChatExtras,
	buildDecisionDeckWebMcpTools,
} from "@/components/decision-deck-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import {
	createAgentSlot,
	DeckCardAgentContext,
	type DeckCardAgentHandle,
	type DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";
import { setPageFocus } from "@/lib/page-focus";
import { attentionMetrics } from "@/lib/deck-attention";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { WorkApprovalDecisionCard } from "@/components/work-approval-decision-card";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import { useOsLocale } from "@/lib/use-os-locale";
import { absoluteDate, absoluteTime } from "@/lib/time";

const deadlineLabel = (deadline: string) =>
	/^\d{4}-\d{2}-\d{2}$/.test(deadline)
		? absoluteDate(deadline)
		: absoluteTime(deadline);

const FactoryCards = lazy(() =>
	import("@/components/card-review-app").then((module) => ({
		default: module.CardReviewApp,
	})),
);

export function DecisionDeckApp(props: {
	config: DecisionDeckConfig;
	workspaceId?: string;
}) {
	return (
		<DecisionContextRail surface="deck">
			<WorkReadRegion>
				<DecisionDeckContent {...props} />
			</WorkReadRegion>
		</DecisionContextRail>
	);
}

function DecisionDeckContent({
	config,
	workspaceId,
}: {
	config: DecisionDeckConfig;
	workspaceId?: string;
}) {
	const deckRoot = useDeckViewport();
	const rail = useContext(DecisionRailContext);
	const reportRemaining = useContext(DeckRemainingContext);
	useOsLocale();
	const PROJECT_LABELS: Record<string, string> = OS_COPY.decisionDeck.projects;
	const client = useQueryClient();
	const { optimisticIds, saving, forCard } = useDeckDecision();
	const factories = useVisibleCardSources(
		config.factorySources,
		(source) => source.workspaceId,
	);
	const learningModel = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		...workRefreshOptions,
	});
	const [mode, setMode] = useState("decide");
	const [sessionLearningId, setSessionLearningId] = useState<string | null>(
		null,
	);
	const [kind, setKind] = useState("all");
	const [source, setSource] = useCardSourceFilter();
	const [contextQuestion, setContextQuestion] = useState<string | null>(null);
	const [project, setProject] = useState("all");
	const [urgency, setUrgency] = useState("all");
	const [search, setSearch] = useState("");
	const [index, setIndex] = useState(0);
	const [focusCard, setFocusCard] = useState(() =>
		new URLSearchParams(globalThis.location.hash.slice(1)).get("card"),
	);
	useEffect(() => {
		const sync = () =>
			setFocusCard(
				new URLSearchParams(globalThis.location.hash.slice(1)).get("card"),
			);
		globalThis.addEventListener("hashchange", sync);
		return () => globalThis.removeEventListener("hashchange", sync);
	}, []);
	const [agentSlots] = useState(() => ({
		card: createAgentSlot<DeckCardAgentHandle>(),
		notUseful: createAgentSlot<DeckNotUsefulHandle>(),
	}));
	const [practice, setPractice] = useState<DecisionLearningReceipt[]>([]);
	const [skipped, setSkipped] = useState<string[]>([]);
	const decisions = useDecisionInbox(config);
	const { inbox, approvals } = decisions;
	const history = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config.projectId,
				limit: config.limit,
				states: ["resolved"],
			},
		}),
		enabled: mode === "history",
		...workRefreshOptions,
	});
	const profile = useQuery(userProfileQueryOptions());
	const projects = useQuery(projectListQueryOptions(100));
	const projectNames = new Map(
		(projects.data?.data ?? []).map((row) => [row.id, row.name]),
	);
	const projectLabel = (id: string) =>
		projectNames.get(id) ??
		PROJECT_LABELS[id] ??
		(selectedProject.data?.id === id ? selectedProject.data.name : undefined);
	const learningQuery = useQuery({
		...osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
		...workRefreshOptions,
	});
	const receipts: DecisionLearningReceipt[] = (
		learningQuery.data?.events ?? []
	).flatMap((event) => {
		const meta = event.metadata;
		return event.surface === "decision_capture" &&
			meta?.answerSource === "os-decision-card" &&
			typeof meta.decisionClass === "string"
			? [
					{
						id: event.id,
						requestId: event.targetId ?? undefined,
						classId: meta.decisionClass,
						choice: String(meta.decisionChoice ?? "unknown"),
						signal: String(meta.feedbackSignal ?? "unknown"),
						at: event.occurredAt,
					},
				]
			: [];
	});
	const metrics = attentionMetrics(
		learningQuery.data?.events ?? [],
		new Date(),
		DEFAULT_DECK_ROUTING.version,
	);
	const { now, timeZone } = useCardSchedule();
	const visitId = useRef(crypto.randomUUID());
	useEffect(() => {
		if (!profile.data?.id) return;
		void osApi.learningFeedback
			.recordInteraction({
				clientEventId: `deck-visit:${visitId.current}`,
				eventKind: "delivered",
				signalClass: "lifecycle",
				scope: { kind: "personal" },
				surface: "decision_deck_visit",
			})
			.then(() =>
				client.invalidateQueries({
					queryKey: osQuery.learningFeedback.key(),
				}),
			)
			.catch(() => {});
	}, [profile.data?.id, client]);
	const practiceMode = mode === "practice";
	const waitingMode = mode === "waiting";
	const { rows, rank, compare } = projectDecisionDeck({
		config,
		mode,
		decisions,
		history: history.data?.data ?? [],
		learningModel: learningModel.data,
		now,
		timeZone,
	});
	// The agent tool answers "what is waiting?" in any mode, so the overview is
	// projected even while another view is on screen.
	const waitingRows = (
		waitingMode
			? rows
			: projectDecisionDeck({
					config,
					mode: "waiting",
					decisions,
					history: [],
					learningModel: learningModel.data,
					now,
					timeZone,
				}).rows
	)
		.sort(compare)
		.filter((row) => !optimisticIds.includes(row.id));
	const matchesFilters = (row: {
		origin?: CardOrigin;
		askKind: string;
		draftedNotSent: boolean;
		project: string;
		urgency: string;
		label: string;
	}) =>
		(kind === "all" ||
			(kind === "drafted_not_sent"
				? row.draftedNotSent
				: row.askKind === kind)) &&
		(mode !== "decide" || matchesCardSource(source, row.origin ?? null)) &&
		(project === "all" || row.project === project) &&
		(urgency === "all" || row.urgency === urgency) &&
		row.label.toLowerCase().includes(search.toLowerCase());
	const ranked = rows
		.sort(compare)
		.filter(
			(row) =>
				matchesFilters(row) &&
				!optimisticIds.includes(row.id) &&
				(mode !== "practice" || !skipped.includes(row.id)),
		);

	const available =
		mode === "practice"
			? rows.filter((row) => !skipped.includes(row.id))
			: rows;
	const filtered =
		mode === "decide"
			? ranked.filter((row) =>
					available.some((candidate) => candidate.id === row.id),
				)
			: ranked;
	// One count of undecided cards feeds the Work bar total and, unfiltered, the
	// card's progress, so the two cannot drift. A filter narrows only the card.
	const remaining = available.filter(
		(row) => !optimisticIds.includes(row.id),
	).length;
	useEffect(() => {
		if (mode === "decide" && !decisions.pending && !decisions.failed)
			reportRemaining?.(remaining);
	}, [mode, decisions.pending, decisions.failed, remaining, reportRemaining]);
	const filtersActive =
		kind !== "all" ||
		source !== ALL_CARD_SOURCES ||
		project !== "all" ||
		urgency !== "all" ||
		search !== "";
	const progress = useDeckProgress(
		`${workspaceId}:${profile.data?.id}:${mode}`,
		available,
		matchesFilters,
		filtersActive ? filtered.length : remaining,
	);
	const selected = waitingMode
		? undefined
		: mode === "decide" && focusCard
			? filtered.find((row) => row.id === focusCard)
			: filtered[Math.min(index, Math.max(0, filtered.length - 1))];
	// A factory card routing kept out of the decide queue can still be opened
	// from the Waiting list: show it through the same in-deck review view.
	const focusedFactoryKey =
		mode === "decide" && focusCard?.startsWith("factory:")
			? focusCard.slice("factory:".length)
			: null;
	const focusedFactoryCard =
		focusedFactoryKey !== null &&
		!selected &&
		decisions.factoryWaiting.some((card) => card.key === focusedFactoryKey);
	const selectedFocus = mode === "history" ? undefined : selected;
	const railOpenedBeforeDecision = selected
		? (rail?.openedBefore(selected.id) ?? false)
		: false;
	const preparedCard = useQuery({
		...workRefreshOptions,
		...osQuery.attention.getDeckCard.queryOptions({
			input: {
				cardId: selected?.id ?? "",
				projectId: config.projectId,
				limit: 100,
			},
		}),
		enabled: mode === "decide" && !!selected,
		staleTime: 60000,
		refetchInterval: 30000,
	});
	const cardPreferences = useOsPreferences();
	const [cardSettingsOpen, setCardSettingsOpen] = useState(false);
	const selectedSourceVersion =
		selected?.row?.request.version ??
		preparedCard.data?.factory?.revision ??
		preparedCard.data?.workApproval?.proposal.version ??
		null;
	const selectedViewKey =
		selected && profile.data?.id
			? `${globalThis.location.host}:${profile.data.id}:${selected.id}:${selectedSourceVersion ?? "unversioned"}`
			: null;
	useEffect(() => {
		if (mode === "decide" && selectedViewKey && railOpenedBeforeDecision)
			markCardDetails(selectedViewKey);
	}, [mode, selectedViewKey, railOpenedBeforeDecision]);
	const selectedProject = useQuery({
		...osQuery.projects.get.queryOptions({
			input: { id: selected?.project ?? "" },
		}),
		enabled: Boolean(
			selected?.project &&
			/^[0-9a-f-]{36}$/i.test(selected.project) &&
			!projectNames.has(selected.project),
		),
	});
	const prefetchIds = filtered
		.slice(
			Math.max(
				0,
				filtered.findIndex((row) => row.id === selected?.id),
			),
		)
		.slice(0, DECK_DETAIL_WINDOW)
		.map((row) => row.id)
		.join(",");
	useEffect(() => {
		if (mode !== "decide" || !prefetchIds) return;
		return prefetchDeckDetails(client, prefetchIds.split(","));
	}, [client, mode, prefetchIds]);
	const linkedWorkId = selected?.row?.workItem?.id;
	const selectedWork = useQuery({
		...workItemListQueryOptions({ idPrefix: linkedWorkId ?? "", limit: 1 }),
		enabled: Boolean(linkedWorkId) && mode === "decide",
		staleTime: 0,
		...workRefreshOptions,
		retry: false,
	});
	const nobodyOn = workIsUnowned(
		!selectedWork.isFetching && !selectedWork.isError
			? selectedWork.data?.data.find((work) => work.id === linkedWorkId)
			: undefined,
	);
	const expiresAt =
		selected?.row?.request.expiresAt ?? selected?.decision?.expiresAt;
	const pastDeadline =
		!!selected?.row && decisionDeadlinePassed(selected.row.request, now);
	const expired = !!expiresAt && Date.parse(expiresAt) <= now.getTime();
	const current = selected?.decision
		? {
				...selected.decision,
				expiresAt: expiresAt ?? undefined,
				nobodyOn: practiceMode ? selected.decision.nobodyOn : nobodyOn,
			}
		: null;
	const usesEnvelope = Boolean(
		current &&
		(practiceMode ||
			current.kind === "approval" ||
			current.kind === "adr" ||
			current.kind === "decision" ||
			current.options.some((option) => option.effect)),
	);
	const classId = current?.classId ?? selected?.kind;
	const instrumentationClassId =
		current?.classId ??
		(typeof selected?.row?.request.metadata.decisionClass === "string"
			? selected.row.request.metadata.decisionClass
			: (selected?.row?.request.kind ?? selected?.kind));
	useDecisionInstrumentation({
		enabled:
			mode === "decide" && Boolean(profile.data?.id) && !decisions.failed,
		scopeKey: `${globalThis.location.host}:${workspaceId}:${profile.data?.id}`,
		root: deckRoot,
		cardId: selected?.id,
		sourceVersion:
			selected?.row?.request.version ??
			decisions.work.find(
				(row) => `work-approval:${row.proposal.id}` === selected?.id,
			)?.proposal.version ??
			null,
		position: selected
			? filtered.findIndex((row) => row.id === selected.id)
			: 0,
		railOpened: railOpenedBeforeDecision,
		timezone: learningModel.data?.config.timezone ?? "UTC",
		ranking: {
			version: "decision-learning-v1",
			score:
				selected && learningModel.data?.config.enabled
					? rank(selected).score
					: null,
			features: selected ? rank(selected).factors : [],
		},
		candidates: rows.map((row) => ({
			id: row.id,
			score: learningModel.data?.config.enabled ? rank(row).score : null,
			position: filtered.some((candidate) => candidate.id === row.id)
				? filtered.findIndex((candidate) => candidate.id === row.id)
				: null,
			reason:
				row.id === selected?.id
					? "shown"
					: !ranked.some((candidate) => candidate.id === row.id)
						? "filtered"
						: !available.some((candidate) => candidate.id === row.id)
							? "batched"
							: filtered.findIndex((candidate) => candidate.id === row.id) >
								  filtered.findIndex(
										(candidate) => candidate.id === selected?.id,
								  )
								? "shown_later"
								: "ranked_lower",
		})),
		candidateSetComplete:
			!inbox.data?.nextCursor &&
			!decisions.queuePending &&
			!decisions.queueFailed &&
			factories.sources.length === 0,
	});
	const historicalLearning = classId
		? classReadiness(
				practiceMode ? practice : receipts,
				classId,
				config.classPolicies[classId]?.unchangedThreshold ??
					config.unchangedThreshold,
			)
		: null;
	const learnedReadiness = learningModel.data?.readiness.find(
		(r) => r.classId === classId,
	);
	const learning =
		!practiceMode && learningModel.data?.config.enabled && historicalLearning
			? {
					...historicalLearning,
					unchanged: learnedReadiness?.unchanged ?? 0,
					ready: learnedReadiness?.ready ?? false,
				}
			: historicalLearning;
	const clearFocusCard = () => {
		if (!focusCard) return;
		setFocusCard(null);
		globalThis.history.replaceState(
			globalThis.history.state,
			"",
			`${globalThis.location.pathname}${globalThis.location.search}`,
		);
	};
	const next = () => {
		clearFocusCard();
		if (mode === "history")
			setIndex((value) => Math.min(filtered.length - 1, value + 1));
		else if (selected) {
			if (practiceMode) setSkipped((value) => [...value, selected.id]);
			else {
				setIndex(
					(filtered.findIndex((row) => row.id === selected.id) + 1) %
						Math.max(1, filtered.length),
				);
				return;
			}
			setIndex(0);
		}
	};
	const previous = () => {
		clearFocusCard();
		setIndex(
			Math.max(0, filtered.findIndex((row) => row.id === selected?.id) - 1),
		);
	};
	const later =
		mode !== "history" && selected
			? () => {
					if (!practiceMode)
						void osApi.learningFeedback
							.recordInteraction({
								clientEventId: crypto.randomUUID(),
								eventKind: "ignored",
								scope: { kind: "personal" },
								surface: "decision_deck",
								targetType: "work_interaction",
								targetId: selected.id,
								metadata: {
									decisionClass: classId ?? selected.kind,
									decisionChoice: "later",
									...cardDecisionTiming(selectedViewKey),
									sourceVersion: selectedSourceVersion,
									railOpenedBeforeDecision:
										railOpenedBeforeDecision ||
										cardDetailsOpened(selectedViewKey),
									reaction: "skip",
									projectId: selected.project,
								},
							})
							.then(async (result) => {
								if (!result.duplicate && result.event?.id)
									setSessionLearningId(result.event.id);
								await client.invalidateQueries({
									queryKey: osQuery.learningFeedback.key(),
								});
							})
							.catch(() => {});
					next();
				}
			: null;
	const show = (cardId: string) => {
		const position = filtered.findIndex((row) => row.id === cardId);
		if (position < 0) return false;
		if (mode === "decide") setFocusCard(cardId);
		else setIndex(position);
		return true;
	};
	useEffect(() => {
		setPageFocus(
			selectedFocus
				? {
						type: "decision-card",
						id: selectedFocus.id,
						label: selectedFocus.label,
					}
				: null,
		);
	}, [selectedFocus?.id, selectedFocus?.label]);
	useEffect(() => () => setPageFocus(null), []);
	useAppWebMcpTools(
		"decision_deck",
		{
			mode,
			card: selected
				? {
						id: selected.id,
						kind: selected.kind,
						label: selected.label,
						decision: current ?? null,
					}
				: null,
			readiness: learning,
			remaining: available.length,
			queue: filtered.slice(0, 20).map((row) => ({
				id: row.id,
				label: row.label.slice(0, 160),
			})),
			waiting: waitingRows.map((row) => ({
				id: row.id,
				kind: row.kind,
				askKind: row.askKind,
				label: row.label.slice(0, 160),
				source: row.sourceLabel,
				project: projectLabel(row.project) ?? row.project,
				requestedAt: row.requestedAt,
				deadline: row.deadline,
				overdue: row.overdue,
				expired: row.expired ?? false,
				costOfWaiting: row.costOfWaiting,
			})),
			agent: agentSlots.card.get,
			notUseful: agentSlots.notUseful.get,
			later,
			show,
		},
		buildDecisionDeckWebMcpTools,
		[],
		{ pageChat: buildDecisionDeckPageChatExtras },
	);
	const optimisticDecision = forCard(
		mode === "decide" ? (selected?.id ?? null) : null,
		() => {
			clearFocusCard();
			setIndex(0);
		},
	);

	const preparedSourceMatches =
		preparedCard.data?.id === selected?.id &&
		(!selected?.row ||
			preparedCard.data?.interaction?.request.version ===
				selected.row.request.version);
	// The list already carries the stored summary, so the card renders from it at once.
	const listPresentation =
		DecisionCardPresentationSchema.safeParse(
			selected?.row?.request.metadata.cardPresentation,
		).data ?? null;
	const storedPreferences = cardPreferences.query.data?.preferences;
	const cardType = classId ?? "decision";
	const faceState =
		mode === "decide"
			? {
					presentation:
						(preparedSourceMatches ? preparedCard.data?.presentation : null) ??
						listPresentation,
					confidence: selected?.decision?.confidence ?? null,
					now,
					timeZone,
					dates: [
						selected?.row?.request.dueAt,
						selected?.decision?.expiresAt,
					].filter((date): date is string => Boolean(date)),
					// The "2 of 21" header line already carries the due date.
					dueInHeader: true,
					cardType,
					preferences: storedPreferences?.decisionCards,
					onContextUse: practiceMode
						? undefined
						: (
								shown: readonly DecisionCardContextItem[],
								opened: readonly DecisionCardContextItem[],
							) => {
								if (storedPreferences)
									cardPreferences.save.mutate({
										...storedPreferences,
										decisionCards: recordDecisionCardContextUse(
											storedPreferences.decisionCards,
											cardType,
											shown,
											opened,
										),
									});
							},
					onOpenSettings: () => setCardSettingsOpen(true),
				}
			: null;
	const content = createElement(
		DecisionLearningContext.Provider,
		{
			value:
				mode === "decide" && selected && learningModel.data?.config.enabled
					? rank(selected)
					: null,
		},
		<DecisionAttentionContext.Provider
			value={
				profile.data?.id
					? (choice) => {
							if (mode !== "decide" || !selected) return;
							const sourceVersion = selectedSourceVersion;
							const viewKey = selectedViewKey!;
							if (choice.signal === "opened_details") {
								markCardDetails(viewKey);
								return;
							}
							const firstViewedAt =
								choice.signal === "shown"
									? cardFirstView(viewKey)
									: readCardFirstView(viewKey);
							if (
								choice.signal === "shown" &&
								faceState?.presentation?.version === 2 &&
								faceState.presentation.sourceFingerprint
							)
								void osApi.learningFeedback
									.cardContextPrompt({
										cardId: selected.id,
										sourceFingerprint: faceState.presentation.sourceFingerprint,
										projectId: config.projectId,
										limit: 100,
									})
									.then(({ ask }) => {
										if (ask) setContextQuestion(viewKey);
									})
									.catch(() => {});
							if (choice.learningClientEventId)
								setSessionLearningId(choice.learningClientEventId);
							const intent =
								choice.intent ??
								current?.options.find((option) => option.id === choice.action)
									?.intent ??
								"approve";
							const eventKey =
								choice.signal === "shown"
									? crypto.subtle
											.digest(
												"SHA-256",
												new TextEncoder().encode(
													`${profile.data?.id}:${selected.id}:${now.toISOString().slice(0, 10)}`,
												),
											)
											.then(
												(hash) =>
													`deck-shown:${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
											)
									: Promise.resolve(`deck-action:${crypto.randomUUID()}`);
							void eventKey
								.then((clientEventId) =>
									osApi.learningFeedback.recordInteraction({
										clientEventId,
										signalClass:
											choice.signal === "shown" ? "lifecycle" : "quality",
										eventKind:
											choice.signal === "shown"
												? "delivered"
												: choice.signal === "rejected"
													? "rejected"
													: choice.signal === "edited"
														? "edited"
														: "accepted",
										scope: { kind: "personal" },
										surface:
											choice.signal === "shown"
												? "decision_deck_shown"
												: "decision_deck_action",
										targetType: "decision",
										targetId: selected.id,
										metadata: {
											answerSource: "os-decision-card",
											routingPolicyVersion: DEFAULT_DECK_ROUTING.version,
											decisionClass: classId ?? selected.kind,
											decisionChoice: intent,
											cardAction: choice.action,
											elapsedMs:
												choice.signal === "shown"
													? 0
													: firstViewedAt === undefined
														? choice.elapsedMs
														: Math.max(
																0,
																(choice.decidedAt ?? Date.now()) -
																	firstViewedAt,
															),
											...(firstViewedAt === undefined ? {} : { firstViewedAt }),
											sourceVersion,
											railOpenedBeforeDecision:
												railOpenedBeforeDecision ||
												cardDetailsOpened(viewKey) ||
												choice.detailsOpened === true,
										},
									}),
								)
								.then(async () => {
									await client.invalidateQueries({
										queryKey: osQuery.learningFeedback.key(),
									});
								})
								.catch(() => {});
						}
					: null
			}
		>
			<div
				ref={deckRoot}
				className="feed-deck fd-deck mx-auto grid w-full min-w-0 pb-8"
				data-workspace-app-entry="decision-deck"
			>
				<DecisionLearningFeedback eventId={sessionLearningId} />
				{mode === "decide" &&
					selected &&
					contextQuestion === selectedViewKey && (
						<CardContextFeedback key={selected.id} cardId={selected.id} />
					)}
				<DecisionDeckToolbar
					config={config}
					mode={mode}
					kind={kind}
					source={source}
					project={project}
					urgency={urgency}
					search={search}
					setMode={setMode}
					setKind={setKind}
					setSource={setSource}
					setProject={setProject}
					setUrgency={setUrgency}
					setSearch={setSearch}
					setIndex={setIndex}
					projectLabel={projectLabel}
					rows={rows}
					factories={factories}
				/>
				{progress.total > 0 &&
					!waitingMode &&
					(selected ||
						(!decisions.pending &&
							!decisions.failed &&
							!learningQuery.isPending &&
							!learningQuery.isError)) && (
						<DeckProgress
							total={progress.total}
							completed={progress.completed}
							position={Math.min(
								progress.total,
								progress.completed +
									(selected
										? filtered.findIndex((row) => row.id === selected.id) + 1
										: 0),
							)}
							filtered={filtersActive}
							saving={saving}
							leading={
								mode === "decide" ? (
									<DeckAskStrip card={selected} expiresAt={expiresAt} />
								) : undefined
							}
						/>
					)}
				{practiceMode && (
					<Text role="label" tone="secondary" className="fd-practice-notice">
						Practice only. Choices below stay in this preview and never approve
						Work, send messages or teach your real profile.
					</Text>
				)}
				{!practiceMode && (
					<WorkReadNotice
						failed={
							decisions.failed ||
							learningQuery.isError ||
							[
								inbox,
								approvals,
								decisions.approvalRequests,
								decisions.workApprovals,
								learningQuery,
							].some((query) => query.failureCount > 0)
						}
						partial={rows.length > 0}
						errors={[
							inbox,
							decisions.approvalRequests,
							approvals,
							decisions.workApprovals,
							learningQuery,
						].map((query) => query.error ?? query.failureReason)}
						retrying={
							inbox.isFetching ||
							decisions.approvalRequests.isFetching ||
							approvals.isFetching ||
							decisions.workApprovals.isFetching ||
							learningQuery.isFetching
						}
						retry={() => {
							void decisions.refetch();
							void learningQuery.refetch();
						}}
					/>
				)}
				{!selected &&
				!practiceMode &&
				(mode === "history"
					? history.isPending
					: decisions.pending || learningQuery.isPending) &&
				!(decisions.failed || learningQuery.isError) ? (
					<DeckCardSkeleton />
				) : waitingMode ? (
					<DeckWaitingList
						rows={filtered}
						onOpen={(cardId) => {
							setMode("decide");
							setIndex(0);
							setFocusCard(cardId);
						}}
						projectLabel={projectLabel}
						now={now}
					/>
				) : mode === "decide" &&
				  (selected?.id.startsWith("factory:") || focusedFactoryCard) ? (
					<div className="fd-deck-current">
						<Suspense fallback={<DeckCardSkeleton />}>
							{factories.pending ? (
								<DeckCardSkeleton />
							) : (
								<OptimisticDeckDecisionContext.Provider
									value={optimisticDecision}
								>
									<FactoryCards
										key={selected?.id ?? focusCard}
										inDeck
										routing={config.routing}
										classPolicies={config.classPolicies}
										config={{ version: 1, sources: factories.sources }}
										focusCardKey={(selected?.id ?? focusCard)!.slice(
											"factory:".length,
										)}
									/>
								</OptimisticDeckDecisionContext.Provider>
							)}
						</Suspense>
					</div>
				) : mode === "decide" && focusCard && !selected ? (
					<Text>
						{decisions.pending
							? "Opening that decision…"
							: "That decision is no longer available in this view."}
					</Text>
				) : selected ? (
					<div
						key={`${mode}:${selected.id}:${selected.row?.request.version ?? 0}`}
						className="fd-deck-current"
					>
						<DeckNoticeContext.Provider
							value={
								<>
									{!usesEnvelope && expired && (
										<Text>{OS_COPY.decisionDeck.expires(0)}</Text>
									)}
									{(selected.deadline || expiresAt) && (
										<DecisionContextSection title={decisionText("Dates")}>
											<dl className="fd-card-dates">
												{selected.deadline && (
													<>
														<dt>{decisionText("Due")}</dt>
														<dd>{deadlineLabel(selected.deadline)}</dd>
													</>
												)}
												{expiresAt && (
													<>
														<dt>{decisionText("Expires")}</dt>
														<dd>{absoluteTime(expiresAt)}</dd>
													</>
												)}
											</dl>
										</DecisionContextSection>
									)}
									{usesEnvelope && pastDeadline && (
										<p role="status">{OS_COPY.decisionDeck.revalidate}</p>
									)}
								</>
							}
						>
							<DeckCurationContext.Provider
								value={
									mode === "decide" &&
									!practiceMode &&
									selected.row?.request ? (
										<DeckNotUseful
											key={`${selected.row.request.id}:${selected.row.request.version}`}
											request={selected.row.request}
											disabled={saving}
										/>
									) : null
								}
							>
								<DeckFooterContext.Provider
									value={
										<>
											{mode !== "history" &&
												!current?.options.some(
													(option) => option.intent === "later",
												) && (
													<ShortcutTooltip
														label={decisionText(
															"Not now · back next time you open Decisions",
														)}
														shortcut="L"
													>
														<Button
															variant="outline"
															data-deck-later
															onClick={() => later?.()}
														>
															{decisionText("Not now")}
														</Button>
													</ShortcutTooltip>
												)}
										</>
									}
								>
									{" "}
									<ProposerContext.Provider
										value={{
											source: selected.row
												? {
														channel: "Decision capture",
														capturedAt: selected.row.request.requestedAt,
														evidenceUrl: `/work/interactions/${selected.row.request.id}`,
													}
												: undefined,
											project: selected.project
												? projectLabel(selected.project)
												: undefined,
											projectId: projectNames.has(selected.project)
												? selected.project
												: undefined,
											workItemId:
												selected.row?.workItem?.id ??
												selected.row?.request.workItemId ??
												undefined,
											actor: selected.row
												? workActorReference(
														selected.row.request.creatorType,
														selected.row.request.creatorId,
														{
															...selected.row.request.metadata,
															agentHarness:
																selected.row.creatorHarness ??
																selected.row.request.metadata.agentHarness,
														},
														selected.row.request.creatorSessionId,
													)
												: undefined,
										}}
									>
										<OptimisticDeckDecisionContext.Provider
											value={optimisticDecision}
										>
											<div
												key={selected.id}
												className="fd-decision-stack"
												data-has-next={filtered.length > 1}
												data-instant={mode === "decide"}
											>
												{mode === "history" ? (
													<WorkDecisionCard
														revisionTarget={
															selected.row
																? {
																		requestId: selected.row.request.id,
																		version: selected.row.request.version,
																	}
																: undefined
														}
														kind={current?.kind ?? "decision"}
														title={selected.label}
														askedBy={
															selected.row?.askedBy ?? decisionText("Your tedi")
														}
														body={selected.row?.request.prompt}
														why={
															<Link href={`/work/interactions/${selected.id}`}>
																{decisionText(
																	"Read the saved answer and history",
																)}
															</Link>
														}
														disabled
														onDecision={async () => {}}
														onNext={next}
														onPrevious={previous}
													/>
												) : selected.id.startsWith("work-approval:") ? (
													<WorkApprovalDecisionCard
														row={decisions.work.find(
															(row) =>
																`work-approval:${row.proposal.id}` ===
																selected.id,
														)!}
														onNext={next}
														onPrevious={previous}
													/>
												) : selected.id.startsWith("approval:") ? (
													<ApprovalDecisionCard
														id={selected.id.slice("approval:".length)}
														onNext={next}
														onPrevious={previous}
													/>
												) : current &&
												  (practiceMode ||
														current.kind === "approval" ||
														current.kind === "adr" ||
														current.kind === "decision" ||
														current.options.some((option) => option.effect)) ? (
													<DecisionEnvelopeCard
														revisionTarget={
															selected.row
																? {
																		requestId: selected.row.request.id,
																		version: selected.row.request.version,
																	}
																: undefined
														}
														decision={current}
														defaultLowStakesToDelegate={
															config.defaultLowStakesToDelegate
														}
														askedBy={
															practiceMode
																? decisionText("Example")
																: (selected.row?.askedBy ??
																	decisionText("Your tedi"))
														}
														disabled={
															mode === "history" || (!practiceMode && expired)
														}
														onNext={next}
														onPrevious={previous}
														onDecision={async (feedback, choice, elapsedMs) => {
															if (practiceMode) {
																setPractice((value) => [
																	...value,
																	{
																		id: crypto.randomUUID(),
																		classId: current.classId,
																		choice,
																		signal: feedback.signal,
																		at: new Date().toISOString(),
																		elapsedMs,
																	},
																]);
																return;
															}
															const request = selected.row!.request;
															const result =
																await osApi.workInteractions.respond({
																	requestId: request.id,
																	expectedRequestVersion: request.version,
																	responseKind: "answer",
																	body:
																		choice === "change"
																			? feedback.body
																			: `${current.options.find((option) => option.id === feedback.action)!.label}: ${current.options.find((option) => option.id === feedback.action)!.consequence}${feedback.feedback ? ` Feedback: ${feedback.feedback}` : ""}`,
																	resolvesRequest: choice !== "later",
																	metadata: decisionFeedbackMetadata(
																		feedback,
																		current.classId,
																		choice,
																		elapsedMs,
																	),
																});
															return result;
														}}
													/>
												) : (
													<WorkInteractionDecisionCard
														requestId={selected.id}
														preview={selected.row}
														askedBy={selected.row?.askedBy}
														autoFocus
														onNext={next}
														onPrevious={previous}
													/>
												)}
											</div>
										</OptimisticDeckDecisionContext.Provider>
									</ProposerContext.Provider>
								</DeckFooterContext.Provider>
							</DeckCurationContext.Provider>
						</DeckNoticeContext.Provider>
						{mode === "history" ? (
							<div className="fd-deck-navigation">
								<Button variant="ghost" onClick={previous}>
									{decisionText("Previous")}
								</Button>
								<Button variant="ghost" onClick={next}>
									{decisionText("Next")}
								</Button>
							</div>
						) : null}
					</div>
				) : (
					(practiceMode ||
						(mode === "history"
							? !history.isPending && !history.isError
							: !decisions.pending && !learningQuery.isPending)) &&
					(practiceMode || !(decisions.failed || learningQuery.isError)) &&
					(mode === "decide" &&
					progress.total > 0 &&
					progress.completed === progress.total ? (
						<DeckCompletion
							total={progress.total}
							filtered={filtersActive}
							saving={saving}
							onClearFilters={() => {
								setKind("all");
								setSource(ALL_CARD_SOURCES);
								setProject("all");
								setUrgency("all");
								setSearch("");
								setIndex(0);
							}}
						/>
					) : available.length > 0 ? (
						<Text>{OS_COPY.decisionDeck.noMatches}</Text>
					) : (
						<DeckClosure
							onHistory={() => {
								setMode("history");
								setIndex(0);
							}}
							summary={
								practiceMode
									? practice.length > 0
										? `${practice.length} practice choices in this preview.`
										: undefined
									: metrics.decisionsToday > 0
										? OS_COPY.feedDeckVisual.doneToday(metrics.decisionsToday)
										: undefined
							}
							streak={
								!practiceMode && config.gamification && metrics.streak > 0
									? OS_COPY.decisionDeck.streak(metrics.streak)
									: undefined
							}
						/>
					))
				)}
				<DecisionCardSettings
					open={cardSettingsOpen}
					onOpenChange={setCardSettingsOpen}
					cardType={cardType}
				/>
				<DecisionContextSection sectionId="style" title="Results and learning">
					{!practiceMode && <DeckCurationFooter />}
					<DeckAttentionMetrics />
					<LearnedToday />
					{mode === "decide" && classId && (
						<DecisionClassCalibration
							classId={instrumentationClassId ?? classId}
						/>
					)}
					<p>
						{learning?.ready
							? "Your recent choices favour this kind of recommendation."
							: "Your choices help shape future recommendations."}
					</p>
				</DecisionContextSection>
			</div>
		</DecisionAttentionContext.Provider>,
	);
	return createElement(
		CardFaceContext.Provider,
		{ value: faceState },
		createElement(
			DeckCardAgentContext.Provider,
			{ value: agentSlots },
			content,
		),
	);
}
