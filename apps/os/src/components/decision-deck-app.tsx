import {
	DecisionContextRail,
	DecisionContextToolbar,
	DecisionFilterChip,
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import { workActorReference } from "@/lib/work-actor";
import { LearnedToday } from "@/components/learned-today";
import {
	DeckRemainingContext,
	DeckFooterContext,
	DeckNoticeContext,
} from "@/components/deck-presentation-context";
import { interactionCardKind } from "@/lib/interaction-card-kind";
import { DecisionCardPresentationSchema } from "@tedix/api-contract/schemas/decision-card-presentation";
import { useDeckViewport } from "@/lib/use-deck-viewport";
import { useDecisionInstrumentation } from "@/lib/use-decision-instrumentation";
import { DecisionClassCalibration } from "@/components/decision-class-calibration";
import { DecisionLearningContext } from "@/components/decision-learning-context";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	DeckClosure,
	ProposerContext,
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
	DecisionKindSchema,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionAttentionContext } from "@/components/decision-attention-context";
import { DecisionEnvelopeCard } from "@/components/decision-envelope-card";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { ApprovalDecisionCard } from "@/components/work-decision-stack";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";

import { osApi } from "@/lib/api";
import {
	osQuery,
	projectListQueryOptions,
	userProfileQueryOptions,
	workItemListQueryOptions,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import {
	decisionDeadlinePassed,
	rankDecision,
	compareDecisionFreshness,
	workIsUnowned,
	classReadiness,
	decisionEnvelope,
	decisionFeedbackMetadata,
	type DecisionLearningReceipt,
} from "@/lib/decision-deck";
import { decisionCaptureSummary } from "@/lib/work-interaction-display";
import { buildDecisionDeckWebMcpTools } from "@/components/decision-deck-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import { deckBatchKey, useDeckBatch } from "@/lib/use-deck-batch";
import { deckBatchWindow, attentionMetrics } from "@/lib/deck-attention";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { WorkApprovalDecisionCard } from "@/components/work-approval-decision-card";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import { useOsLocale } from "@/lib/use-os-locale";

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
			<DecisionDeckContent {...props} />
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
	const KIND_LABELS: Record<string, string> = OS_COPY.decisionDeck.kinds;
	const PROJECT_LABELS: Record<string, string> = OS_COPY.decisionDeck.projects;
	const client = useQueryClient();
	const factories = useVisibleCardSources(
		config.factorySources,
		(source) => source.workspaceId,
	);
	const learningModel = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		refetchInterval: 60000,
	});
	const [mode, setMode] = useState("decide");
	const [sessionLearningId, setSessionLearningId] = useState<string | null>(
		null,
	);
	const [kind, setKind] = useState("all");
	const [project, setProject] = useState("all");
	const [urgency, setUrgency] = useState("all");
	const [search, setSearch] = useState("");
	const [index, setIndex] = useState(0);
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
	});
	const profile = useQuery(userProfileQueryOptions());
	const projects = useQuery(projectListQueryOptions(100));
	const projectNames = new Map(
		(projects.data?.data ?? []).map((row) => [row.id, row.name]),
	);
	const projectLabel = (id: string) =>
		projectNames.get(id) ??
		PROJECT_LABELS[id] ??
		OS_COPY.decisionDeck.projectUnavailable;
	const learningQuery = useQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
	);
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
	const metrics = attentionMetrics(learningQuery.data?.events ?? []);
	const todayCount = metrics.cardsToday;
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const window = deckBatchWindow(config.batchTimesUtc, now);
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
	const rows = practiceMode
		? config.examples.map((decision, i) => ({
				id: `example:${i}`,
				kind: decision.kind,
				label: decision.proposal,
				project: "Examples",
				urgency: "later",
				decision,
				row: undefined,
			}))
		: [
				...(mode === "history"
					? (history.data?.data ?? []).filter(
							(row) => row.effectiveState === "resolved",
						)
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
										preview: { body: presentation.body },
										recommendation: presentation.recommendation,
									}
								: decision,
						row,
					};
				}),
				...(mode === "decide"
					? decisions.work.map((row) => ({
							id: `work-approval:${row.proposal.id}`,
							kind: "approval",
							label: row.workItem.title,
							project: row.workItem.projectId ?? "Unfiled",
							urgency: "now",
							decision: null,
							row: undefined,
						}))
					: []),
				...(!config.projectId && mode === "decide"
					? (approvals.data?.data ?? []).map((approval) => ({
							id: `approval:${approval.id}`,
							kind: "approval",
							label: approval.description,
							project: "Organization",
							urgency: "now",
							decision: null,
							row: undefined,
						}))
					: []),
			];
	const rank = (row: (typeof rows)[number]) =>
		rankDecision(row, learningModel.data, new Date(), {
			classId:
				row.decision?.classId ??
				(typeof row.row?.request.metadata?.decisionClass === "string"
					? row.row.request.metadata.decisionClass
					: (row.row?.request.kind ?? row.kind)),
			dueAt: row.row?.request.dueAt,
			text: row.label,
			tediId:
				typeof row.row?.request.metadata?.proposerTediId === "string"
					? row.row.request.metadata.proposerTediId
					: null,
			source:
				typeof row.row?.request.metadata?.source === "string"
					? row.row.request.metadata.source
					: "decision_capture",
			channel:
				typeof row.row?.request.metadata?.channel === "string"
					? row.row.request.metadata.channel
					: undefined,
			personIds:
				typeof row.row?.request.metadata?.personId === "string"
					? [row.row.request.metadata.personId]
					: [],
		});
	const compare = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
		compareDecisionFreshness(
			{
				kind: mode === "decide" ? a.kind : undefined,
				dueAt: a.row?.request.dueAt,
				requestedAt: a.row?.request.requestedAt,
				score: learningModel.data?.config.enabled ? rank(a).score : undefined,
			},
			{
				kind: mode === "decide" ? b.kind : undefined,
				dueAt: b.row?.request.dueAt,
				requestedAt: b.row?.request.requestedAt,
				score: learningModel.data?.config.enabled ? rank(b).score : undefined,
			},
			now,
		);
	const ranked = rows
		.sort(compare)
		.filter(
			(row) =>
				(kind === "all" || row.kind === kind) &&
				(project === "all" || row.project === project) &&
				(urgency === "all" || row.urgency === urgency) &&
				row.label.toLowerCase().includes(search.toLowerCase()) &&
				(mode !== "practice" || !skipped.includes(row.id)),
		);
	const batchKey = deckBatchKey(
		workspaceId,
		profile.data?.id,
		config.projectId,
		window.key,
	);
	const { batch, dismiss } = useDeckBatch(
		batchKey,
		rows.map((row) => row.id),
		Math.max(0, config.dailyAttentionBudget - todayCount),
		mode === "decide" &&
			!!profile.data?.id &&
			!inbox.isPending &&
			!inbox.isError &&
			(decisions.requests.length > 0 ||
				(!decisions.queuePending && !decisions.queueFailed)) &&
			!learningQuery.isPending &&
			!learningQuery.isError,
	);
	const available =
		mode === "decide"
			? rows.filter(
					(row) =>
						batch &&
						(row.kind === "approval" ||
							decisions.scheduledIds.has(row.id) ||
							batch.ids.includes(row.id)) &&
						!batch.dismissed.includes(row.id),
				)
			: mode === "practice"
				? rows.filter((row) => !skipped.includes(row.id))
				: rows;
	const filtered =
		mode === "decide"
			? ranked.filter((row) =>
					available.some((candidate) => candidate.id === row.id),
				)
			: ranked;
	useEffect(() => {
		if (
			mode === "decide" &&
			(filtered.length > 0 || factories.sources.length === 0)
		)
			reportRemaining?.(filtered.length);
	}, [mode, filtered.length, factories.sources.length, reportRemaining]);
	const selected = filtered[Math.min(index, Math.max(0, filtered.length - 1))];
	const railOpenedBeforeDecision = selected
		? (rail?.openedBefore(selected.id) ?? false)
		: false;
	const prefetchIds = ranked
		.slice(0, 1)
		.filter((row) => row.row)
		.map((row) => row.id)
		.join(",");
	useEffect(() => {
		if (mode !== "decide" || !prefetchIds) return;
		for (const id of prefetchIds.split(","))
			void client.prefetchQuery(workInteractionDetailQueryOptions(id));
	}, [client, mode, prefetchIds]);
	const linkedWorkId = selected?.row?.workItem?.id;
	const selectedWork = useQuery({
		...workItemListQueryOptions({ idPrefix: linkedWorkId ?? "", limit: 1 }),
		enabled: Boolean(linkedWorkId) && mode === "decide",
		staleTime: 0,
		refetchInterval: 30_000,
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
			mode === "decide" &&
			Boolean(batch && profile.data?.id) &&
			!decisions.failed,
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
	const next = () => {
		if (mode === "history")
			setIndex((value) => Math.min(filtered.length - 1, value + 1));
		else if (selected) {
			if (practiceMode) setSkipped((value) => [...value, selected.id]);
			else dismiss(selected.id);
			setIndex(0);
		}
	};
	const previous = () => setIndex((value) => Math.max(0, value - 1));
	const budgetReached =
		mode === "decide" &&
		todayCount >= config.dailyAttentionBudget &&
		(!selected || !metrics.shownToday.includes(selected.id));
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
		},
		buildDecisionDeckWebMcpTools,
		[],
	);
	return createElement(
		DecisionLearningContext.Provider,
		{
			value:
				mode === "decide" && selected && learningModel.data?.config.enabled
					? rank(selected)
					: null,
		},
		<DecisionAttentionContext.Provider
			value={(choice) => {
				if (mode !== "decide" || !selected) return;
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
							signalClass: choice.signal === "shown" ? "lifecycle" : "quality",
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
								decisionClass: classId ?? selected.kind,
								decisionChoice: intent,
								elapsedMs: choice.elapsedMs,
								railOpenedBeforeDecision,
							},
						}),
					)
					.then(async () => {
						await client.invalidateQueries({
							queryKey: osQuery.learningFeedback.key(),
						});
					})
					.catch(() => {});
			}}
		>
			<div
				ref={deckRoot}
				className="feed-deck fd-deck mx-auto grid w-full min-w-0 pb-8"
				data-workspace-app-entry="decision-deck"
			>
				<DecisionLearningFeedback eventId={sessionLearningId} />
				<DecisionContextToolbar
					filters={
						<div className="fd-deck-filters">
							<div className="flex flex-wrap gap-2">
								<DecisionFilterChip
									label={kind === "all" ? "Kind" : KIND_LABELS[kind]}
								>
									<SegmentedControl
										ariaLabel={decisionText("Decision kind")}
										value={kind}
										onValueChange={(value) => {
											setKind(value);
											setIndex(0);
										}}
										options={["all", ...DecisionKindSchema.options].map(
											(value) => ({ value, label: KIND_LABELS[value] }),
										)}
									/>
									<div
										className="fd-deck-toolbar"
										aria-label={decisionText("Deck view")}
									>
										{[
											"decide",
											"history",
											...(config.examples.length ? ["practice"] : []),
										].map((value) => (
											<Button
												key={value}
												aria-pressed={mode === value}
												variant="ghost"
												onClick={() => {
													setMode(value);
													setIndex(0);
												}}
											>
												{value === "decide"
													? decisionText("For you")
													: value === "history"
														? decisionText("What you decided")
														: decisionText("Try examples")}
											</Button>
										))}
									</div>
								</DecisionFilterChip>
								<DecisionFilterChip
									label={project === "all" ? "Project" : projectLabel(project)}
								>
									<SegmentedControl
										ariaLabel={decisionText("Decision project")}
										value={project}
										onValueChange={(value) => {
											setProject(value);
											setIndex(0);
										}}
										options={[
											"all",
											...new Set(rows.map((row) => row.project)),
										].map((value) => ({
											value,
											label:
												value === "all"
													? decisionText("All projects")
													: projectLabel(value),
										}))}
									/>
								</DecisionFilterChip>
								<DecisionFilterChip
									label={
										urgency === "all"
											? "Urgency"
											: urgency === "now"
												? "Needs you now"
												: "Can wait"
									}
								>
									<SegmentedControl
										ariaLabel={decisionText("Decision urgency")}
										value={urgency}
										onValueChange={(value) => {
											setUrgency(value);
											setIndex(0);
										}}
										options={[
											{ value: "all", label: decisionText("Any urgency") },
											{ value: "now", label: decisionText("Needs you now") },
											{ value: "later", label: decisionText("Can wait") },
										]}
									/>
								</DecisionFilterChip>

								<Input
									aria-label={decisionText("Find decisions")}
									placeholder={decisionText("Find a decision")}
									value={search}
									onChange={(event) => {
										setSearch(event.target.value);
										setIndex(0);
									}}
								/>
							</div>
						</div>
					}
				>
					{selected && (
						<div className="fd-position" role="status">
							<Text tone="secondary">
								{OS_COPY.decisionDeck.position(
									(index % filtered.length) + 1,
									filtered.length,
								)}
							</Text>
						</div>
					)}
				</DecisionContextToolbar>
				{practiceMode && (
					<Text role="label">
						Practice only. Choices below stay in this preview and never approve
						Work, send messages or teach your real profile.
					</Text>
				)}
				{!practiceMode && (decisions.failed || learningQuery.isError) && (
					<Text role="body">
						Some decisions could not be loaded.{" "}
						<Button
							variant="outline"
							onClick={() => {
								void inbox.refetch();
								void decisions.approvalRequests.refetch();
								void approvals.refetch();
								void decisions.workApprovals.refetch();
								void learningQuery.refetch();
							}}
						>
							{decisionText("Try again")}
						</Button>
					</Text>
				)}
				{!practiceMode && inbox.isPending && (
					<Text>{decisionText("Loading decisions…")}</Text>
				)}
				{budgetReached ? (
					<Text>
						You’ve reached your attention budget.{" "}
						<Link href="/work/attention">Open Needs you</Link>
					</Text>
				) : selected ? (
					<div
						key={`${mode}:${selected.id}:${selected.row?.request.version ?? 0}`}
						className="fd-deck-current"
					>
						<DeckNoticeContext.Provider
							value={
								<>
									{!usesEnvelope && expiresAt && (
										<Text>
											{OS_COPY.decisionDeck.expires(
												Math.ceil(
													(Date.parse(expiresAt) - now.getTime()) / 60_000,
												),
											)}
										</Text>
									)}
									{usesEnvelope && pastDeadline && (
										<p role="status">{OS_COPY.decisionDeck.revalidate}</p>
									)}
								</>
							}
						>
							<DeckFooterContext.Provider
								value={
									mode !== "history" &&
									!current?.options.some(
										(option) => option.intent === "later",
									) && (
										<Button
											variant="outline"
											onClick={() => {
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
																railOpenedBeforeDecision,
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
											}}
										>
											{decisionText("Later")}
										</Button>
									)
								}
							>
								{" "}
								<ProposerContext.Provider
									value={{
										project: selected.project
											? projectLabel(selected.project)
											: undefined,
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
									<div
										className="fd-decision-stack"
										data-has-next={filtered.length > 1}
									>
										{mode === "history" ? (
											<WorkDecisionCard
												kind={current?.kind ?? "decision"}
												title={selected.label}
												askedBy={
													selected.row?.askedBy ?? decisionText("Your tedi")
												}
												body={selected.row?.request.prompt}
												why={
													<Link href={`/work/interactions/${selected.id}`}>
														{decisionText("Read the saved answer and history")}
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
														`work-approval:${row.proposal.id}` === selected.id,
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
													mode === "history" ||
													(!practiceMode && (pastDeadline || expired))
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
													const result = await osApi.workInteractions.respond({
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
													await client.invalidateQueries({
														queryKey: osQuery.workInteractions.key({
															type: "query",
														}),
													});
													await client.invalidateQueries({
														queryKey: osQuery.learningFeedback.key(),
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
								</ProposerContext.Provider>
							</DeckFooterContext.Provider>
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
					(practiceMode || mode === "history" || batch) &&
					!(decisions.failed || learningQuery.isError) &&
					(available.length > 0 ? (
						<Text>{OS_COPY.decisionDeck.noMatches}</Text>
					) : !practiceMode && factories.pending ? (
						<Text>{OS_COPY.feed.loading}</Text>
					) : !practiceMode && factories.sources.length > 0 ? (
						<div className="fd-deck-current">
							<Suspense fallback={<Text>{OS_COPY.feed.loading}</Text>}>
								<FactoryCards
									inDeck
									config={{ version: 1, sources: factories.sources }}
								/>
							</Suspense>
						</div>
					) : (
						<DeckClosure
							onHistory={() => {
								setMode("history");
								setIndex(0);
							}}
							title={OS_COPY.feedDeckVisual.clear}
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
							detail={OS_COPY.decisionDeck.nextBatch(
								window.next.toLocaleTimeString([], {
									hour: "2-digit",
									minute: "2-digit",
								}),
							)}
						/>
					))
				)}
				<DecisionContextSection
					sectionId="style"
					title="Learning your preferences"
				>
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
}
