import {
	DecisionContextRail,
	DecisionContextSection,
	DecisionRailContext,
} from "@/components/decision-context-rail";
import {
	ThumbsUpIcon,
	QuestionIcon,
	ProhibitIcon,
	ChatCircleIcon,
	PlusIcon,
	DotsThreeIcon,
} from "@phosphor-icons/react";
import { FeedOutcomePreview } from "@/components/feed-outcome-preview";
import { WorkActorAvatar } from "@/components/work-actor-avatar";
import { Skeleton } from "@/components/kumo/skeleton";
import {
	PopoverRoot,
	PopoverTrigger,
	PopoverContent,
} from "@/components/kumo/popover";
import { useOsIdentity } from "@/lib/use-os-identity";
import { useTediNames } from "@/lib/use-tedi-names";
import { feedStoryActor, timelineItems } from "@/lib/feed-story";
import "./feed-timeline.css";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	Fragment,
	useContext,
	useCallback,
	useEffect,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import {
	ActivityFeedSources,
	type FeedSourceState,
} from "@/components/activity-feed-sources";
import { FeedMomentHeader } from "@/components/feed-deck-primitives";
import { feedMoment } from "@/lib/feed-moment";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { Textarea } from "@/components/kumo/textarea";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/kumo/select";
import { osApi } from "@/lib/api";
import { osQuery, userPreferencesQueryOptions } from "@/lib/os-query-options";
import {
	correctionFeedItems,
	EMPTY_FEED_PREFERENCES,
	feedLearningInput,
	rankFeed,
	quietNow,
	type FeedPreferences,
} from "@/lib/activity-feed";
import { absoluteTime, relativeTime } from "@/lib/time";
import { OS_COPY } from "@/shared/os-copy";
import { buildActivityFeedTools } from "@/components/activity-feed-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";
import { ActivityFeedFactorySource } from "@/components/activity-feed-factory-source";
import { FeedNowStrip } from "@/components/feed-now-strip";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import { useOsLocale } from "@/lib/use-os-locale";

type Filter = keyof typeof OS_COPY.feed.filters;
export interface ActivityFeedNavigation {
	filter?: Filter;
	onFilterChange?: (filter: Filter) => void;
	decide?: ReactNode;
	apps?: ReactNode;
}

export function ActivityFeedApp(props: {
	config: ActivityFeedConfig;
	navigation?: ActivityFeedNavigation;
}) {
	return (
		<DecisionContextRail>
			<ActivityFeedContent {...props} />
		</DecisionContextRail>
	);
}

