import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import { OS_COPY, decisionText } from "@/shared/os-copy";
import { FACE_WAIT_MS } from "@/components/deck-presentation-context";
import { Loader } from "./kumo/loader";
import { Skeleton } from "./kumo/skeleton";
import { workRefreshOptions } from "@/lib/work-refresh";
import { WorkReadNotice } from "@/components/work-read-region";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, EyeSlash, PushPin, ThumbsDown } from "@phosphor-icons/react";
import type {
	ActivityFeedConfig,
	ActivityFeedItem,
} from "@tedix/api-contract/schemas/os-activity-feed";
import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import type { LearningInteractionEvent } from "@tedix/api-contract/schemas/learning-feedback";
import type { ActivityFeedNavigation } from "./activity-feed-app";
import {
	ActivityFeedSources,
	type FeedSourceState,
} from "./activity-feed-sources";
import { ActivityFeedFactorySource } from "./activity-feed-factory-source";
import { TodayPost } from "./today-post";
import { FeedCard } from "./focus-feed-card";
import {
	DecisionContextSection,
	DecisionContextToolbar,
} from "./decision-context-rail";
import { Button } from "./kumo/button";
import { FocusRowActions } from "./focus-row-actions";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { Link } from "./kumo/link";
import { Text } from "./kumo/text";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./kumo/collapsible";
import {
	decisionCardFaceText,
	decisionCardFallbackTitle,
} from "@tedix/api-contract/utils/decision-card-copy";
import { SegmentedControl } from "./kumo/segmented-control";
import { osApi } from "@/lib/api";
import { osQuery, userPreferencesQueryOptions } from "@/lib/os-query-options";
import {
	approvalFeedItems,
	correctionFeedItems,
	decisionFeedItems,
	EMPTY_FEED_PREFERENCES,
	feedLearningInput,
} from "@tedix/api-contract/utils/activity-feed";
import {
	everythingFeed,
	FOCUS_HISTORY_SURFACES,
	focusDay,
	focusSelection,
	focusSignalInput,
	rankFocusFeed,
	type FocusItem,
	type FocusSignal,
} from "@tedix/api-contract/utils/focus-feed";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { useVisibleCardSources } from "@/lib/use-visible-card-sources";
import { useTediNames } from "@/lib/use-tedi-names";
import {
	feedStoryActor,
	timelineItems,
} from "@tedix/api-contract/utils/feed-story";
import { buildActivityFeedTools } from "./activity-feed-webmcp-tools";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";

export function useFocusFeedShortcuts(root: RefObject<HTMLDivElement | null>) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => {
			const owner = root.current;
			const target = e.target;
			if (
				e.defaultPrevented ||
				e.isComposing ||
				e.altKey ||
				e.ctrlKey ||
				e.metaKey ||
				e.shiftKey ||
				!owner ||
				!(target instanceof HTMLElement) ||
				!owner.contains(target) ||
				target !== document.activeElement ||
				target.isContentEditable ||
				target.closest(
					"[role=dialog],[role=alertdialog],[role=menu],[role=listbox],dialog[open],[contenteditable]:not([contenteditable=false])",
				) ||
				(target !== owner && !target.matches("[data-focus-row]"))
			)
				return;
			const rows = [...owner.querySelectorAll<HTMLElement>("[data-focus-row]")];
			if (!rows.length) return;
			let index = rows.indexOf(target);
			if (e.key === "j" || e.key === "k") {
				e.preventDefault();
				index = Math.max(
					0,
					Math.min(rows.length - 1, index + (e.key === "j" ? 1 : -1)),
				);
				rows[index]?.focus();
				rows[index]?.scrollIntoView?.({
					block: "nearest",
					behavior: "instant",
				});
				return;
			}
			if (index < 0 || e.repeat) return;
			const row = rows[index];
			if (e.key === "o") {
				e.preventDefault();
				row?.querySelector<HTMLAnchorElement>("a")?.click();
			}
			const action = (
				{ p: "Pin", h: "Hide", n: "Not important" } as Record<string, string>
			)[e.key];
			if (action) {
				e.preventDefault();
				row
					?.querySelector<HTMLButtonElement>(`button[aria-label="${action}"]`)
					?.click();
			}
		};
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, [root]);
}

