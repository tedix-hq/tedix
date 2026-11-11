import { useDeckDecision } from "./use-deck-decision";
import {
	decisionLearningReceipts,
	recordDeckChoice,
	recordDeckLater,
} from "./deck-learning-events";
import { decisionOutcome } from "@/lib/decision-outcome";
import { respondConfirmed } from "@/lib/respond-confirmed";
import { projectDecisionDeck } from "./decision-deck-projection";
import { DecisionDeckToolbar } from "./decision-deck-toolbar";
import { DeckWaitingList } from "./decision-deck-waiting";
import { DeckReminders } from "./decision-deck-reminders";
import { useCardSourceFilter } from "./use-card-source-filter";
import {
	ALL_CARD_SOURCES,
	matchesCardSource,
	type CardOrigin,
} from "@/lib/card-source-filter";
import { CardSnooze } from "@/components/card-snooze";
import { DeckStewardHandoff } from "@/components/deck-steward-handoff";
import {
	DeckPriorityBands,
	type DeckBandFilter,
} from "@/components/deck-priority-bands";
import { DeckAskStrip } from "@/components/deck-ask-strip";
import { DeckCurationFooter } from "@/components/deck-curation-footer";
import { DeckNotUseful } from "@/components/deck-not-useful";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
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
import { markCardDetails } from "@/lib/card-first-view";
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
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
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
import { buildDecisionDeckWebMcpTools } from "@/components/decision-deck-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import {
	createAgentSlot,
	DeckCardAgentContext,
	type DeckCardAgentHandle,
	type DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";
