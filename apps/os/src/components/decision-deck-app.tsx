import { recordDeckChoice } from "./deck-learning-events";
import { decisionOutcome } from "@/lib/decision-outcome";
import { respondConfirmed } from "@/lib/respond-confirmed";
import { DecisionDeckToolbar } from "./decision-deck-toolbar";
import { DeckWaitingList } from "./decision-deck-waiting";
import { DeckReminders } from "./decision-deck-reminders";
import { ALL_CARD_SOURCES } from "@/lib/card-source-filter";
import { CardSnooze } from "@/components/card-snooze";
import { DeckStewardHandoff } from "@/components/deck-steward-handoff";
import { DeckPriorityBands } from "@/components/deck-priority-bands";
import { DeckAskStrip } from "@/components/deck-ask-strip";
import { DeckCurationFooter } from "@/components/deck-curation-footer";
import { DeckNotUseful } from "@/components/deck-not-useful";
import { DecisionCardSettings } from "@/components/decision-card-settings";
import { OptimisticDeckDecisionContext } from "@/lib/optimistic-deck-decision";
import {
	DecisionContextRail,
	DecisionContextSection,
} from "@/components/decision-context-rail";
import { workActorReference } from "@/lib/work-actor";
import {
	DeckProgress,
	DeckCompletion,
	DeckCardSkeleton,
} from "@/components/deck-progress";
import { LearnedToday } from "@/components/learned-today";
import { DeckAttentionMetrics } from "@/components/deck-attention-metrics";
import {
	DeckCurationContext,
	DeckFooterContext,
	DeckNoticeContext,
	CardFaceContext,
} from "@/components/deck-presentation-context";
import { CardContextFeedback } from "@/components/card-context-feedback";
import { DecisionClassCalibration } from "@/components/decision-class-calibration";
import { DecisionLearningContext } from "@/components/decision-learning-context";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	DeckClosure,
	ProposerContext,
	ShortcutTooltip,
} from "@/components/feed-deck-primitives";
import { createElement, lazy, Suspense } from "react";
import { type DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
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
import { osQuery } from "@/lib/os-query-options";
import { decisionFeedbackMetadata } from "@/lib/decision-deck";
import { DeckCardAgentContext } from "@/lib/deck-card-agent";
import { WorkApprovalDecisionCard } from "@/components/work-approval-decision-card";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { absoluteDate, absoluteTime } from "@/lib/time";
import { useDecisionDeck } from "./use-decision-deck";

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
	const {
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
	} = useDecisionDeck(config, workspaceId);
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
