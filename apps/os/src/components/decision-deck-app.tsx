import { DecisionLearningContext } from "@/components/decision-learning-context";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	DeckClosure,
	FeedDeckDisclosure,
} from "@/components/feed-deck-primitives";
import { createElement, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	DecisionKindSchema,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { WeeklyDecisionDigest } from "@/components/weekly-decision-digest";
import { DecisionAttentionContext } from "@/components/decision-attention-context";
import { DecisionEnvelopeCard } from "@/components/decision-envelope-card";
import { WorkInteractionDecisionCard } from "@/components/work-interaction-decision-card";
import { ApprovalDecisionCard } from "@/components/work-decision-stack";
import { WorkDecisionCard } from "@/components/work-decision-card";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import {
	osQuery,
	projectListQueryOptions,
	userProfileQueryOptions,
	workItemListQueryOptions,
	workInteractionDetailQueryOptions,
} from "@/lib/os-query-options";
import {
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
import { useDeckBatch } from "@/lib/use-deck-batch";
import { deckBatchWindow, attentionMetrics } from "@/lib/deck-attention";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { WorkApprovalDecisionCard } from "@/components/work-approval-decision-card";
import { OS_COPY } from "@/shared/os-copy";

const KIND_LABELS: Record<string, string> = OS_COPY.decisionDeck.kinds;
const PROJECT_LABELS: Record<string, string> = OS_COPY.decisionDeck.projects;

export function DecisionDeckApp({
	config,
	workspaceId,
}: {
	config: DecisionDeckConfig;
	workspaceId?: string;
}) {
	const client = useQueryClient();
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
					const metadata = row.request.metadata;
					const cardKind =
						decision?.kind ??
						(metadata?.schema === "tedix.outbound.v1"
							? "outbound"
							: row.request.kind === "handoff"
								? "proposal"
								: metadata?.decisionCard
									? "decision"
									: "question");
					return {
						id: row.request.id,
						kind: cardKind,
						label: row.request.subject,
						project:
							row.workItem?.projectId ?? row.request.projectId ?? "Unfiled",
						urgency: decisionCaptureSummary(metadata)?.urgency ?? "later",
						decision,
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
				dueAt: a.row?.request.dueAt,
				requestedAt: a.row?.request.requestedAt,
				score: learningModel.data?.config.enabled ? rank(a).score : undefined,
			},
			{
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
	const batchKey = `${workspaceId ?? "preview"}:${profile.data?.id}:${config.projectId ?? "all"}:${window.key}`;
	const { batch, dismiss } = useDeckBatch(
		batchKey,
		rows.map((row) => row.id),
		Math.max(0, config.dailyAttentionBudget - todayCount),
		mode === "decide" &&
			!!profile.data?.id &&
			!decisions.pending &&
			!decisions.failed &&
			!learningQuery.isPending &&
			!learningQuery.isError,
	);
	const available =
		mode === "decide"
			? rows.filter(
					(row) =>
						batch?.ids.includes(row.id) && !batch.dismissed.includes(row.id),
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
	const selected = filtered[Math.min(index, Math.max(0, filtered.length - 1))];
	const prefetchIds = ranked
		.slice(0, 3)
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
		!!selected?.row?.request.dueAt &&
		Date.parse(selected.row.request.dueAt) < now.getTime();
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
			current.kind === "adr" ||
			current.kind === "decision" ||
			current.options.some((option) => option.effect)),
	);
	const classId = current?.classId ?? selected?.kind;
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
	const threshold =
		!practiceMode && learningModel.data?.config.enabled
			? learningModel.data.config.unchangedThreshold
			: ((classId
					? config.classPolicies[classId]?.unchangedThreshold
					: undefined) ?? config.unchangedThreshold);
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
							},
						}),
					)
					.then(async (result) => {
						if (
							choice.signal !== "shown" &&
							!result.duplicate &&
							result.event?.id
						)
							setSessionLearningId(result.event.id);
						await client.invalidateQueries({
							queryKey: osQuery.learningFeedback.key(),
						});
					})
					.catch(() => {});
			}}
		>
			<div
				className="feed-deck fd-deck mx-auto grid w-full min-w-0 pb-8"
				data-workspace-app-entry="decision-deck"
			>
				<DecisionLearningFeedback eventId={sessionLearningId} />
				<header className="fd-deck-heading">
					<Text as="h2" tone="mono">
						{OS_COPY.decisionDeck.title}
					</Text>
					<Text>{OS_COPY.decisionDeck.intro}</Text>
				</header>
				{mode !== "history" && (
					<div className="fd-deck-progress" role="status">
						<Text weight="semibold">
							{OS_COPY.decisionDeck.left(available.length)}
						</Text>
						<progress
							aria-label="Deck progress"
							max={Math.max(
								1,
								mode === "practice"
									? config.examples.length
									: (batch?.ids.length ?? 0),
							)}
							value={Math.max(
								0,
								(mode === "practice"
									? config.examples.length
									: (batch?.ids.length ?? 0)) - available.length,
							)}
							className="w-full"
						/>
						{config.gamification && (
							<Text tone="secondary">
								{OS_COPY.decisionDeck.dailyGoal(
									metrics.decisionsToday,
									config.dailyGoal,
								)}{" "}
								· {OS_COPY.decisionDeck.streak(metrics.streak)}
							</Text>
						)}
					</div>
				)}
				<div className="fd-deck-toolbar" aria-label="Deck view">
					{[
						"decide",
						"history",
						...(config.examples.length ? ["practice"] : []),
					].map((value) => (
						<Button
							key={value}
							aria-pressed={mode === value}
							variant={mode === value ? "default" : "ghost"}
							onClick={() => {
								setMode(value);
								setIndex(0);
							}}
						>
							{value === "decide"
								? "For you"
								: value === "history"
									? "What you decided"
									: "Try examples"}
						</Button>
					))}
				</div>
				<FeedDeckDisclosure
					className="fd-deck-filters"
					title={OS_COPY.decisionDeck.filters}
				>
					<div className="flex flex-wrap gap-2">
						<Select
							value={kind}
							onValueChange={(value) => {
								setKind(value ?? "all");
								setIndex(0);
							}}
						>
							<SelectTrigger aria-label="Decision kind">
								<SelectValue>{KIND_LABELS[kind]}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All kinds</SelectItem>
								{DecisionKindSchema.options.map((value) => (
									<SelectItem key={value} value={value}>
										{KIND_LABELS[value]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={project}
							onValueChange={(value) => {
								setProject(value ?? "all");
								setIndex(0);
							}}
						>
							<SelectTrigger aria-label="Decision project">
								<SelectValue>
									{project === "all" ? "All projects" : projectLabel(project)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All projects</SelectItem>
								{[...new Set(rows.map((row) => row.project))].map((value) => (
									<SelectItem key={value} value={value}>
										{projectLabel(value)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select
							value={urgency}
							onValueChange={(value) => {
								setUrgency(value ?? "all");
								setIndex(0);
							}}
						>
							<SelectTrigger aria-label="Decision urgency">
								<SelectValue>
									{urgency === "all"
										? "Any urgency"
										: urgency === "now"
											? "Needs you now"
											: "Can wait"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">Any urgency</SelectItem>
								<SelectItem value="now">Needs you now</SelectItem>
								<SelectItem value="later">Can wait</SelectItem>
							</SelectContent>
						</Select>
						<Input
							aria-label="Find decisions"
							placeholder="Find a decision"
							value={search}
							onChange={(event) => {
								setSearch(event.target.value);
								setIndex(0);
							}}
						/>
					</div>
				</FeedDeckDisclosure>
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
								void approvals.refetch();
								void decisions.workApprovals.refetch();
								void learningQuery.refetch();
							}}
						>
							Try again
						</Button>
					</Text>
				)}
				{!practiceMode && inbox.isPending && <Text>Loading decisions…</Text>}
				{budgetReached ? (
					<Text>
						You’ve reached your attention budget.{" "}
						<Link href="/work/attention">Open Needs you</Link>
					</Text>
				) : selected ? (
					<div
						key={`${mode}:${selected.id}:${selected.row?.request.version ?? 0}`}
						className="grid gap-3"
					>
						<Text role="label">
							{OS_COPY.decisionDeck.cardKinds[selected.kind]} ·{" "}
							{(index % filtered.length) + 1} of {filtered.length}
						</Text>
						{!usesEnvelope && expiresAt && (
							<Text>
								{OS_COPY.decisionDeck.expires(
									Math.ceil((Date.parse(expiresAt) - now.getTime()) / 60_000),
								)}
							</Text>
						)}
						{usesEnvelope && pastDeadline && (
							<p role="status">{OS_COPY.decisionDeck.revalidate}</p>
						)}
						<div
							className="fd-decision-stack"
							data-has-next={filtered.length > 1}
						>
							{mode === "history" ? (
								<WorkDecisionCard
									kind={current?.kind ?? "decision"}
									title={selected.label}
									askedBy={selected.row?.askedBy ?? "Your tedi"}
									body={selected.row?.request.prompt}
									why={
										<Link href={`/work/interactions/${selected.id}`}>
											Read the saved answer and history
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
										(row) => `work-approval:${row.proposal.id}` === selected.id,
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
									current.kind === "adr" ||
									current.kind === "decision" ||
									current.options.some((option) => option.effect)) ? (
								<DecisionEnvelopeCard
									decision={current}
									defaultLowStakesToDelegate={config.defaultLowStakesToDelegate}
									askedBy={
										practiceMode
											? "Example"
											: (selected.row?.askedBy ?? "Your tedi")
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
										await client.invalidateQueries({
											queryKey: osQuery.workInteractions.key({ type: "query" }),
										});
										await client.invalidateQueries({
											queryKey: osQuery.learningFeedback.key(),
										});
									}}
								/>
							) : (
								<WorkInteractionDecisionCard
									requestId={selected.id}
									askedBy={selected.row?.askedBy}
									autoFocus
									onNext={next}
									onPrevious={previous}
								/>
							)}
						</div>
						{mode === "history" ? (
							<div className="fd-deck-navigation">
								<Button variant="outline" onClick={previous}>
									Previous
								</Button>
								<Button variant="outline" onClick={next}>
									Next
								</Button>
							</div>
						) : (
							!current?.options.some((option) => option.intent === "later") && (
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
									Later
								</Button>
							)
						)}
					</div>
				) : (
					!inbox.isPending &&
					(practiceMode || batch) &&
					!(decisions.failed || learningQuery.isError) &&
					(available.length > 0 ? (
						<Text>{OS_COPY.decisionDeck.noMatches}</Text>
					) : (
						<DeckClosure
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
				{learning && classId && (
					<FeedDeckDisclosure
						className="fd-deck-learning"
						label="Class readiness"
						title={OS_COPY.feedDeckVisual.learning}
					>
						<Text weight="medium">
							{classId}: {learning.unchanged}/{threshold} unchanged approvals
						</Text>
						<Text tone="secondary">
							{learning.ready
								? "Ready for a delegation review"
								: "Learning your preferences"}{" "}
							· {learning.delegated}/{learning.total} delegated ·{" "}
							{Math.round(
								(config.classPolicies[classId]?.auditSampleRate ??
									config.auditSampleRate) * 100,
							)}
							% proposed audits
						</Text>
						<Text role="label">
							Recent loaded history only. Readiness does not grant permission or
							turn on automation.
						</Text>
					</FeedDeckDisclosure>
				)}

				{mode === "history" && <WeeklyDecisionDigest />}
				{selected && practiceMode && practice.length > 0 && (
					<Text>{practice.length} practice choices in this preview.</Text>
				)}
				{!practiceMode &&
					(inbox.data?.hasMore ||
						history.data?.hasMore ||
						learningQuery.data?.events.length === 200) && (
						<Link href="/work/attention">
							More history and decisions in Work
						</Link>
					)}
				<p className="fd-deck-shortcuts">{OS_COPY.decisionDeck.shortcuts}</p>
				<Link href="/account/profile">
					Your style profile and last 10 approvals
				</Link>
			</div>
		</DecisionAttentionContext.Provider>,
	);
}