import { setPageFocus } from "@/lib/page-focus";
import { attentionMetrics } from "@/lib/deck-attention";
import { useDeckInbox } from "@/lib/shared-deck-inbox";
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
	const [band, setBand] = useState<DeckBandFilter>("all");
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
	const pinnedOrder = useRef({ mode, order: new Map<string, number>() });
	const decisions = useDeckInbox(config);
	const { inbox, approvals } = decisions;
	const history = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config.projectId,
				limit: config.limit,
				states: ["resolved", "cancelled"],
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
	const receipts = decisionLearningReceipts(learningQuery.data?.events ?? []);
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
	type FilterRow = {
		origin?: CardOrigin;
		askKind: string;
		draftedNotSent: boolean;
		project: string;
		urgency: string;
		label: string;
		priority?: { band: string };
	};
	const matchesFilters = (row: FilterRow) =>
		(mode !== "decide" || band === "all" || row.priority?.band === band) &&
		matchesOtherFilters(row);
	// Every filter but the band: the band header counts these.
	const matchesOtherFilters = (row: FilterRow) =>
		(kind === "all" ||
			(kind === "drafted_not_sent"
				? row.draftedNotSent
				: row.askKind === kind)) &&
		(mode !== "decide" || matchesCardSource(source, row.origin ?? null)) &&
		(project === "all" || row.project === project) &&
		(urgency === "all" || row.urgency === urgency) &&
		row.label.toLowerCase().includes(search.toLowerCase());
	// Once every source has loaded, the order stays as first shown while the
	// deck is open; new cards join at the end, so the card on screen and its
	// Details panel never swap.
	if (pinnedOrder.current.mode !== mode || decisions.pending)
		pinnedOrder.current = { mode, order: new Map() };
	const pinned = pinnedOrder.current.order;
	rows.sort(compare);
	if (mode === "decide" && !decisions.pending) {
		for (const row of rows)
			if (!pinned.has(row.id)) pinned.set(row.id, pinned.size);
		rows.sort((a, b) => pinned.get(a.id)! - pinned.get(b.id)!);
	}
	const ranked = rows.filter(
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
		band !== "all" ||
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
	// Until every source has answered, a count would climb (1 of 1, then 1 of
	// 99…), so the counter says it is still counting instead.
	const counting =
		mode === "decide" && (decisions.pending || learningQuery.isPending);
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
	// What the learning records need to name the card on screen.
	const learningCard = (card: NonNullable<typeof selected>) => ({
		client,
		cardId: card.id,
		classId: classId ?? card.kind,
		sourceVersion: selectedSourceVersion,
		viewKey: selectedViewKey,
		railOpened: railOpenedBeforeDecision,
		onLearningEvent: setSessionLearningId,
	});
	const later =
		mode !== "history" && selected
			? () => {
					if (!practiceMode)
						recordDeckLater({
							...learningCard(selected),
							projectId: selected.project,
						});
					next();
				}
			: null;
	const show = (cardId: string) => {
		if (mode === "decide" && band !== "all") {
			setBand("all");
			setFocusCard(cardId);
			return rows.some((row) => row.id === cardId);
		}
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
					lastRelatedDecision: selected?.row?.lastRelatedDecision,
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
							recordDeckChoice(choice, {
								...learningCard(selected),
								viewKey: selectedViewKey!,
								userId: profile.data!.id,
								now,
								deckProjectId: config.projectId,
								presentation: faceState?.presentation,
								optionIntent: (action) =>
									current?.options.find((option) => option.id === action)
										?.intent,
								onContextQuestion: setContextQuestion,
							});
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
					priorityControls={
						mode === "decide" &&
						!decisions.pending &&
						rows.length > 0 && (
							<DeckPriorityBands
								rows={rows.filter(
									(row) =>
										matchesOtherFilters(row) && !optimisticIds.includes(row.id),
								)}
								band={band}
								onBandChange={(value) => {
									setBand(value);
									clearFocusCard();
									setIndex(0);
								}}
								onOpen={(cardId) => void show(cardId)}
								now={now}
								timeZone={timeZone}
							/>
						)
					}
				/>
				{mode === "decide" && (
					<DeckReminders reminders={decisions.reminders} now={now} />
				)}
				{(counting ||
					(progress.total > 0 &&
						!waitingMode &&
						(selected || (!decisions.failed && !learningQuery.isError)))) && (
					<DeckProgress
						counting={counting}
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
						failed={decisions.failed || learningQuery.isError}
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
					<div className="grid gap-3">
						<Text>
							{decisions.pending
								? "Opening that decision…"
								: "That decision is no longer available in this view."}
						</Text>
						{decisions.pending ? null : (
							<Button variant="outline" onClick={clearFocusCard}>
								{decisionText("Back to Decisions")}
							</Button>
						)}
					</div>
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
											{mode === "decide" &&
												selected?.row?.request.kind === "question" &&
												selected.row.request.metadata.approvalOperation ===
													undefined && (
													<DeckStewardHandoff
														key={`${selected.row.request.id}:${selected.row.request.version}`}
														request={selected.row.request}
														reason={selected.priority.reason}
														onRouted={async () => {
															clearFocusCard();
															setIndex(0);
															await client.invalidateQueries({
																queryKey: osQuery.workInteractions.key(),
															});
														}}
													/>
												)}
											{mode === "decide" && selected?.row && (
												<CardSnooze
													request={selected.row.request}
													onSnoozed={async () => {
														clearFocusCard();
														setIndex(0);
														await client.invalidateQueries({
															queryKey: osQuery.workInteractions.key(),
														});
													}}
												/>
											)}
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
															<>
																{selected.row && (
																	<p data-decision-outcome>
																		{
																			decisionOutcome(
																				selected.row.request,
																				selected.row.effectiveState,
																			)?.line
																		}
																	</p>
																)}
																<Link
																	href={`/work/interactions/${selected.id}`}
																>
																	{decisionText(
																		"Read the saved answer and history",
																	)}
																</Link>
															</>
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
															const result = await respondConfirmed(
																osApi.workInteractions,
																{
																	requestId: request.id,
																	expectedRequestVersion: request.version,
																	responseKind: "answer",
																	body:
																		choice === "change"
																			? feedback.body
																			: `${current.options.find((option) => option.id === feedback.action)!.label}: ${current.options.find((option) => option.id === feedback.action)!.consequence}${feedback.feedback ? ` Feedback: ${feedback.feedback}` : ""}`,
																	resolvesRequest: choice !== "later",
																	...(feedback.reviewedChangesThrough
																		? {
																				reviewedChangesThrough:
																					feedback.reviewedChangesThrough,
																			}
																		: {}),
																	metadata: decisionFeedbackMetadata(
																		feedback,
																		current.classId,
																		choice,
																		elapsedMs,
																	),
																},
															);
															// Outside the decide queue nothing removes the card
															// optimistically, so read the queue again.
															if (mode !== "decide")
																void client.invalidateQueries({
																	queryKey: osQuery.workInteractions.key(),
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
								setBand("all");
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
				<DecisionContextSection sectionId="style" title="Your decisions">
					<p>
						{learning?.ready
							? "Your recent choices favour this kind of recommendation."
							: "Your choices help shape future recommendations."}
					</p>
					{/* Stats load only when someone asks for them. */}
					<Collapsible>
						<CollapsibleDefaultTrigger>
							{decisionText("Stats and learned rules")}
						</CollapsibleDefaultTrigger>
						<CollapsibleDefaultContent className="grid gap-3">
							{!practiceMode && <DeckCurationFooter />}
							<DeckAttentionMetrics />
							<LearnedToday />
							{mode === "decide" && classId && (
								<DecisionClassCalibration
									classId={instrumentationClassId ?? classId}
								/>
							)}
						</CollapsibleDefaultContent>
					</Collapsible>
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