function ActivityFeedContent({
	config,
	navigation,
}: {
	config: ActivityFeedConfig;
	navigation?: ActivityFeedNavigation;
}) {
	useOsLocale();
	const copy = OS_COPY.feed;
	const cache = useQueryClient();
	const identity = useOsIdentity();
	const tediNames = useTediNames();
	const [sessionLearningId, setSessionLearningId] = useState<string | null>(
		null,
	);
	const learningModel = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		refetchInterval: 60000,
	});
	const preferences = useQuery(userPreferencesQueryOptions());
	const prefs =
		preferences.data?.preferences.activityFeed ?? EMPTY_FEED_PREFERENCES;
	const corrections = useQuery(
		osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", eventKind: "edited", limit: 100 },
		}),
	);
	const [sources, setSources] = useState<Record<string, FeedSourceState>>({});
	const onUpdate = useCallback(
		(id: string, state: FeedSourceState) =>
			setSources((old) => ({ ...old, [id]: state })),
		[],
	);
	const [request, setRequest] = useState(0);
	const [localFilter, setFilter] = useState<Filter>("all");
	const filter = navigation?.filter ?? localFilter;
	const [expandedDigest, setExpandedDigest] = useState(false);
	const [now, setNow] = useState(() => new Date());
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const seenAt = useRef<string | null | undefined>(undefined);
	if (preferences.data && seenAt.current === undefined)
		seenAt.current = prefs.lastSeenAt;
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60_000);
		return () => clearInterval(id);
	}, []);
	const visibleProjects = config.projects.filter(
		(p) => !prefs.projectIds.length || prefs.projectIds.includes(p.id),
	);
	const visibleFactories = useVisibleCardSources(
		config.factorySources,
		(f) => f.source.workspaceId,
	);
	const factories = visibleFactories.sources.filter((f) =>
		visibleProjects.some((p) => p.id === f.projectId),
	);
	const sourceIds = [
		...(config.scope === "organization" ? ["organization"] : []),
		...visibleProjects.map((p) => p.id),
		...factories.map(
			(f) => `factory-${f.source.workspaceId}-${f.source.label}`,
		),
	];
	const allItems = [
		...Object.entries(sources)
			.filter(([id]) => sourceIds.includes(id))
			.flatMap(([, s]) => s.items),
		...correctionFeedItems(corrections.data?.events ?? []),
	];
	const ranked = rankFeed(
		allItems,
		config,
		{ ...prefs, lastSeenAt: seenAt.current ?? null },
		now,
		learningModel.data,
	);
	const selected = timelineItems(ranked).filter(
		(item) =>
			filter === "all" ||
			(filter === "attention"
				? item.needsAction || item.stalled
				: filter === "office"
					? item.kind === "decision"
					: filter === "history"
						? item.done
						: filter === "queue"
							? item.kind === "work" && !item.done
							: item.stalled),
	);
	const quiet = quietNow(
		config,
		Number(
			new Intl.DateTimeFormat("en", {
				hour: "numeric",
				hourCycle: "h23",
				timeZone: preferences.data?.preferences.timezone ?? undefined,
			}).format(now),
		),
	);
	const featured = new Set(
		[...selected]
			.sort((a, b) => b.score - a.score)
			.slice(0, config.attentionBudget)
			.map((item) => item.id),
	);
	const main = selected.filter(
		(item) =>
			item.needsAction ||
			item.importance === "critical" ||
			(!quiet &&
				featured.has(item.id) &&
				(config.digestBelow === "low"
					? item.importance !== "low"
					: item.importance === "high")),
	);
	const mainIds = new Set(main.map((i) => i.id));
	const digest = selected.filter((i) => !mainIds.has(i.id));
	const states = sourceIds.map((id) => sources[id]);
	const loading =
		visibleFactories.pending ||
		preferences.isPending ||
		states.some((s) => !s || s.loading);
	const failed =
		visibleFactories.failed ||
		preferences.isError ||
		corrections.isError ||
		states.some((s) => s?.failed);
	const more = states.some((s) => s?.more);
	const load = useCallback(() => setRequest((r) => r + 1), []);
	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (
			!sentinel.current ||
			loading ||
			!more ||
			typeof IntersectionObserver === "undefined"
		)
			return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) load();
			},
			{ rootMargin: "240px" },
		);
		observer.observe(sentinel.current);
		return () => observer.disconnect();
	}, [loading, more, load]);

	async function savePreferences(
		change: (previous: FeedPreferences) => FeedPreferences,
	) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const fresh = await osApi.userSettings.getPreferences({});
			try {
				const saved = await osApi.userSettings.updatePreferences({
					expectedRevision: fresh.revision,
					preferences: {
						...fresh.preferences,
						activityFeed: change(
							fresh.preferences.activityFeed ?? EMPTY_FEED_PREFERENCES,
						),
					},
				});
				cache.setQueryData(userPreferencesQueryOptions().queryKey, saved);
				return;
			} catch (error) {
				if (
					attempt ||
					!(
						error &&
						typeof error === "object" &&
						"code" in error &&
						error.code === "CONFLICT"
					)
				)
					throw error;
			}
		}
	}
	async function react(
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore",
		text = "",
	) {
		setBusy(true);
		setStatus("");
		try {
			const result = await osApi.learningFeedback.recordInteraction(
				feedLearningInput(item, reaction, text, crypto.randomUUID()),
			);
			if (
				(reaction === "more" ||
					reaction === "mute" ||
					reaction === "comment") &&
				!result.duplicate &&
				result.event?.id
			)
				setSessionLearningId(result.event.id);
			if (
				!learningModel.data?.config.enabled &&
				(reaction === "more" || reaction === "mute")
			)
				await savePreferences((p) => ({
					...p,
					mutedClasses:
						reaction === "mute"
							? [...new Set([...p.mutedClasses, item.classId])].slice(-100)
							: p.mutedClasses.filter((c) => c !== item.classId),
					preferredClasses:
						reaction === "more"
							? [...new Set([...p.preferredClasses, item.classId])].slice(-100)
							: p.preferredClasses.filter((c) => c !== item.classId),
				}));
			await cache.invalidateQueries({
				queryKey: osQuery.learningFeedback.key(),
			});
			setStatus(reaction === "comment" ? copy.correctionSaved : copy.saved);
			return true;
		} catch {
			setStatus(copy.failed);
			return false;
		} finally {
			setBusy(false);
		}
	}
	async function turnIntoWork(item: ActivityFeedItem) {
		if (!item.projectId) return;
		setBusy(true);
		try {
			const work = await osApi.workItems.create({
				title: item.sentence.slice(0, 500),
				description: `${item.sentence}\n\nSource: ${item.source}\nFeed record: ${item.id}`,
				projectId: item.projectId,
				workKind: "other",
			});
			const signal = feedLearningInput(item, "work", "", crypto.randomUUID());
			await osApi.learningFeedback
				.recordInteraction({
					...signal,
					metadata: { ...signal.metadata, createdWorkItemId: work.id },
				})
				.then((result) => {
					if (!result.duplicate && result.event?.id)
						setSessionLearningId(result.event.id);
				})
				.catch(() => undefined);
			await cache.invalidateQueries({
				queryKey: osQuery.learningFeedback.key(),
			});
			setStatus(`${copy.workCreated}: ${work.title}`);
			await cache.invalidateQueries({ queryKey: osQuery.workItems.key() });
		} catch {
			setStatus(copy.failed);
		} finally {
			setBusy(false);
		}
	}
	useAppWebMcpTools(
		"activity_feed",
		{ items: expandedDigest ? selected : main, busy, react },
		buildActivityFeedTools,
		[],
	);
	const renderItem = (item: (typeof ranked)[number]) => (
		<FeedCard
			key={item.id}
			item={item}
			actor={feedStoryActor(item, tediNames)}
			project={config.projects.find((p) => p.id === item.projectId)?.label}
			busy={busy}
			ignoredAfterMs={
				learningModel.data?.config.enabled
					? learningModel.data.config.ignoredAfterMs
					: undefined
			}
			onReact={react}
			onWork={turnIntoWork}
		/>
	);
	return (
		<div
			className="feed-deck fd-feed mx-auto grid w-full max-w-3xl min-w-0 gap-4 pb-8"
			data-workspace-app-entry="activity-feed"
		>
			<DecisionLearningFeedback eventId={sessionLearningId} />
			{config.scope === "organization" && (
				<ActivityFeedSources
					pageSize={config.pageSize}
					request={request}
					onUpdate={onUpdate}
				/>
			)}
			{visibleProjects.map((p) => (
				<ActivityFeedSources
					key={p.id}
					projectId={p.id}
					pageSize={config.pageSize}
					request={request}
					onUpdate={onUpdate}
				/>
			))}
			{factories.map((binding) => (
				<ActivityFeedFactorySource
					key={`${binding.source.workspaceId}-${binding.source.label}`}
					sourceKey={`factory-${binding.source.workspaceId}-${binding.source.label}`}
					binding={binding}
					onUpdate={onUpdate}
				/>
			))}
			<DecisionContextSection title="Feed filters and context">
				{" "}
				<header className="ft-header">
					<div className="ft-greeting">
						<Text as="h2" weight="medium">
							{copy.greeting(
								Number(
									new Intl.DateTimeFormat("en", {
										hour: "numeric",
										hourCycle: "h23",
										timeZone:
											preferences.data?.preferences.timezone ?? undefined,
									}).format(now),
								),
								identity.name.split(" ")[0]!,
							)}
						</Text>
					</div>
					<div className="ft-tools">
						<Select
							value={filter}
							onValueChange={(id) => {
								if (id) {
									setFilter(id as Filter);
									navigation?.onFilterChange?.(id as Filter);
								}
							}}
						>
							<SelectTrigger aria-label={copy.title}>
								<SelectValue>{copy.filters[filter]}</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{(["all", "attention", "history"] as const).map((id) => (
									<SelectItem key={id} value={id}>
										{copy.filters[id]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<PopoverRoot>
							<PopoverTrigger
								aria-label={copy.options}
								render={
									<Button
										variant="ghost"
										size="icon"
										aria-label={copy.options}
									/>
								}
							>
								<DotsThreeIcon size={22} />
							</PopoverTrigger>
							<PopoverContent align="end">
								<div className="ft-options-body">
									<Select
										value={
											prefs.projectIds.length === 1
												? prefs.projectIds[0]
												: "all"
										}
										onValueChange={(id) => {
											setBusy(true);
											void savePreferences((p) => ({
												...p,
												projectIds: id && id !== "all" ? [id] : [],
											}))
												.catch(() => setStatus(copy.failed))
												.finally(() => setBusy(false));
										}}
									>
										<SelectTrigger
											aria-label={copy.project}
											disabled={busy || !preferences.data}
										>
											<SelectValue>
												{prefs.projectIds.length === 1
													? (config.projects.find(
															(p) => p.id === prefs.projectIds[0],
														)?.label ?? copy.allProjects)
													: copy.allProjects}
											</SelectValue>
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="all">{copy.allProjects}</SelectItem>
											{config.projects.map((p) => (
												<SelectItem key={p.id} value={p.id}>
													{p.label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									{navigation?.apps}
									<FeedNowStrip
										items={ranked}
										now={now}
										timezone={
											preferences.data?.preferences.timezone ?? undefined
										}
									/>
								</div>
							</PopoverContent>
						</PopoverRoot>
					</div>
				</header>
			</DecisionContextSection>
			{quiet && <Text tone="secondary">{copy.quiet}</Text>}
			{failed && (
				<div role="alert">
					<Text>{copy.partial}</Text>
					<Button
						variant="outline"
						onClick={() => {
							load();
							void corrections.refetch();
							void preferences.refetch();
						}}
					>
						{copy.retry}
					</Button>
				</div>
			)}
			{status && <Text aria-live="polite">{status}</Text>}
			<div
				role="feed"
				aria-label={copy.title}
				aria-busy={loading}
				className="fd-timeline"
			>
				{main.map((item, i) => {
					const label = feedMoment(
						item.at,
						now,
						preferences.data?.preferences.timezone,
					);
					return (
						<Fragment key={item.id}>
							{(i === 0 ||
								label !==
									feedMoment(
										main[i - 1]!.at,
										now,
										preferences.data?.preferences.timezone,
									)) && <FeedMomentHeader>{label}</FeedMomentHeader>}
							{renderItem(item)}
						</Fragment>
					);
				})}
				{digest.length > 0 && (
					<div className="fd-quiet-updates">
						<Button
							variant="ghost"
							aria-expanded={expandedDigest}
							onClick={() => setExpandedDigest((v) => !v)}
						>
							{copy.digest(digest.length)}
						</Button>
					</div>
				)}
				{expandedDigest && digest.map(renderItem)}
			</div>
			{loading && selected.length === 0 && (
				<div role="status" aria-label={copy.loading} className="ft-loading">
					<Skeleton className="h-10 w-10 rounded-full" />
					<div className="grid flex-1 gap-3">
						<Skeleton className="h-3 w-40" />
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-2/3" />
					</div>
				</div>
			)}
			{!loading && selected.length === 0 && !failed && (
				<Text>{copy.empty}</Text>
			)}
			<div ref={sentinel}>
				{more && (
					<Button variant="outline" disabled={loading} onClick={load}>
						{copy.loadMore}
					</Button>
				)}
			</div>
			{!more && !loading && !failed && selected.length > 0 && (
				<Text tone="secondary">{copy.end}</Text>
			)}
			<DecisionContextSection title="Feed preferences">
				{" "}
				<div className="flex flex-wrap gap-2">
					<Button
						variant="ghost"
						disabled={busy || !preferences.data}
						onClick={() => {
							setBusy(true);
							const at = now.toISOString();
							void savePreferences((p) => ({ ...p, lastSeenAt: at }))
								.then(() => {
									seenAt.current = at;
									setNow(new Date());
								})
								.catch(() => setStatus(copy.failed))
								.finally(() => setBusy(false));
						}}
					>
						{copy.markSeen}
					</Button>
					<Button
						variant="ghost"
						disabled={busy || !preferences.data}
						onClick={() => {
							setBusy(true);
							void savePreferences(() => EMPTY_FEED_PREFERENCES)
								.catch(() => setStatus(copy.failed))
								.finally(() => setBusy(false));
						}}
					>
						{copy.reset}
					</Button>
				</div>
			</DecisionContextSection>
		</div>
	);
}

function FeedCard({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
	ignoredAfterMs,
}: {
	item: ReturnType<typeof rankFeed>[number];
	actor: string;
	project?: string;
	busy: boolean;
	ignoredAfterMs?: number;
	onReact: (
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore",
		text?: string,
	) => Promise<boolean>;
	onWork: (item: ActivityFeedItem) => Promise<void>;
}) {
	const copy = OS_COPY.feed;
	const article = useRef<HTMLElement>(null);
	const rail = useContext(DecisionRailContext);
	const whySection = `feed-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
	const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const held = useRef(false);
	const [reactionsOpen, setReactionsOpen] = useState(false);
	const cancelHold = () => clearTimeout(hold.current);
	useEffect(() => cancelHold, []);
	const engaged = useRef(false);
	const currentReact = useRef(onReact);
	currentReact.current = onReact;
	useEffect(() => {
		if (
			!ignoredAfterMs ||
			!article.current ||
			typeof IntersectionObserver === "undefined"
		)
			return;
		let entered = 0;
		let recorded = false;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting) entered = Date.now();
				else if (
					entered &&
					Date.now() - entered >= ignoredAfterMs &&
					!engaged.current &&
					!recorded
				) {
					recorded = true;
					void currentReact.current(item, "ignore");
				}
			},
			{ threshold: 0.5 },
		);
		observer.observe(article.current);
		return () => observer.disconnect();
	}, [item.id, ignoredAfterMs]);
	const react = (
		reaction: "more" | "mute" | "comment" | "why",
		text?: string,
	) => {
		engaged.current = true;
		return onReact(item, reaction, text);
	};
	const [why, setWhy] = useState(false);
	const [comment, setComment] = useState(false);
	const [text, setText] = useState("");
	const [reacted, setReacted] = useState(false);
	const explanation = (
		<div className="grid gap-2 border-t pt-3">
			<Text>{item.explanation}</Text>
			{item.decision && (
				<>
					<Text>{item.decision.whyNow}</Text>
					<Text weight="medium">{copy.recommendation}</Text>
					<Text>{item.decision.recommendation}</Text>
					<Text weight="medium">{copy.waiting}</Text>
					<Text>{item.decision.costOfWaiting}</Text>
					{item.decision.lessons.length > 0 && (
						<Text weight="medium">{copy.lessons}</Text>
					)}
					{item.decision.lessons.map((lesson) => (
						<Text key={lesson.id} title={lesson.id}>
							{lesson.text}
						</Text>
					))}
				</>
			)}
			<Text tone="secondary">{copy.whyRank}</Text>
		</div>
	);

	return (
		<article
			ref={article}
			aria-label={item.sentence}
			className="fd-story min-w-0"
			data-reactions-open={reactionsOpen}
			onPointerDown={(event) => {
				if (event.pointerType === "mouse") return;
				held.current = false;
				cancelHold();
				hold.current = setTimeout(() => {
					held.current = true;
					setReactionsOpen(true);
					engaged.current = true;
				}, 450);
			}}
			onPointerUp={cancelHold}
			onPointerCancel={cancelHold}
			onPointerMove={cancelHold}
			onClickCapture={(event) => {
				if (
					held.current &&
					event.target instanceof Element &&
					event.target.closest(".ft-post-link")
				) {
					event.preventDefault();
					held.current = false;
				}
			}}
		>
			<WorkActorAvatar
				actor={
					item.actorIdentity ??
					(item.tediId ? { type: "tedi", id: item.tediId } : undefined)
				}
				name={actor}
				className="ft-avatar"
				detail={`${actor}${item.actorIdentity?.harness ? " session" : ""}${project ? ` · ${project}` : ""}`}
			/>
			<div className="fd-story-body grid gap-3">
				<div
					className="ft-byline"
					title={`${actor}${item.actorIdentity?.harness ? " session" : ""}${project ? ` · ${project}` : ""}`}
				>
					<Text weight="semibold">{project ?? actor}</Text>
					<time dateTime={item.at} title={absoluteTime(item.at)}>
						· {relativeTime(item.at)}
					</time>
				</div>
				<Link
					href={item.source}
					className="ft-post-link"
					aria-label={`Open ${item.attachment?.title ?? item.sentence}`}
				>
					<Text className="ft-sentence">{item.sentence}</Text>
				</Link>
				<FeedOutcomePreview item={item} />
				<div className="fd-reactions ft-reactions flex flex-wrap gap-1">
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						className="fd-reaction"
						aria-label={copy.more}
						title={copy.more}
						data-reacted={reacted}
						onClick={() =>
							void react("more").then((ok) => {
								if (ok) setReacted(true);
							})
						}
					>
						<ThumbsUpIcon size={18} aria-hidden="true" />
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-label={copy.why}
						title={copy.why}
						aria-expanded={why}
						onClick={() => {
							if (rail) rail.openSection(whySection);
							else setWhy((v) => !v);
							if (!why) void react("why");
						}}
					>
						<QuestionIcon size={18} aria-hidden="true" />
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						aria-label={copy.mute}
						title={copy.mute}
						onClick={() => void react("mute")}
					>
						<ProhibitIcon size={18} aria-hidden="true" />
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-label={copy.comment}
						title={copy.comment}
						aria-expanded={comment}
						onClick={() => setComment((v) => !v)}
					>
						<ChatCircleIcon size={18} aria-hidden="true" />
					</Button>
					{item.projectId && (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							aria-label={copy.work}
							title={copy.work}
							onClick={() => {
								engaged.current = true;
								void onWork(item);
							}}
						>
							<PlusIcon size={18} aria-hidden="true" />
						</Button>
					)}
				</div>
				{rail
					? rail.activeSection === whySection && (
							<DecisionContextSection
								title="Why this post?"
								sectionId={whySection}
							>
								{explanation}
							</DecisionContextSection>
						)
					: why && explanation}
				{comment && (
					<div className="grid gap-2">
						<Textarea
							aria-label={copy.correction}
							placeholder={copy.correction}
							value={text}
							maxLength={4000}
							onChange={(e) => setText(e.target.value)}
						/>
						<Text role="caption" tone="secondary">
							{copy.learningHint}
						</Text>
						<div className="flex gap-2">
							<Button
								disabled={busy || !text.trim()}
								onClick={() =>
									void react("comment", text.trim()).then((ok) => {
										if (ok) {
											setText("");
											setComment(false);
										}
									})
								}
							>
								{copy.save}
							</Button>
							<Button variant="ghost" onClick={() => setComment(false)}>
								{copy.cancel}
							</Button>
						</div>
					</div>
				)}
			</div>
		</article>
	);
}
