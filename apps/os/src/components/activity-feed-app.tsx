import { DecisionProposalHeading } from "@/components/decision-proposal-body";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import {
	Fragment,
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
import {
	ProposerChip,
	FeedMomentHeader,
	RichPreview,
} from "@/components/feed-deck-primitives";
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

const copy = OS_COPY.feed;
type Filter = keyof typeof copy.filters;
export interface ActivityFeedNavigation {
	filter?: Filter;
	onFilterChange?: (filter: Filter) => void;
	decide?: ReactNode;
	apps?: ReactNode;
}

export function ActivityFeedApp({
	config,
	navigation,
}: {
	config: ActivityFeedConfig;
	navigation?: ActivityFeedNavigation;
}) {
	const cache = useQueryClient();
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
	const factories = config.factorySources.filter((f) =>
		visibleProjects.some((p) => p.id === f.projectId),
	);
	const sourceKeys = [
		...visibleProjects.map((p) => p.id),
		...factories.map(
			(f) => `factory-${f.source.workspaceId}-${f.source.label}`,
		),
	];
	const allItems = [
		...Object.entries(sources)
			.filter(([id]) => sourceKeys.includes(id))
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
	const selected = ranked.filter(
		(item) =>
			filter === "all" ||
			(filter === "attention"
				? item.needsAction
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
	const main = selected.filter(
		(item, i) =>
			item.needsAction ||
			item.importance === "critical" ||
			(!quiet &&
				i < config.attentionBudget &&
				(config.digestBelow === "low"
					? item.importance !== "low"
					: item.importance === "high")),
	);
	const mainIds = new Set(main.map((i) => i.id));
	const digest = selected.filter((i) => !mainIds.has(i.id));
	const states = sourceKeys.map((key) => sources[key]);
	const loading = preferences.isPending || states.some((s) => !s || s.loading);
	const failed =
		preferences.isError || corrections.isError || states.some((s) => s?.failed);
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
			project={config.projects.find((p) => p.id === item.projectId)?.label}
			config={navigation ? { ...config, deckUrl: "/work?view=deck" } : config}
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
			<header className="fd-feed-heading grid gap-2">
				<Text as="h2" role="section" weight="semibold">
					{OS_COPY.workHome.feed}
				</Text>
				<Text tone="secondary">{copy.subtitle}</Text>
				{navigation?.decide ??
					(config.deckUrl && (
						<Link href={config.deckUrl}>{OS_COPY.workHome.decide}</Link>
					))}
				<FeedNowStrip
					items={ranked}
					projectIds={visibleProjects.map((p) => p.id)}
					now={now}
					timezone={preferences.data?.preferences.timezone ?? undefined}
					pending={loading}
					failed={failed}
				/>
				{navigation?.apps}
			</header>
			<nav
				className="fd-feed-filters flex flex-wrap gap-1"
				aria-label={copy.title}
			>
				{(Object.keys(copy.filters) as Filter[]).map((id) => (
					<Button
						key={id}
						size="sm"
						variant={filter === id ? "secondary" : "ghost"}
						aria-pressed={filter === id}
						onClick={() => {
							setFilter(id);
							navigation?.onFilterChange?.(id);
						}}
					>
						{copy.filters[id]}
					</Button>
				))}
			</nav>
			<Select
				value={prefs.projectIds.length === 1 ? prefs.projectIds[0] : "all"}
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
							? (config.projects.find((p) => p.id === prefs.projectIds[0])
									?.label ?? copy.allProjects)
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
						<Text tone="secondary">{copy.digestHint}</Text>
					</div>
				)}
				{expandedDigest && digest.map(renderItem)}
			</div>
			{loading && <Text>{copy.loading}</Text>}
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
		</div>
	);
}

function FeedCard({
	item,
	project,
	config,
	busy,
	onReact,
	onWork,
	ignoredAfterMs,
}: {
	item: ReturnType<typeof rankFeed>[number];
	project?: string;
	config: ActivityFeedConfig;
	busy: boolean;
	ignoredAfterMs?: number;
	onReact: (
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore",
		text?: string,
	) => Promise<boolean>;
	onWork: (item: ActivityFeedItem) => Promise<void>;
}) {
	const article = useRef<HTMLElement>(null);
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
	return (
		<article
			ref={article}
			tabIndex={0}
			aria-label={item.sentence}
			className="fd-story min-w-0"
		>
			<div className="fd-story-body grid gap-4">
				<div className="flex flex-wrap items-center gap-2">
					<ProposerChip
						name={item.actor}
						detail={[project, copy.kinds[item.kind]]
							.filter(Boolean)
							.join(" · ")}
					/>
					<time
						dateTime={item.at}
						title={absoluteTime(item.at)}
						className="ml-auto"
					>
						<Text role="caption" tone="secondary">
							{relativeTime(item.at)}
						</Text>
					</time>
				</div>
				<Text as="h3" weight="medium" className="fd-story-title break-words">
					<DecisionProposalHeading title={item.sentence} />
				</Text>
				<div className="flex flex-wrap gap-2">
					{item.unseen && (
						<Text as="span" role="caption" className="fd-unseen">
							{copy.new}
						</Text>
					)}
					{item.deadline && (
						<Text as="span" role="caption">
							{copy.due}
						</Text>
					)}
				</div>
				<div className="grid gap-3">
					<RichPreview
						href={item.source}
						title={project ?? copy.kinds[item.kind]}
						summary={item.decision?.recommendation ?? copy.source}
					/>
					{item.needsAction && (
						<Link href={config.deckUrl ?? item.source}>{copy.deck}</Link>
					)}
				</div>
				<div className="fd-reactions flex flex-wrap gap-1">
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						className="fd-reaction"
						data-reacted={reacted}
						onClick={() =>
							void react("more").then((ok) => {
								if (ok) setReacted(true);
							})
						}
					>
						{copy.more}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={why}
						onClick={() => {
							setWhy((v) => !v);
							if (!why) void react("why");
						}}
					>
						{copy.why}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => void react("mute")}
					>
						{copy.mute}
					</Button>
					<Button
						size="sm"
						variant="ghost"
						aria-expanded={comment}
						onClick={() => setComment((v) => !v)}
					>
						{copy.comment}
					</Button>
					{item.projectId && (
						<Button
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => {
								engaged.current = true;
								void onWork(item);
							}}
						>
							{copy.work}
						</Button>
					)}
				</div>
				{why && (
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
				)}
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
