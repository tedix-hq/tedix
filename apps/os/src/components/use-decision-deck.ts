import { useDeckDecision } from "./use-deck-decision";
import {
	decisionLearningReceipts,
	recordDeckLater,
} from "./deck-learning-events";
import { projectDecisionDeck } from "./decision-deck-projection";
import { useCardSourceFilter } from "./use-card-source-filter";
import {
	ALL_CARD_SOURCES,
	matchesCardSource,
	type CardOrigin,
} from "@/lib/card-source-filter";
import type { DeckBandFilter } from "@/components/deck-priority-bands";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { useOsPreferences } from "@/lib/use-os-preferences";
import { workRefreshOptions } from "@/lib/work-refresh";
import {
	DECK_DETAIL_WINDOW,
	prefetchDeckDetails,
} from "@/lib/deck-detail-prefetch";
import { DecisionRailContext } from "@/components/decision-context-rail";
import { useDeckProgress } from "@/lib/use-deck-progress";
import { DeckRemainingContext } from "@/components/deck-presentation-context";
import { markCardDetails } from "@/lib/card-first-view";
import { useDeckViewport } from "@/lib/use-deck-viewport";
import { useDecisionInstrumentation } from "@/lib/use-decision-instrumentation";
import { useContext, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DEFAULT_DECK_ROUTING,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
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
	type DecisionLearningReceipt,
} from "@/lib/decision-deck";
import { buildDecisionDeckWebMcpTools } from "@/components/decision-deck-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import {
	createAgentSlot,
	type DeckCardAgentHandle,
	type DeckNotUsefulHandle,
} from "@/lib/deck-card-agent";
import { setPageFocus } from "@/lib/page-focus";
import { attentionMetrics } from "@/lib/deck-attention";
import { useDeckInbox } from "@/lib/shared-deck-inbox";
import { OS_COPY } from "@/shared/os-copy";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import { useOsLocale } from "@/lib/use-os-locale";

/**
 * Everything the Decisions deck decides before it draws: which cards are in the
 * queue, which one is on screen, how the filters and navigation move through
 * them, and the learning records and instrumentation for the card shown.
 * DecisionDeckApp only renders what this returns.
 */
export function useDecisionDeck(
	config: DecisionDeckConfig,
	workspaceId: string | undefined,
) {
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
		const position = filtered.findIndex((row) => row.id === selected?.id);
		// Deciding wraps both ways, like next; history stops at the newest.
		setIndex(
			mode === "history"
				? Math.max(0, position - 1)
				: (position - 1 + filtered.length) % Math.max(1, filtered.length),
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
	return {
		deckRoot,
		client,
		optimisticIds,
		saving,
		factories,
		learningModel,
		mode,
		setMode,
		sessionLearningId,
		kind,
		setKind,
		source,
		setSource,
		contextQuestion,
		setContextQuestion,
		project,
		setProject,
		urgency,
		setUrgency,
		band,
		setBand,
		search,
		setSearch,
		setIndex,
		focusCard,
		setFocusCard,
		agentSlots,
		practice,
		setPractice,
		decisions,
		inbox,
		approvals,
		history,
		profile,
		projectNames,
		projectLabel,
		learningQuery,
		metrics,
		now,
		timeZone,
		practiceMode,
		waitingMode,
		rows,
		rank,
		matchesOtherFilters,
		available,
		filtered,
		filtersActive,
		progress,
		counting,
		selected,
		focusedFactoryCard,
		cardSettingsOpen,
		setCardSettingsOpen,
		selectedViewKey,
		expiresAt,
		pastDeadline,
		expired,
		current,
		usesEnvelope,
		classId,
		instrumentationClassId,
		learning,
		clearFocusCard,
		next,
		previous,
		learningCard,
		later,
		show,
		optimisticDecision,
		cardType,
		faceState,
	};
}