export function FocusFeed({
	config,
	navigation,
}: {
	config: ActivityFeedConfig;
	navigation?: ActivityFeedNavigation;
}) {
	const cache = useQueryClient();
	const names = useTediNames();
	const [tab, setTab] = useState<"for_you" | "everything">(
		navigation?.day ? "everything" : "for_you",
	);
	const filter = navigation?.filter ?? "all";
	const filtered = filter !== "all";
	const timeline = filtered || tab === "everything";
	const filterLabel =
		filter === "history"
			? "Finished work"
			: filter === "stalled"
				? "Stalled work"
				: OS_COPY.feed.filters[filter];
	const emptyMessage =
		filter === "history"
			? "No finished work matches these filters."
			: filter === "stalled"
				? "No stalled work matches these filters."
				: "No updates match these filters.";
	const [sources, setSources] = useState<Record<string, FeedSourceState>>({});
	const [request, setRequest] = useState(0);
	const [now, setNow] = useState(() => new Date());
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const [handledOpen, setHandledOpen] = useState(false);
	const [heldOpen, setHeldOpen] = useState(false);
	const [localEvents, setLocalEvents] = useState<LearningInteractionEvent[]>(
		[],
	);
	const [session] = useState(() => ({
		id: crypto.randomUUID(),
		openedAt: Date.now(),
	}));
	const model = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		...workRefreshOptions,
	});
	const preferences = useQuery({
		...userPreferencesQueryOptions(),
		...workRefreshOptions,
	});
	const history = useQuery({
		...osQuery.learningFeedback.listInteractions.queryOptions({
			input: {
				scopeKind: "personal",
				limit: 200,
				surfaces: FOCUS_HISTORY_SURFACES,
			},
		}),
		...workRefreshOptions,
	});
	const prefs =
		preferences.data?.preferences.activityFeed ?? EMPTY_FEED_PREFERENCES;
	const events = useMemo(
		() => [
			...new Map(
				[...(history.data?.events ?? []), ...localEvents].map((e) => [e.id, e]),
			).values(),
		],
		[history.data, localEvents],
	);
	const decisions = useDecisionInbox(
		DecisionDeckConfigSchema.parse({
			version: 1,
			projectId: navigation?.projectId,
		}),
		"all",
	);
	const factories = useVisibleCardSources(
		config.factorySources,
		(f) => f.source.workspaceId,
	);
	const onUpdate = useCallback(
		(id: string, state: FeedSourceState) =>
			setSources((old) => ({ ...old, [id]: state })),
		[],
	);
	useEffect(() => {
		const id = setInterval(() => setNow(new Date()), 60000);
		return () => clearInterval(id);
	}, []);
	const projects = config.projects.filter(
		(p) => !navigation?.projectId || p.id === navigation.projectId,
	);
	const sourceIds = [
		...(config.today ? ["today-receipts"] : []),
		...(config.scope === "organization"
			? [navigation?.projectId ?? "organization"]
			: []),
		...projects.map((p) => p.id),
		...factories.sources.map(
			(f) => `factory-${f.source.workspaceId}-${f.source.label}`,
		),
	];
	const items: ActivityFeedItem[] = [
		...Object.entries(sources)
			.filter(([id]) => sourceIds.includes(id))
			.flatMap(([, s]) => s.items),
		...correctionFeedItems(events, OS_COPY.feed),
		...decisionFeedItems(decisions.requests, now),
		...approvalFeedItems(decisions.work, now).map((item) => ({
			...item,
			id: item.id.replace(/^approval:/, "work-approval:"),
		})),
		...(decisions.approvals?.data?.data ?? []).map(
			(approval): ActivityFeedItem => ({
				id: `approval:${approval.id}`,
				actor: "Tedix",
				sentence: approval.review.operatorQuestion || approval.description,
				source: `/work?view=deck#card=approval:${approval.id}`,
				projectId: null,
				workItemId: null,
				tediId: approval.tediId,
				kind: "approval",
				classId: `approval:${approval.actionType}`.slice(0, 100),
				importance: "high",
				at: approval.createdAt,
				dueAt: approval.expiresAt,
				needsAction: true,
				stalled: false,
				done: false,
				explanation: approval.description,
				reactions: [],
			}),
		),
	];
	const all = everythingFeed(
		items.filter(
			(i) => !navigation?.projectId || i.projectId === navigation.projectId,
		),
		config,
	);
	const chronological = all.filter((item) => {
		if (
			navigation?.day &&
			focusDay(
				item.at,
				config.today?.timeZone ?? model.data?.config.timezone ?? "UTC",
			) !== navigation.day
		)
			return false;
		switch (filter) {
			case "history":
				return item.done;
			case "stalled":
				return item.stalled;
			case "attention":
				return item.needsAction && !item.done;
			case "office":
				return item.kind === "decision" || item.kind === "correction";
			case "queue":
				return !item.done && !item.stalled && !item.needsAction;
			default:
				return true;
		}
	});
	const rankable = all.filter(
		(item) =>
			item.kind !== "work" ||
			item.classId !== "work:work.completed" ||
			!item.done ||
			!all.some(
				(receipt) =>
					receipt.kind === "result" &&
					receipt.done &&
					receipt.workItemId === item.workItemId,
			),
	);
	const ranked = rankFocusFeed(
		rankable,
		config,
		prefs,
		now,
		model.data,
		events,
	);
	const selection = focusSelection(
		ranked,
		events,
		now,
		model.data,
		!!config.today,
		prefs,
	);
	const budgetReady = selection.selected.every(
		(i) =>
			i.importance === "critical" ||
			(prefs.budgetDay === selection.day && prefs.shownIds?.includes(i.id)),
	);
	// A repeated status message isn't a second outcome. Everything keeps every canonical record.
	const outcomes = new Set(timelineItems(ranked).map((i) => i.id));
	const needs = selection.needs.filter(
		(i) => i.importance === "critical" || budgetReady,
	);
	const updates = selection.updates.filter(
		(i) => (i.importance === "critical" || budgetReady) && outcomes.has(i.id),
	);
	const selectedIds = new Set([...needs, ...updates].map((i) => i.id));
	const held = ranked.filter((i) => !selectedIds.has(i.id));
	const handled = held.filter((i) => i.done);
	const waiting = held.filter((i) => !i.done);
	const states = sourceIds.map((id) => sources[id]);
	const loading =
		factories.pending ||
		states.some((s) => !s || s.loading) ||
		preferences.isPending ||
		history.isPending ||
		model.isPending ||
		decisions.queuePending;
	const failed =
		factories.failed ||
		states.some((s) => s?.failed) ||
		preferences.isError ||
		preferences.failureCount > 0 ||
		history.isError ||
		history.failureCount > 0 ||
		model.isError ||
		model.failureCount > 0 ||
		decisions.queueFailed;
	const more = states.some((s) => s?.more) || decisions.more;
	const visible = timeline
		? chronological.map((i) => ({
				...i,
				score: 0,
				unseen: false,
				deadline: false,
				factors: {},
			}))
		: [
				...needs,
				...updates,
				...(heldOpen ? waiting : []),
				...(handledOpen ? handled : []),
			];
	const root = useRef<HTMLDivElement>(null);
	const counters = useRef(new Set<string>());
	async function saveFeed(change: (p: typeof prefs) => typeof prefs) {
		for (let attempt = 0; attempt < 3; attempt++) {
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
				return saved.preferences.activityFeed!;
			} catch (error) {
				if (
					attempt === 2 ||
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
		throw new Error("Feed preferences changed");
	}
	const budgetSignature = selection.selected.map((i) => i.id).join("|");
	useEffect(() => {
		if (loading || failed || budgetReady || timeline) return;
		let active = true;
		void saveFeed((p) => {
			const chosen = focusSelection(
				ranked,
				events,
				now,
				model.data,
				!!config.today,
				p,
			);
			return {
				...p,
				budgetDay: chosen.day,
				shownIds: [
					...new Set([
						...(p.budgetDay === chosen.day ? (p.shownIds ?? []) : []),
						...chosen.selected
							.filter((i) => i.importance !== "critical")
							.map((i) => i.id),
					]),
				],
			};
		}).catch(() => {
			if (active) setStatus("Could not save your attention budget. Try again.");
		});
		return () => {
			active = false;
		};
	}, [loading, failed, budgetReady, budgetSignature, timeline, selection.day]);
	const signal = useCallback(
		async (
			item: ActivityFeedItem,
			reaction: FocusSignal,
			extra: Record<string, string | number | boolean | null> = {},
		) => {
			const impressionKey = `impression:${item.id}`;
			if (reaction === "impression" && counters.current.has(impressionKey))
				return true;
			if (reaction === "impression") counters.current.add(impressionKey);
			try {
				if (["pin", "hide", "not_important"].includes(reaction))
					await saveFeed((p) => ({
						...p,
						mutedClasses:
							reaction === "pin"
								? p.mutedClasses.filter((id) => id !== item.classId)
								: p.mutedClasses,
						hiddenIds: [
							...new Set(
								reaction === "pin"
									? (p.hiddenIds ?? []).filter((id) => id !== item.id)
									: [...(p.hiddenIds ?? []), item.id],
							),
						],
						pinnedIds: [
							...new Set(
								reaction === "pin"
									? [...(p.pinnedIds ?? []), item.id]
									: (p.pinnedIds ?? []).filter((id) => id !== item.id),
							),
						],
					}));
				const result = await osApi.learningFeedback.recordInteraction(
					focusSignalInput(item, reaction, {
						sessionId: session.id,
						openedAt: session.openedAt,
						feedView: timeline ? "everything" : tab,
						...(filtered ? { feedFilter: filter } : {}),
						...extra,
					}),
				);
				if (result.event) setLocalEvents((old) => [...old, result.event!]);
				if (
					["pin", "hide", "not_important", "tell_me_earlier"].includes(reaction)
				) {
					setStatus("Saved. Your feed will learn from this.");
					void cache.invalidateQueries({
						queryKey: osQuery.learningFeedback.model.key(),
					});
				}
				return true;
			} catch {
				if (reaction === "impression") counters.current.delete(impressionKey);
				setStatus("Could not save this signal. Try again.");
				return false;
			}
		},
		[session, cache, tab, timeline, filtered, filter],
	);
	const candidates = held.map((i) => ({
		id: i.id,
		score: i.score,
		factors: i.factors,
		source: i.source,
		at: i.at,
		actor: i.actor,
		projectId: i.projectId,
		classId: i.classId,
		sentence: i.sentence,
		needsAction: i.needsAction,
		attachment: i.attachment ?? null,
		because: i.because ?? null,
		reason: i.done ? "batched" : "ranked_lower",
	}));
	const counterfactual = JSON.stringify(candidates);
	const inventory = JSON.stringify({
		selected: [...selectedIds],
		held: held.map((i) => i.id),
		policy: model.data?.config.focusFeed,
	});
	useEffect(() => {
		if (timeline || loading || failed || !budgetReady || !held.length) return;
		const key = `held:${inventory}`;
		if (counters.current.has(key)) return;
		counters.current.add(key);

		void Promise.all(
			Array.from({ length: Math.ceil(candidates.length / 25) }, (_, batch) =>
				osApi.learningFeedback.recordInteraction({
					clientEventId: crypto.randomUUID(),
					scope: { kind: "personal" },
					surface: "focus_feed_counterfactual",
					eventKind: "delivered",
					targetType: "feed_ranking",
					targetId: session.id,
					metadata: {
						sessionId: session.id,
						policyVersion: 1,
						modelAsOf: model.data?.asOf ?? null,
						policy: model.data?.config.focusFeed ?? null,
						selected: [...selectedIds],
						batch,
						candidates: candidates.slice(batch * 25, (batch + 1) * 25),
						candidateCount: candidates.length,
						candidateSetComplete: !more,
						evidenceSource: "browser_report",
					},
				}),
			),
		).catch(() => {
			counters.current.delete(key);
			setStatus("Could not save the held-item record. Try again.");
		});
	}, [
		timeline,
		loading,
		failed,
		counterfactual,
		inventory,
		session,
		model.data,
		more,
	]);
	async function react(
		item: ActivityFeedItem,
		reaction: "more" | "mute" | "comment" | "why" | "ignore" | "ask",
		text = "",
	) {
		if (reaction === "ask") {
			if (!item.workItemId || !item.autonomyFeedback) return false;
			try {
				await osApi.workItems.recordDelegationAutonomyFeedback({
					id: item.workItemId,
					eventId: item.autonomyFeedback.eventId,
				});
				setStatus("Lesson saved. This class of delegation will ask next time.");
				return true;
			} catch {
				setStatus("Could not save your correction.");
				return false;
			}
		}
		if (reaction !== "comment")
			return signal(
				item,
				reaction === "more"
					? "pin"
					: reaction === "mute"
						? "not_important"
						: reaction === "why"
							? "expand_receipt"
							: "ignored_twice",
			);
		try {
			await osApi.learningFeedback.recordInteraction(
				feedLearningInput(item, reaction, text, crypto.randomUUID()),
			);
			setStatus("Correction saved.");
			return true;
		} catch {
			setStatus("Could not save your correction.");
			return false;
		}
	}
	async function work(item: ActivityFeedItem) {
		if (!item.projectId) return;
		setBusy(true);
		try {
			await osApi.workItems.create({
				title: item.sentence.slice(0, 500),
				description: `${item.sentence}\n\nSource: ${item.source}`,
				projectId: item.projectId,
				workKind: "other",
			});
			setStatus("Work created.");
			void cache.invalidateQueries({ queryKey: osQuery.workItems.key() });
		} catch {
			setStatus("Could not create Work.");
		} finally {
			setBusy(false);
		}
	}
	useAppWebMcpTools(
		"activity_feed",
		{ items: visible, busy, react },
		buildActivityFeedTools,
		[],
	);
	useFocusFeedShortcuts(root);
	const render = (item: FocusItem, budgeted = false) => (
		<FocusRow
			key={item.id}
			item={item}
			actor={feedStoryActor(item, names)}
			project={config.projects.find((p) => p.id === item.projectId)?.label}
			busy={busy}
			onReact={react}
			onWork={work}
			signal={signal}
			budgeted={budgeted && item.importance !== "critical"}
			session={session}
			events={events}
			enabled={!loading}
			ignoredAfterMs={model.data?.config.ignoredAfterMs ?? 5000}
		/>
	);
	return (
		<div
			ref={root}
			tabIndex={0}
			className="feed-deck fd-feed focus-feed mx-auto w-full min-w-0 max-w-3xl pb-8"
			data-workspace-app-entry="activity-feed"
		>
			{config.scope === "organization" && (
				<ActivityFeedSources
					projectId={navigation?.projectId}
					pageSize={config.pageSize}
					request={request}
					onUpdate={onUpdate}
				/>
			)}
			{projects.map((p) => (
				<ActivityFeedSources
					key={p.id}
					projectId={p.id}
					pageSize={config.pageSize}
					request={request}
					onUpdate={onUpdate}
				/>
			))}
			{factories.sources.map((f) => (
				<ActivityFeedFactorySource
					key={`${f.source.workspaceId}-${f.source.label}`}
					sourceKey={`factory-${f.source.workspaceId}-${f.source.label}`}
					binding={f}
					onUpdate={onUpdate}
				/>
			))}
			<DecisionContextToolbar />
			{filtered ? (
				<div className="focus-filter-heading">
					<h2>{filterLabel}</h2>
					{navigation?.onFilterChange ? (
						<Button
							variant="ghost"
							onClick={() => {
								setTab("for_you");
								navigation.onFilterChange?.("all");
							}}
						>
							Show For you
						</Button>
					) : (
						<Link href="/work?view=feed">Show For you</Link>
					)}
				</div>
			) : (
				<div className="grid gap-2">
					<SegmentedControl
						ariaLabel="Feed order"
						value={tab}
						onValueChange={setTab}
						options={[
							{ value: "for_you", label: "For you" },
							{ value: "everything", label: "Everything" },
						]}
					/>
					<p className="focus-budget">
						Worth your time today: {selection.selected.length} · handled without
						you: {handled.length}
					</p>
				</div>
			)}
			{status && <p role="status">{status}</p>}
			<WorkReadNotice
				failed={failed}
				partial={items.length > 0}
				errors={[
					preferences.error ?? preferences.failureReason,
					history.error ?? history.failureReason,
					model.error ?? model.failureReason,
					decisions.inbox.error ?? decisions.inbox.failureReason,
				]}
				retrying={
					preferences.isFetching ||
					history.isFetching ||
					model.isFetching ||
					decisions.inbox.isFetching
				}
				retry={() =>
					cache.refetchQueries({
						type: "active",
						predicate: (query) => query.state.status === "error",
					})
				}
			/>
			{!timeline && needs.length > 0 && (
				<section aria-label="Needs you" className="focus-needs">
					<h2 className="focus-section-heading">
						Needs you <span>{needs.length}</span>
					</h2>
					<div role="list" className="focus-list">
						{needs.map((i) => render(i, true))}
					</div>
				</section>
			)}
			{config.today && (
				<div hidden={filtered}>
					<TodayPost
						config={config.today}
						onUpdate={onUpdate}
						compact={tab === "for_you"}
						changesSinceLook={
							new Map(
								events
									.filter(
										(e) =>
											e.metadata?.reaction === "open" &&
											typeof e.metadata?.projectId === "string",
									)
									.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
									.map((e) => {
										const projectId = String(e.metadata?.projectId);
										const latest = all.find(
											(i) =>
												i.projectId === projectId &&
												i.at > e.occurredAt &&
												i.done,
										);
										return [
											projectId,
											latest
												? `Since you looked: ${latest.sentence}`
												: "No new receipts since you looked.",
										];
									}),
							)
						}
					/>
				</div>
			)}
			<div
				id="feed-receipts"
				role="feed"
				aria-label={
					filtered ? filterLabel : timeline ? "Everything" : "Updates for you"
				}
				aria-busy={loading}
			>
				{timeline ? (
					<div role="list" className="focus-list">
						{visible.map((i) => render(i))}
					</div>
				) : (
					<>
						<h2 className="focus-section-heading">
							Updates <span>{updates.length}</span>
						</h2>
						{updates.length > 0 && (
							<div role="list" className="focus-list">
								{updates.map((i) => render(i, true))}
							</div>
						)}
						{!updates.length && !loading && (
							<Text tone="secondary">Nothing else needs your attention.</Text>
						)}
						{waiting.length > 0 && (
							<>
								<Button
									variant="ghost"
									className="focus-more !px-0"
									aria-expanded={heldOpen}
									onClick={() => setHeldOpen((v) => !v)}
								>
									{heldOpen
										? "Fewer updates"
										: `${waiting.length} more updates`}
								</Button>
								{heldOpen && (
									<div role="list" className="focus-list">
										{waiting.map((i) => render(i))}
									</div>
								)}
							</>
						)}
						{handled.length > 0 && (
							<section className="focus-handled">
								<Button
									variant="ghost"
									className="focus-more !px-0"
									aria-expanded={handledOpen}
									onClick={() => setHandledOpen((v) => !v)}
								>
									Handled without you: {handled.length}
								</Button>
								{handledOpen && (
									<div role="list" className="focus-list">
										{handled.map((i) => (
											<div
												key={i.id}
												role="presentation"
												className="focus-handled-row"
											>
												{render(i)}
											</div>
										))}
									</div>
								)}
							</section>
						)}
					</>
				)}
			</div>
			{loading && <Text>Opening your feed…</Text>}
			{!loading && !failed && !visible.length && timeline && (
				<div role="status">
					<Text>{filtered ? emptyMessage : "No updates yet."}</Text>
				</div>
			)}
			{more && (
				<Button
					variant="ghost"
					className="focus-more !px-0"
					onClick={() => setRequest((r) => r + 1)}
					disabled={loading}
				>
					Earlier activity
				</Button>
			)}
			<DecisionContextSection title="Feed preferences">
				<Text>
					j / k move · o open · p pin · h hide · n not important. Everything
					keeps the full timeline.
				</Text>
				{navigation?.apps}
			</DecisionContextSection>
		</div>
	);
}

function FocusRow({
	item,
	actor,
	project,
	busy,
	onReact,
	onWork,
	signal,
	budgeted,
	session,
	events,
	enabled,
	ignoredAfterMs,
}: {
	item: FocusItem;
	actor: string;
	project?: string;
	busy: boolean;
	onReact: Parameters<typeof FeedCard>[0]["onReact"];
	onWork: Parameters<typeof FeedCard>[0]["onWork"];
	signal: (
		item: ActivityFeedItem,
		reaction: FocusSignal,
		extra?: Record<string, string | number | boolean | null>,
	) => Promise<boolean>;
	budgeted: boolean;
	session: { id: string; openedAt: number };
	events: LearningInteractionEvent[];
	enabled: boolean;
	ignoredAfterMs: number;
}) {
	const root = useRef<HTMLDivElement>(null);
	const report = useRef(signal);
	report.current = signal;
	const context = useRef({ events, budgeted });
	context.current = { events, budgeted };
	const initialAbove = useRef(false);
	const engaged = useRef(false);
	useEffect(() => {
		const node = root.current;
		if (!enabled || !node || typeof IntersectionObserver === "undefined")
			return;
		const box = node.getBoundingClientRect();
		initialAbove.current =
			context.current.budgeted &&
			box.top >= 0 &&
			box.bottom <= window.innerHeight;
		let start = 0;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let recorded = false;
		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry?.isIntersecting && document.visibilityState === "visible") {
					start = Date.now();
					if (!recorded) {
						recorded = true;
						void report.current(item, "impression", {
							aboveFold: initialAbove.current,
							budgeted: context.current.budgeted,
						});
						const previous = context.current.events.filter(
							(e) =>
								e.targetId === item.id &&
								e.metadata?.reaction === "impression" &&
								e.metadata?.sessionId !== session.id,
						);
						const opened = context.current.events.some(
							(e) => e.targetId === item.id && e.metadata?.reaction === "open",
						);
						if (previous.length >= 1 && !opened)
							timer = setTimeout(() => {
								if (!engaged.current && document.visibilityState === "visible")
									void report.current(item, "ignored_twice");
							}, ignoredAfterMs);
					}
				} else if (start) {
					const elapsed = Date.now() - start;
					start = 0;
					clearTimeout(timer);
					if (elapsed >= 1000)
						void report.current(item, "dwell", { elapsedMs: elapsed });
				}
			},
			{ threshold: 0.5 },
		);
		observer.observe(node);
		return () => {
			observer.disconnect();
			clearTimeout(timer);
			if (start && Date.now() - start >= 1000)
				void report.current(item, "dwell", { elapsedMs: Date.now() - start });
		};
	}, [item.id, session.id, enabled, ignoredAfterMs]);
	function open() {
		engaged.current = true;
		void signal(item, "open", {
			aboveFold: initialAbove.current,
			elapsedMs: Date.now() - session.openedAt,
			needsAction: item.needsAction,
		});
		if (item.needsAction)
			sessionStorage.setItem(
				"tedix-focus-origin",
				JSON.stringify({
					sessionId: session.id,
					openedAt: session.openedAt,
					itemId: item.id,
					source: item.source,
					workItemId: item.workItemId,
					at: Date.now(),
				}),
			);
	}
	const rowActions = [
		{ label: "Pin", reaction: "pin", Icon: PushPin },
		{ label: "Hide", reaction: "hide", Icon: EyeSlash },
		{ label: "Not important", reaction: "not_important", Icon: ThumbsDown },
		{ label: "Tell me earlier", reaction: "tell_me_earlier", Icon: Bell },
	] as const;
	function react(reaction: FocusSignal) {
		engaged.current = true;
		void signal(item, reaction);
	}
	const actions = rowActions.map(({ label, reaction, Icon }) => ({
		label,
		Icon,
		onClick: () => react(reaction),
	}));

	return (
		<div
			ref={root}
			tabIndex={-1}
			role="listitem"
			data-focus-row={item.id}
			className="focus-row"
			onClickCapture={(e) => {
				if (e.target instanceof Element && e.target.closest("a")) open();
			}}
		>
			{item.needsAction ? (
				<FocusDecisionRow item={item} actor={actor} project={project} />
			) : (
				<FeedCard
					item={item}
					actor={actor}
					project={project}
					busy={busy}
					onReact={onReact}
					onWork={onWork}
					rowActions={actions}
				/>
			)}
			{item.because && <p className="focus-because">{item.because}</p>}
			{item.needsAction && <FocusRowActions actions={actions} />}
		</div>
	);
}

/** A summary older than this with no checked story is not "being written": show the original request now. */
const FEED_FACE_FRESH_MS = 3 * 60_000;

export function FocusDecisionRow({
	item,
	actor,
	project,
}: {
	item: FocusItem;
	actor: string;
	project?: string;
}) {
	useOsFormattingPreferences();
	const decisionCardId = ["decision", "approval"].includes(item.kind)
		? item.id.replace(/^decision:/, "")
		: undefined;
	const fresh = Date.now() - Date.parse(item.at) < FEED_FACE_FRESH_MS;
	const [slow, setSlow] = useState(false);
	const [retries, setRetries] = useState(0);
	const face = useQuery({
		...osQuery.attention.getDeckCard.queryOptions({
			input: { cardId: item.id.replace(/^decision:/, ""), limit: 100 },
		}),
		enabled: item.needsAction && !!decisionCardId && !item.presentation,
		staleTime: 60000,
		retry: false,
		// A writer is still working on a fresh request; pick up its story without a reload.
		refetchInterval: (query) =>
			!item.presentation && !query.state.data?.presentation && fresh && !slow
				? 10_000
				: false,
	});
	const presentation = item.presentation ?? face.data?.presentation ?? null;
	const unavailable =
		face.isError ||
		item.faceText === copySpec.unavailableFace ||
		face.data?.faceText === copySpec.unavailableFace;
	// Only the summary line loads; the title is the real ask from the first paint.
	const waiting =
		!!decisionCardId && !presentation && !unavailable && fresh && !slow;
	useEffect(() => {
		if (!waiting) return;
		const timer = setTimeout(() => setSlow(true), FACE_WAIT_MS);
		return () => clearTimeout(timer);
	}, [waiting, retries]);
	const faceText =
		item.faceText ??
		face.data?.faceText ??
		decisionCardFaceText(presentation, face.data?.decision?.confidence ?? null);
	const title =
		presentation?.title ?? decisionCardFallbackTitle(item.sentence, 160);
	const original =
		item.explanation && item.explanation !== item.sentence
			? item.explanation
			: null;
	return (
		<article aria-label={title} className="focus-decision-row">
			<Link
				variant="record"
				className="focus-story"
				href={
					decisionCardId
						? `/work?view=deck#card=${encodeURIComponent(decisionCardId)}`
						: item.source
				}
			>
				{title}
			</Link>
			{presentation ? (
				<p className="fd-face-enter whitespace-pre-line">
					{faceText
						.split("\n")
						.slice(1)
						.join("\n")
						.replace(/(\bIf yes[,:]\s*)(?:If yes[,:]\s*)+/gi, "$1")}
				</p>
			) : waiting ? (
				<div
					role="status"
					aria-busy="true"
					className="focus-face-skeleton"
					data-face-pending
				>
					<Skeleton aria-hidden="true" className="w-3/4" />
					<span className="focus-face-writing">
						<Loader aria-hidden="true" size="sm" />
						{decisionText("Writing a short summary…")}
					</span>
				</div>
			) : decisionCardId ? (
				<div className="fd-face-enter grid gap-1">
					{original && (
						<p className="focus-face-fallback">
							{original.length > 280
								? `${original.slice(0, 279).trimEnd()}…`
								: original}
						</p>
					)}
					<div role="status" className="focus-face-note" data-face-fallback>
						<span>
							{decisionText(
								"Summary unavailable — request preview. Full source in Details.",
							)}
						</span>
						<Button
							variant="ghost"
							size="sm"
							className="focus-face-retry"
							disabled={face.isFetching}
							onClick={() => {
								setSlow(false);
								setRetries((count) => count + 1);
								void face.refetch();
							}}
						>
							{face.isFetching
								? decisionText("Retrying…")
								: decisionText("Retry")}
						</Button>
					</div>
				</div>
			) : null}
			<p className="focus-meta">
				<time dateTime={item.at} title={absoluteTime(item.at)}>
					{relativeTime(item.at)}
				</time>
			</p>
			<Collapsible className="relative z-1">
				<CollapsibleTrigger>Details</CollapsibleTrigger>
				<CollapsibleContent>
					<p>{project ?? actor}</p>
					<p className="focus-source-text">{item.sentence}</p>
					{original && <p className="focus-source-text">{original}</p>}
					<Link href={item.source}>Original request</Link>
				</CollapsibleContent>
			</Collapsible>
		</article>
	);
}
