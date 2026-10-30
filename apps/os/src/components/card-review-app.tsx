import { CardReviewBrowser } from "./card-review-browser";
import { useFactoryDelivery } from "@/lib/use-factory-delivery";
import { workRefreshOptions } from "@/lib/work-refresh";
import type {
	DecisionDeckConfig,
	DeckRoutingPolicy,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { DecisionRailContext } from "@/components/decision-context-rail";
import { FeedDeckDisclosure } from "@/components/feed-deck-primitives";
import { FactoryAgentHandoff } from "@/components/factory-agent-handoff";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { isTypingEvent } from "@/lib/keyboard";
import {
	ArrowArcLeft,
	ArrowSquareOut,
	CheckCircle,
	ClockCountdown,
	SkipForward,
	ThumbsDown,
	ThumbsUp,
	Lightning,
} from "@phosphor-icons/react";
import type {
	CardReviewConfig,
	CardReviewSource,
} from "@tedix/api-contract/schemas/os-card-review";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type PointerEvent,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { isConflictError } from "@/components/blueprints-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import {
	buildCardReviewWebMcpTools,
	type CardReviewActionResult,
	type CardReviewController,
} from "@/components/card-review-webmcp-tools";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Skeleton } from "@/components/kumo/skeleton";
import { Input } from "@/components/kumo/input";
import { Kbd } from "@/components/kumo/kbd";
import { Progress } from "@/components/kumo/progress";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import {
	cardActionKind,
	routeFactoryCard,
	cardSheetsForSource,
	cardsFromSheet,
	cellText,
	columnIndex,
	DEFAULT_RESULT_COLUMN,
	doItLabel,
	factoryLearningClass,
	factoryVerdictLearning,
	formatReason,
	isActionLabel,
	isOpen,
	type MissingColumns,
	needsOrganise,
	pendingRules,
	type PendingRule,
	plainWhy,
	reasonChips,
	resultParts,
	type ReviewCard,
	reviewQueue,
	rowWrite,
	ruleTextById,
	runParams,
	scoredCards,
	type SheetBody,
	snoozeUntil,
	sourceParts,
	type Verdict,
	verdictCells,
	whyThisCard,
} from "@tedix/api-contract/utils/card-review";
import {
	canvasOutputsQueryOptions,
	osQuery,
	outputDetailQueryOptions,
	workspaceSchedulesQueryOptions,
	userProfileQueryOptions,
} from "@/lib/os-query-options";
import { dayAndTime } from "@/lib/workspace-schedules";
import { DecisionLearningFeedback } from "@/components/decision-learning-feedback";
import { decisionText } from "@/shared/os-copy";
import { relativeTime } from "@/lib/time";
import { useOsLocale } from "@/lib/use-os-locale";
import { scoreLearning } from "@tedix/api-contract/utils/decision-learning";
import { WorkDecisionCard } from "@/components/work-decision-card";
import {
	FactoryCardRevisionPanel,
	canReviseFactoryCard,
	requestFactoryCardRevision,
} from "@/components/factory-card-revision-panel";
import { DeckClosure } from "@/components/feed-deck-primitives";
import { OS_COPY } from "@/shared/os-copy";
import { cn } from "@/lib/utils";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";

type Cell = string | number | boolean | null;
type SheetState = { body: SheetBody; revision: number };

const SNOOZE_STORAGE_KEY = "tedix.cardReview.snoozes";
const SWIPE_THRESHOLD = 96;

function readSnoozes(key: string | null): Record<string, string> {
	if (!key) return {};
	try {
		const raw = localStorage.getItem(key);
		const parsed: unknown = raw ? JSON.parse(raw) : {};
		if (!parsed || typeof parsed !== "object") return {};
		const now = new Date().toISOString();
		return Object.fromEntries(
			Object.entries(parsed as Record<string, unknown>).filter(
				(entry): entry is [string, string] =>
					typeof entry[1] === "string" && entry[1] > now,
			),
		);
	} catch {
		return {};
	}
}

function writeSnoozes(key: string | null, value: Record<string, string>) {
	if (!key) return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Snoozes are a per-viewer convenience; a blocked store only loses them.
	}
}

function sheetState(
	content: OsOutputContent | undefined,
	revision: number | undefined,
): SheetState | null {
	if (!content || content.kind !== "sheet" || revision === undefined)
		return null;
	return {
		body: { columns: content.columns, rows: content.rows },
		revision,
	};
}

/** A verdict written into a card row, with the cells it replaced. */
type VerdictWrite = {
	kind: "write";
	label: string;
	outputId: string;
	rowIndex: number;
	previous: Record<string, Cell>;
	counted: keyof Tally | null;
	learningEventId?: string;
};

/** A card decided in this session, kept so it can be reopened. */
type DecidedEntry = VerdictWrite & { cardKey: string; title: string };

type UndoEntry =
	| VerdictWrite
	| { kind: "snooze"; label: string; key: string }
	| { kind: "skip"; label: string; key: string };

type Tally = { useful: number; notUseful: number; doIt: number };

/** A run_skill Do it that stopped because the owner has not allowed organising. */
type NeedsAccess = {
	cardKey: string;
	workspaceId: string;
	resourceId: string | null;
	providerName: string;
};

/** How long a run_skill Do it waits for its outcome before saying it is still working. */
const RUN_WAIT_MS = 150_000;
const RUN_POLL_MS = 2_500;
const RUN_FIRST_POLL_MS = 400;

/**
 * The card review app: one factory card at a time, decided by a swipe, a key
 * or a big button, with the verdict written into the card sheet's own cells.
 */
export function CardReviewApp({
	config,
	inDeck = false,
	routing,
	classPolicies,
	focusCardKey,
	onFocusHandled,
}: {
	config: CardReviewConfig;
	inDeck?: boolean;
	routing?: DeckRoutingPolicy;
	classPolicies?: DecisionDeckConfig["classPolicies"];
	focusCardKey?: string;
	onFocusHandled?: () => void;
}) {
	useOsLocale();
	const queryClient = useQueryClient();
	const rail = useContext(DecisionRailContext);
	const learningModel = useQuery(
		osQuery.learningFeedback.model.queryOptions({ input: {} }),
	);
	const profile = useQuery(userProfileQueryOptions());
	const snoozeKey = profile.data?.id
		? `${SNOOZE_STORAGE_KEY}:${location.host}:${profile.data.id}`
		: null;
	const [learningEventId, setLearningEventId] = useState<string | null>(null);
	const sources = config.sources;
	const delivery = useFactoryDelivery(sources, classPolicies, routing);
	const recordChoice = useCallback(
		async (
			card: ReviewCard,
			source: CardReviewSource,
			choice: string,
			reason = "",
		) => {
			try {
				const recorded = await osApi.learningFeedback.recordInteraction({
					clientEventId: crypto.randomUUID(),
					eventKind:
						choice === "not_useful"
							? "rejected"
							: ["later", "skip"].includes(choice)
								? "ignored"
								: "accepted",
					scope: { kind: "personal" },
					surface: "decision_deck",
					targetType: "output",
					targetId: card.outputId,
					metadata: {
						...factoryVerdictLearning(source, card, reason),
						decisionChoice: choice,
						rowIndex: card.rowIndex,
						...(rail
							? {
									railOpenedBeforeDecision: rail.openedBefore(
										`${card.outputId}:${card.rowIndex}`,
									),
								}
							: {}),
						reason,
					},
				});
				setLearningEventId(recorded.event.id);
				void queryClient.invalidateQueries({
					queryKey: osQuery.learningFeedback.key(),
				});
				return recorded.event.id;
			} catch {
				// A learning outage must not turn a saved factory verdict into a failed action.
				return undefined;
			}
		},
		[queryClient, rail],
	);

	const outputLists = useQueries({
		queries: sources.map((source) => ({
			...canvasOutputsQueryOptions(source.workspaceId),
			...workRefreshOptions,
		})),
	});

	const sheetRefs = useMemo(() => {
		const cards: {
			sourceIndex: number;
			id: string;
			title: string;
			createdAt: string;
		}[] = [];
		const rules: { sourceIndex: number; id: string }[] = [];
		const feedback: { sourceIndex: number; id: string }[] = [];
		sources.forEach((source, sourceIndex) => {
			const items = outputLists[sourceIndex]?.data?.items ?? [];
			for (const output of cardSheetsForSource(source, items))
				cards.push({
					sourceIndex,
					id: output.id,
					title: output.title,
					createdAt: output.createdAt,
				});
			const titled = (title: string | undefined) =>
				title === undefined
					? undefined
					: items.find(
							(o) =>
								o.kind === "sheet" &&
								o.status === "active" &&
								o.title.trim() === title,
						);
			const rulesSheet = titled(source.rules?.sheetTitle);
			if (rulesSheet) rules.push({ sourceIndex, id: rulesSheet.id });
			const feedbackSheet = titled(source.feedbackSheetTitle);
			if (feedbackSheet) feedback.push({ sourceIndex, id: feedbackSheet.id });
		});
		return { cards, rules, feedback };
	}, [sources, outputLists]);

	const detailIds = useMemo(
		() => [
			...new Set([
				...sheetRefs.cards.map((s) => s.id),
				...sheetRefs.rules.map((s) => s.id),
			]),
		],
		[sheetRefs],
	);
	const details = useQueries({
		queries: detailIds.map((id) => ({
			...outputDetailQueryOptions(id),
			...workRefreshOptions,
		})),
	});
	const sheets = useMemo(() => {
		const map = new Map<string, SheetState>();
		detailIds.forEach((id, index) => {
			const data = details[index]?.data;
			const state = sheetState(
				data?.currentRevision.content,
				data?.currentRevision.revision,
			);
			if (state) map.set(id, state);
		});
		return map;
	}, [detailIds, details]);

	const { cards, allCards, missing } = useMemo(() => {
		const all: ReviewCard[] = [];
		const gaps: MissingColumns[] = [];
		for (const ref of sheetRefs.cards) {
			const state = sheets.get(ref.id);
			const source = sources[ref.sourceIndex];
			if (!state || !source) continue;
			const result = cardsFromSheet({
				source,
				sourceIndex: ref.sourceIndex,
				outputId: ref.id,
				sheetTitle: ref.title,
				runCreatedAt: ref.createdAt,
				body: state.body,
			});
			if ("missing" in result) gaps.push(result.missing);
			else all.push(...result.cards);
		}
		return { cards: scoredCards(all, sources), allCards: all, missing: gaps };
	}, [sheetRefs, sheets, sources]);

	const rules = useMemo(() => {
		const pending: PendingRule[] = [];
		const text = new Map<number, Map<string, string>>();
		for (const ref of sheetRefs.rules) {
			const source = sources[ref.sourceIndex];
			const state = sheets.get(ref.id);
			if (!source || !state) continue;
			pending.push(
				...pendingRules({
					source,
					sourceIndex: ref.sourceIndex,
					outputId: ref.id,
					body: state.body,
				}),
			);
			text.set(ref.sourceIndex, ruleTextById(source, state.body));
		}
		return { pending, text };
	}, [sheetRefs, sheets, sources]);

	const channels = useMemo(
		() => [...new Set(cards.map((card) => card.channel))],
		[cards],
	);
	const [channel, setChannel] = useState<string | null>(null);
	const activeChannel =
		channel !== null && channels.includes(channel) ? channel : null;
	const [skipped, setSkipped] = useState<string[]>([]);
	const [storedSnoozes, setStoredSnoozes] = useState<{
		key: string | null;
		value: Record<string, string>;
	}>(() => ({ key: snoozeKey, value: readSnoozes(snoozeKey) }));
	const snoozes =
		storedSnoozes.key === snoozeKey
			? storedSnoozes.value
			: readSnoozes(snoozeKey);
	const setSnoozes = (value: Record<string, string>) =>
		setStoredSnoozes({ key: snoozeKey, value });
	const { now, timeZone } = useCardSchedule();
	const queue = (() => {
		const reviewable = cards.filter((card) => !delivery.quiet(card));
		const pending = reviewQueue(
			inDeck
				? reviewable.filter(
						(card) =>
							card.key === focusCardKey ||
							routeFactoryCard(card, routing, now, learningModel.data)
								.destination === "deck",
					)
				: reviewable,
			{
				channel: activeChannel,
				snoozes,
				skipped,
				now,
				timeZone,
			},
		);
		const model = learningModel.data;
		if (!model?.config.enabled) return pending;
		const score = (card: ReviewCard) =>
			scoreLearning(
				{
					id: card.key,
					classId: factoryLearningClass(
						sources[card.sourceIndex]?.label ?? "",
						card.type,
					),
					source: "decision_deck",
					channel: card.channel,
				},
				model,
				now,
			).score;
		return pending.sort((a, b) => score(b) - score(a));
	})();
	const inChannel = cards.filter(
		(card) => activeChannel === null || card.channel === activeChannel,
	);
	const decidedCount = inChannel.filter((card) => !isOpen(card)).length;
	const scheduleLists = useQueries({
		queries: [...new Set(sources.map((s) => s.workspaceId))].map((id) =>
			workspaceSchedulesQueryOptions(id),
		),
	});
	// The soonest enabled run across the source workspaces brings the next cards;
	// undefined until every source workspace's schedules have loaded.
	const nextRunAt = scheduleLists.some((list) => !list.isSuccess)
		? undefined
		: (scheduleLists
				.flatMap((list) => list.data?.items ?? [])
				.filter((schedule) => schedule.enabled && schedule.nextRunAt)
				.map((schedule) => schedule.nextRunAt!)
				.sort()[0] ?? null);
	// Open cards this view leaves out: other channels, or routed away from the Deck.
	const hiddenOpen = cards.filter(
		(card) =>
			isOpen(card) &&
			!delivery.quiet(card) &&
			!(snoozes[card.key] && snoozes[card.key]! > now.toISOString()) &&
			!queue.some((row) => row.key === card.key),
	).length;
	const cardSheets = [
		...new Map(cards.map((card) => [card.outputId, card.sheetTitle])),
	];
	const progressLabel = `${queue.length} ${decisionText("waiting")} · ${decidedCount} ${decisionText("decided")} · ${inChannel.length} ${decisionText("total")}`;
	const [departingCard, setDepartingCard] = useState<ReviewCard | null>(null);
	// The Waiting list browses without a skip: browseKey pins the card on
	// screen and never writes a learning choice.
	const [browsing, setBrowsing] = useState(false);
	const [browseKey, setBrowseKey] = useState<string | null>(null);
	const card =
		departingCard ??
		(focusCardKey
			? queue.find((row) => row.key === focusCardKey)
			: browseKey
				? (queue.find((row) => row.key === browseKey) ?? queue[0])
				: queue[0]) ??
		null;
	const source = card ? sources[card.sourceIndex] : undefined;
	const actionLabel = card && source ? doItLabel(source, card) : null;

	const [selectedChips, setSelectedChips] = useState<string[]>([]);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [revisionPending, setRevisionPending] = useState(false);
	const [undo, setUndo] = useState<UndoEntry | null>(null);
	const [decided, setDecided] = useState<DecidedEntry[]>([]);
	const [running, setRunning] = useState<string | null>(null);
	const [needsAccess, setNeedsAccess] = useState<NeedsAccess | null>(null);
	const [lastResult, setLastResult] = useState<{
		number: string;
		label: string;
		result: string;
	} | null>(null);
	const [tally, setTally] = useState<Tally>({
		useful: 0,
		notUseful: 0,
		doIt: 0,
	});
	const cardKey = card?.key ?? null;
	useEffect(() => {
		setSelectedChips([]);
		setNote("");
	}, [cardKey]);

	/** Write named cells of one sheet row, retrying once on a concurrent edit. */
	const writeRow = useCallback(
		async (
			outputId: string,
			rowIndex: number,
			cellsByColumn: Record<string, Cell>,
			note: string,
		): Promise<Record<string, Cell>> => {
			const options = outputDetailQueryOptions(outputId);
			for (let attempt = 0; ; attempt += 1) {
				const detail =
					attempt === 0
						? (queryClient.getQueryData(options.queryKey) ??
							(await queryClient.fetchQuery(options)))
						: await queryClient.fetchQuery({ ...options, staleTime: 0 });
				const state = sheetState(
					detail?.currentRevision.content,
					detail?.currentRevision.revision,
				);
				if (!state) throw new Error("This sheet can no longer be read");
				const previous = Object.fromEntries(
					Object.keys(cellsByColumn).map((name) => [
						name,
						state.body.rows[rowIndex]?.[
							columnIndex(state.body.columns, name)
						] ?? null,
					]),
				);
				const { startColumn, cells } = rowWrite(
					state.body,
					rowIndex,
					cellsByColumn,
				);
				try {
					const result = await osApi.osWorkspaces.outputs.setSheetRange({
						outputId,
						startRow: rowIndex,
						startColumn,
						cells,
						expectedRevision: state.revision,
						note,
					});
					queryClient.setQueryData(options.queryKey, (old) =>
						old
							? {
									...old,
									output: result.output,
									currentRevision: result.revision,
								}
							: old,
					);
					return previous;
				} catch (error) {
					if (attempt === 0 && isConflictError(error)) continue;
					throw error;
				}
			}
		},
		[queryClient],
	);

	/**
	 * The outcome cell a run writes into the card row, read fresh until a newer
	 * revision of the sheet carries it (a retried card keeps its last outcome
	 * until the new run writes).
	 */
	const waitForOutcome = useCallback(
		async (outputId: string, rowIndex: number, column: string) => {
			const options = outputDetailQueryOptions(outputId);
			const before =
				queryClient.getQueryData(options.queryKey)?.currentRevision.revision ??
				0;
			const until = Date.now() + RUN_WAIT_MS;
			for (let attempt = 0; Date.now() < until; attempt += 1) {
				await new Promise((resolve) =>
					setTimeout(resolve, attempt === 0 ? RUN_FIRST_POLL_MS : RUN_POLL_MS),
				);
				const detail = await queryClient.fetchQuery({
					...options,
					staleTime: 0,
				});
				const state = sheetState(
					detail?.currentRevision.content,
					detail?.currentRevision.revision,
				);
				const index = state ? columnIndex(state.body.columns, column) : -1;
				const value =
					state && state.revision > before && index >= 0
						? cellText(state.body.rows[rowIndex]?.[index])
						: "";
				if (value) return value;
			}
			return null;
		},
		[queryClient],
	);

	/**
	 * run_skill Do it: start the source's skill on this card at once, then show
	 * what it did. The run writes the outcome and, when it worked, the done
	 * column, so the card leaves the queue by itself.
	 */
	const runCardAction = useCallback(
		async (
			current: ReviewCard,
			from: CardReviewSource,
			label: string,
			reason: string,
		): Promise<CardReviewActionResult> => {
			const run = from.run;
			if (!run) return { ok: false, error: "This source has no run settings" };
			const kind = cardActionKind(from, current);
			setBusy(true);
			setRunning(current.key);
			setNeedsAccess(null);
			try {
				const started = await osApi.osWorkspaces.schedules.runNow({
					workspaceId: from.workspaceId,
					skillId: run.skillId,
					params: runParams(from, current, kind, reason),
					...(needsOrganise(kind) ? { needs: "organise" as const } : {}),
					idempotencyKey: crypto.randomUUID(),
				});
				if (started.status === "needs_access") {
					const providerName = started.providerName ?? "account";
					setNeedsAccess({
						cardKey: current.key,
						workspaceId: from.workspaceId,
						resourceId: started.resourceId,
						providerName,
					});
					return {
						ok: false,
						error: `Allow organising first: the person must let this organise their ${providerName} (the button on the card), then press ${label} again.`,
					};
				}
				const result =
					(await waitForOutcome(
						current.outputId,
						current.rowIndex,
						from.columns.result ?? DEFAULT_RESULT_COLUMN,
					)) ?? "Still working; the outcome will show on the card";
				const parts = resultParts(result);
				setLastResult({ number: current.number, label, result });
				setUndo(null);
				if (parts.failed) {
					toast.error(`${label}: not done`, { description: result });
					return { ok: false, error: result };
				}
				setTally((t) => ({ ...t, doIt: t.doIt + 1 }));
				toast.success(`${label}: ${parts.text}`);
				return { ok: true, result };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Try again in a moment.";
				toast.error(`${label} did not start`, { description: message });
				return { ok: false, error: `${label} did not start: ${message}` };
			} finally {
				setBusy(false);
				setRunning(null);
			}
		},
		[waitForOutcome],
	);

	const decide = useCallback(
		async (
			verdict: Verdict["kind"],
			reasonOverride?: string,
		): Promise<CardReviewActionResult> => {
			if (!card || !source) return { ok: false, error: "No card is open" };
			if (busy) return { ok: false, error: "The last action is still saving" };
			if (revisionPending)
				return { ok: false, error: "Wait for the revised draft first" };
			if (verdict === "do_it" && actionLabel === null)
				return { ok: false, error: "This card has no action to do" };
			const reason = reasonOverride ?? formatReason(selectedChips, note);
			if (verdict === "do_it" && source.doIt === "run_skill") {
				const result = await runCardAction(
					card,
					source,
					actionLabel ?? decisionText("Do it"),
					reason,
				);
				if (result.ok) await recordChoice(card, source, verdict, reason);
				return result;
			}
			if (verdict === "do_it" && source.doIt === "copy_and_open") {
				// Open first: a popup must start inside the user's gesture.
				if (card.link) window.open(card.link, "_blank", "noopener,noreferrer");
				if (card.draft) {
					try {
						await navigator.clipboard.writeText(card.draft);
					} catch {
						toast.warning("Copy the draft by hand; the clipboard is blocked");
					}
				}
			}
			setBusy(true);
			try {
				const previous = await writeRow(
					card.outputId,
					card.rowIndex,
					verdictCells(source, card, { kind: verdict, reason }),
					`Card review: card ${card.number} marked ${verdict.replace("_", " ")}`,
				);
				const counted: keyof Tally =
					verdict === "useful"
						? "useful"
						: verdict === "not_useful"
							? "notUseful"
							: "doIt";
				const eventId = await recordChoice(card, source, verdict, reason);
				setTally((t) => ({ ...t, [counted]: t[counted] + 1 }));
				const written: VerdictWrite = {
					kind: "write",
					label:
						verdict === "useful"
							? decisionText("Marked useful")
							: verdict === "not_useful"
								? decisionText("Marked not useful")
								: source.doIt === "copy_and_open"
									? "Draft copied, marked done"
									: decisionText("Marked to do"),
					outputId: card.outputId,
					rowIndex: card.rowIndex,
					previous,
					counted,
					learningEventId: eventId,
				};
				setUndo(written);
				setDecided((entries) => [
					...entries.filter((entry) => entry.cardKey !== card.key),
					{
						...written,
						cardKey: card.key,
						title: card.action || plainWhy(card.why) || card.sourceText,
					},
				]);
				setSkipped((keys) => keys.filter((key) => key !== card.key));
				return { ok: true };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Try again in a moment.";
				toast.error("The verdict was not saved", { description: message });
				return { ok: false, error: `The verdict was not saved: ${message}` };
			} finally {
				setBusy(false);
			}
		},
		[
			actionLabel,
			busy,
			revisionPending,
			card,
			note,
			runCardAction,
			selectedChips,
			source,
			writeRow,
			queryClient,
			recordChoice,
		],
	);

	const snooze = useCallback((): CardReviewActionResult => {
		if (!card) return { ok: false, error: "No card is open" };
		const next = { ...snoozes, [card.key]: snoozeUntil(new Date()) };
		setSnoozes(next);
		writeSnoozes(snoozeKey, next);
		setUndo({
			kind: "snooze",
			label: decisionText("Snoozed until tomorrow"),
			key: card.key,
		});
		if (source) void recordChoice(card, source, "later");
		return { ok: true };
	}, [card, snoozes, snoozeKey, source, recordChoice]);

	const skip = useCallback((): CardReviewActionResult => {
		if (!card) return { ok: false, error: "No card is open" };
		if (queue.length < 2)
			return {
				ok: false,
				error: "This is the last card; there is none to skip to",
			};
		setSkipped((keys) => [...keys.filter((key) => key !== card.key), card.key]);
		setUndo({ kind: "skip", label: decisionText("Skipped"), key: card.key });
		if (source) void recordChoice(card, source, "skip");
		return { ok: true };
	}, [card, queue.length, source, recordChoice]);

	/** Put back the cells a verdict replaced and correct its learning event. */
	const revertVerdict = useCallback(
		async (
			entry: VerdictWrite,
			note: string,
		): Promise<{ ok: true } | { ok: false; error: string }> => {
			setBusy(true);
			try {
				await writeRow(entry.outputId, entry.rowIndex, entry.previous, note);
				if (entry.learningEventId) {
					await osApi.learningFeedback.correct({
						eventId: entry.learningEventId,
						clientEventId: crypto.randomUUID(),
					});
					void queryClient.invalidateQueries({
						queryKey: osQuery.learningFeedback.key(),
					});
				}
				const counted = entry.counted;
				if (counted)
					setTally((t) => ({ ...t, [counted]: Math.max(0, t[counted] - 1) }));
				setDecided((entries) =>
					entries.filter(
						(item) =>
							item.outputId !== entry.outputId ||
							item.rowIndex !== entry.rowIndex,
					),
				);
				return { ok: true };
			} catch (error) {
				return {
					ok: false,
					error:
						error instanceof Error ? error.message : "Try again in a moment.",
				};
			} finally {
				setBusy(false);
			}
		},
		[writeRow, queryClient],
	);

	const undoLast = useCallback(async (): Promise<CardReviewActionResult> => {
		if (!undo) return { ok: false, error: "There is nothing to undo" };
		if (busy) return { ok: false, error: "The last action is still saving" };
		if (undo.kind === "snooze") {
			const next = { ...snoozes };
			delete next[undo.key];
			setSnoozes(next);
			writeSnoozes(snoozeKey, next);
		} else if (undo.kind === "skip") {
			setSkipped((keys) => keys.filter((key) => key !== undo.key));
		} else {
			const reverted = await revertVerdict(undo, "Card review: verdict undone");
			if (!reverted.ok) {
				toast.error("Undo failed", { description: reverted.error });
				return { ok: false, error: `Undo failed: ${reverted.error}` };
			}
		}
		setUndo(null);
		return { ok: true };
	}, [busy, snoozes, snoozeKey, undo, revertVerdict]);

	/** Reopen a card decided in this session: clear its verdict and show it again. */
	const reopen = useCallback(
		async (entry: DecidedEntry) => {
			if (busy) return;
			const reverted = await revertVerdict(
				entry,
				"Card review: verdict reopened",
			);
			if (!reverted.ok) {
				toast.error("The card was not reopened", {
					description: reverted.error,
				});
				return;
			}
			setUndo((current) =>
				current?.kind === "write" &&
				current.outputId === entry.outputId &&
				current.rowIndex === entry.rowIndex
					? null
					: current,
			);
			setBrowseKey(entry.cardKey);
		},
		[busy, revertVerdict],
	);

	const decideRule = useCallback(
		async (
			rule: PendingRule,
			status: "accepted" | "rejected",
		): Promise<CardReviewActionResult> => {
			const statusColumn = sources[rule.sourceIndex]?.rules?.statusColumn;
			if (!statusColumn)
				return { ok: false, error: "This source has no rules sheet" };
			try {
				await writeRow(
					rule.outputId,
					rule.rowIndex,
					{ [statusColumn]: status },
					`Card review: rule ${rule.id} ${status}`,
				);
				return { ok: true };
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Try again in a moment.";
				toast.error("The rule was not updated", { description: message });
				return { ok: false, error: `The rule was not updated: ${message}` };
			}
		},
		[sources, writeRow],
	);

	const chips = source
		? {
				useful: reasonChips(source, "useful"),
				notUseful: reasonChips(source, "notUseful"),
			}
		: { useful: [], notUseful: [] };
	const allChips = [...chips.notUseful, ...chips.useful];
	const toggleChip = (chip: string) =>
		setSelectedChips((current) =>
			current.includes(chip)
				? current.filter((c) => c !== chip)
				: [...current, chip],
		);

	const loading =
		outputLists.some((q) => q.isPending) ||
		details.some((q) => q.isPending && q.fetchStatus !== "idle");

	// Agent tools drive the same state and callbacks as the buttons above.
	const controller: CardReviewController = {
		loading,
		card,
		ruleText: card ? rules.text.get(card.sourceIndex) : undefined,
		doIt: source?.doIt ?? null,
		doItLabel: actionLabel,
		reasonChips: chips,
		channel: activeChannel,
		channels,
		left: queue.length,
		total: inChannel.length,
		undoLabel: undo?.label ?? null,
		pendingRules: rules.pending,
		setVerdict: ({ verdict, chips: picked, note: text }) => {
			setSelectedChips(picked);
			setNote(text);
			return decide(verdict, formatReason(picked, text));
		},
		canRequestChanges: Boolean(
			card && source && canReviseFactoryCard(card, source),
		),
		requestChanges: async (instruction) => {
			const sheet = card && sheets.get(card.outputId);
			if (!card || !source || !sheet || !canReviseFactoryCard(card, source))
				return { ok: false, error: "This card has no draft to revise" };
			if (revisionPending)
				return { ok: false, error: "A revision of this card is still running" };
			try {
				await requestFactoryCardRevision(card.key, sheet.revision, {
					instruction,
				});
			} catch (error) {
				return { ok: false, error: (error as Error).message };
			}
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: osQuery.osWorkspaces.outputs.key(),
				}),
				queryClient.invalidateQueries({ queryKey: osQuery.attention.key() }),
			]);
			return { ok: true };
		},
		snooze,
		skip,
		undo: undoLast,
		setChannel,
		decideRule: (ruleKey, status) => {
			const rule = rules.pending.find((r) => r.key === ruleKey);
			return rule
				? decideRule(rule, status)
				: Promise.resolve<CardReviewActionResult>({
						ok: false,
						error: "That rule is not pending",
					});
		},
	};
	useAppWebMcpTools(
		"card-review",
		controller,
		(current) => buildCardReviewWebMcpTools(current, channels),
		[channels.join("\n")],
	);

	if (card && rail?.open)
		rail.openedBefore(`${card.outputId}:${card.rowIndex}`);

	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		rootRef.current?.focus({ preventScroll: true });
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			event.metaKey ||
			event.ctrlKey ||
			event.altKey
		)
			return;
		if (isTypingEvent(event.nativeEvent)) {
			if (event.key === "Escape") rootRef.current?.focus();
			return;
		}
		const key = event.key.toLowerCase();
		if (browsing) {
			if (key === "w" || event.key === "Escape") {
				setBrowsing(false);
				event.preventDefault();
			}
			return;
		}
		if (key === "w" && allCards.length > 0) {
			setBrowsing(true);
			event.preventDefault();
			return;
		}
		const digit = Number.parseInt(key, 10);
		if (key === "arrowright" || key === "u") void decide("useful");
		else if (key === "arrowleft" || key === "n") void decide("not_useful");
		else if (key === "d" && actionLabel !== null) void decide("do_it");
		else if (key === "s") snooze();
		else if (key === "k") skip();
		else if (key === "z") void undoLast();
		else if (digit >= 1 && digit <= allChips.length)
			toggleChip(allChips[digit - 1]!);
		else return;
		event.preventDefault();
	};

	const failed =
		outputLists.some((q) => q.isError) || details.some((q) => q.isError);
	const readFailure = (
		<Alert variant="warning">
			<AlertTitle>Cards are unavailable</AlertTitle>
			<AlertDescription>
				A workspace or source sheet in this app's settings cannot be read. Check
				that you can open both. Workspace access does not grant access to
				restricted source sheets.
			</AlertDescription>
		</Alert>
	);
	const reviewed = tally.useful + tally.notUseful + tally.doIt;
	if (inDeck)
		return (
			<div
				data-card-review
				className="fd-decision-stack grid min-w-0 gap-4"
				data-has-next={queue.length > 1}
			>
				<DecisionLearningFeedback eventId={learningEventId} />
				<FactoryAgentHandoff
					sources={sources}
					routing={routing}
					policies={classPolicies}
				/>
				{failed ? (
					readFailure
				) : card && source ? (
					<WorkDecisionCard
						key={card.key}
						autoFocus
						kind="decision"
						title={(card.action || plainWhy(card.why) || card.sourceText).slice(
							0,
							500,
						)}
						askedBy={source.label}
						body={card.draft}
						pending={revisionPending || busy}
						content={
							<div className="grid min-w-0 gap-3">
								<FaceChips card={card} />
								<RankedFor text={whyThisCard(source, card)} />
								<SourceLine text={card.sourceText} />
								{card.draft && <Text>{card.draft}</Text>}
								{card.draft && sheets.get(card.outputId) && (
									<FactoryCardRevisionPanel
										key={card.key}
										card={card}
										source={source}
										revision={sheets.get(card.outputId)!.revision}
										onPending={setRevisionPending}
									/>
								)}
							</div>
						}
						why={<Text>{plainWhy(card.why)}</Text>}
						rejectReasons={source.scoring?.skipReasonChips.map(
							(chip) => chip.label,
						)}
						actions={[
							{
								id: "useful",
								label: decisionText("Useful"),
								intent: "approve",
							},
							{
								id: "not_useful",
								label: decisionText("Not useful"),
								intent: "reject",
							},
							...(card.action && actionLabel
								? [
										{
											id: "do_it",
											label: actionLabel,
											intent: "approve" as const,
										},
									]
								: []),
							{ id: "later", label: decisionText("Later"), intent: "later" },
						]}
						onDecisionSettled={() => {
							setDepartingCard(null);
							if (focusCardKey) onFocusHandled?.();
						}}
						onDecision={async (feedback) => {
							setDepartingCard(card);
							const result =
								feedback.action === "later"
									? snooze()
									: await decide(
											feedback.action as Verdict["kind"],
											formatReason(
												feedback.reason ? [feedback.reason] : [],
												feedback.feedback ?? "",
											),
										);
							if (!result.ok) throw new Error(result.error);
						}}
					/>
				) : loading ? (
					<Text>{OS_COPY.feed.loading}</Text>
				) : focusCardKey ? (
					<Text>That decision is no longer available in this view.</Text>
				) : (
					<DeckClosure
						title={
							cards.length
								? OS_COPY.feedDeckVisual.clear
								: decisionText("No cards yet")
						}
						summary={
							reviewed
								? OS_COPY.feedDeckVisual.doneToday(reviewed)
								: decisionText(
										"New cards appear here after the next factory run.",
									)
						}
					/>
				)}
			</div>
		);

	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			data-card-review
			className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4 outline-none"
			aria-label={decisionText("Card review")}
		>
			<DecisionLearningFeedback eventId={learningEventId} />
			{rules.pending.length > 0 && (
				<PendingRules rules={rules.pending} onDecide={decideRule} />
			)}

			<header className="flex flex-wrap items-center justify-between gap-2">
				{channels.length > 1 ? (
					<SegmentedControl
						ariaLabel={decisionText("Show cards from")}
						compact
						value={activeChannel ?? ""}
						options={[
							{ value: "", label: decisionText("All") },
							...channels.map((value) => ({
								value,
								label: value,
							})),
						]}
						onValueChange={(value) => setChannel(value || null)}
					/>
				) : (
					<Text as="span" role="label" tone="secondary">
						{channels[0] ?? sources.map((s) => s.label).join(" · ")}
					</Text>
				)}
				{allCards.length > 0 && (
					<Button
						size="sm"
						variant="ghost"
						aria-label={`${decisionText("See every open card")}: ${progressLabel}`}
						aria-pressed={browsing}
						data-card-review-progress
						onClick={() => setBrowsing(true)}
					>
						{progressLabel}
					</Button>
				)}
			</header>
			<FactoryAgentHandoff
				sources={sources}
				routing={routing}
				policies={classPolicies}
			/>
			{inChannel.some((card) => delivery.quiet(card)) && (
				<section aria-label="Updates" className="flex flex-col gap-2">
					{inChannel
						.filter((card) => delivery.quiet(card))
						.map((card) => (
							<Text key={card.key} as="p" role="caption" tone="secondary">
								Update: {card.why || card.sourceText}
							</Text>
						))}
				</section>
			)}
			{inChannel.length > 0 && (
				<Progress
					aria-label="Cards reviewed"
					value={Math.round((decidedCount / inChannel.length) * 100)}
				/>
			)}

			{missing.length > 0 && (
				<Alert variant="warning">
					<AlertTitle>Some sheets do not match the app settings</AlertTitle>
					<AlertDescription>
						{missing
							.map((m) => `${m.sheetTitle}: no ${m.missing.join(", ")} column`)
							.join(". ")}
					</AlertDescription>
				</Alert>
			)}

			{lastResult && (
				<LastResult
					number={lastResult.number}
					label={lastResult.label}
					result={lastResult.result}
				/>
			)}

			{failed ? (
				readFailure
			) : loading && cards.length === 0 ? (
				<Skeleton className="h-80 rounded-2xl" role="status">
					<span className="sr-only">{decisionText("Loading cards…")}</span>
				</Skeleton>
			) : browsing ? (
				<WaitingList
					queue={queue}
					cards={allCards}
					sources={sources}
					now={now}
					onOpen={(key) => {
						setBrowseKey(key);
						setBrowsing(false);
					}}
					onBack={() => setBrowsing(false)}
				/>
			) : card && source ? (
				<>
					{needsAccess?.cardKey === card.key && (
						<AllowOrganising
							access={needsAccess}
							onAllowed={() => setNeedsAccess(null)}
						/>
					)}
					<SwipeCard
						key={card.key}
						card={card}
						ruleText={rules.text.get(card.sourceIndex)}
						rankedFor={whyThisCard(source, card)}
						onSwipe={(direction) =>
							void decide(direction === "right" ? "useful" : "not_useful")
						}
						disabled={busy || revisionPending}
					/>
					{card.draft && sheets.get(card.outputId) && (
						<FactoryCardRevisionPanel
							key={`revise:${card.key}`}
							card={card}
							source={source}
							revision={sheets.get(card.outputId)!.revision}
							onPending={setRevisionPending}
						/>
					)}
					<ReasonPicker
						chips={chips}
						allChips={allChips}
						selected={selectedChips}
						onToggle={toggleChip}
						note={note}
						onNote={setNote}
					/>
					{/* On a phone the decision bar stays under the thumb while the card scrolls. */}
					<div className="flex flex-col gap-2 max-sm:sticky max-sm:bottom-0 max-sm:z-10 max-sm:border-t max-sm:border-kumo-line max-sm:bg-kumo-base max-sm:py-2">
						<div className="grid grid-cols-2 gap-2">
							<Button
								size="lg"
								variant="outline"
								className="h-14! w-full justify-center"
								icon={<ThumbsDown aria-hidden />}
								disabled={busy || revisionPending}
								onClick={() => void decide("not_useful")}
								aria-keyshortcuts="ArrowLeft"
							>
								{decisionText("Not useful")}
							</Button>
							<Button
								size="lg"
								variant="outline"
								className="h-14! w-full justify-center"
								icon={<ThumbsUp aria-hidden />}
								disabled={busy || revisionPending}
								onClick={() => void decide("useful")}
								aria-keyshortcuts="ArrowRight"
							>
								{decisionText("Useful")}
							</Button>
							{actionLabel !== null && (
								<Button
									size="lg"
									className="col-span-2 h-14! w-full justify-center"
									icon={<Lightning aria-hidden />}
									disabled={busy || revisionPending}
									loading={running === card.key}
									onClick={() => void decide("do_it")}
									aria-keyshortcuts="D"
								>
									{running === card.key
										? `Doing it: ${actionLabel}…`
										: actionLabel}
								</Button>
							)}
						</div>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex gap-1">
								<Button
									size="sm"
									variant="ghost"
									icon={<ClockCountdown aria-hidden />}
									onClick={snooze}
									aria-keyshortcuts="S"
								>
									{decisionText("Snooze")}
								</Button>
								<Button
									size="sm"
									variant="ghost"
									icon={<SkipForward aria-hidden />}
									onClick={skip}
									disabled={queue.length < 2}
									aria-keyshortcuts="K"
								>
									{decisionText("Skip")}
								</Button>
							</div>
							<UndoButton undo={undo} busy={busy} onUndo={undoLast} />
						</div>
					</div>
					<Text
						as="p"
						role="caption"
						tone="secondary"
						className="hidden text-center sm:block"
					>
						<Kbd>←</Kbd> not useful · <Kbd>→</Kbd> useful ·{" "}
						{actionLabel !== null && (
							<>
								<Kbd>D</Kbd> do it ·{" "}
							</>
						)}
						<Kbd>S</Kbd> snooze · <Kbd>K</Kbd> skip · <Kbd>W</Kbd> waiting ·{" "}
						<Kbd>1</Kbd>–<Kbd>{allChips.length}</Kbd> reasons · <Kbd>Z</Kbd>{" "}
						undo
					</Text>
					{source.doIt === "approve" && actionLabel !== null && (
						<Text
							as="p"
							role="caption"
							tone="secondary"
							className="text-center"
						>
							{actionLabel} only saves your choice. Nothing is sent or changed
							yet.
						</Text>
					)}
					{source.doIt === "run_skill" && actionLabel !== null && (
						<Text
							as="p"
							role="caption"
							tone="secondary"
							className="text-center"
						>
							Tedix does this now. It never sends mail or deletes anything;
							bigger jobs become a Work item.
						</Text>
					)}
				</>
			) : (
				<CaughtUp
					reviewed={reviewed}
					toDo={tally.doIt}
					snoozed={
						inChannel.filter(
							(c) => snoozes[c.key] && snoozes[c.key]! > now.toISOString(),
						).length
					}
					hasCards={inChannel.length > 0}
					undo={undo}
					busy={busy}
					onUndo={undoLast}
					decided={decided}
					onReopen={(entry) => void reopen(entry)}
					nextRun={
						nextRunAt ? dayAndTime(nextRunAt, now, { timeZone }) : nextRunAt
					}
					hiddenOpen={hiddenOpen}
					channel={activeChannel}
					onShowAll={() => setChannel(null)}
					sheets={cardSheets}
				/>
			)}
		</div>
	);
}

/**
 * Every open card at once, read-only. Tapping a row puts that card on screen
 * without the skip a K would have written; Back returns to the queue's top.
 */
function WaitingList({
	queue,
	cards,
	sources,
	now,
	onOpen,
	onBack,
}: {
	queue: readonly ReviewCard[];
	cards: readonly ReviewCard[];
	sources: readonly CardReviewSource[];
	now: Date;
	onOpen: (cardKey: string) => void;
	onBack: () => void;
}) {
	const [inspect, setInspect] = useState(false);
	const waiting = [...queue].sort((a, b) =>
		a.runCreatedAt === b.runCreatedAt
			? a.key.localeCompare(b.key)
			: a.runCreatedAt.localeCompare(b.runCreatedAt),
	);
	if (inspect)
		return (
			<CardReviewBrowser
				cards={cards}
				sources={sources}
				onBack={() => setInspect(false)}
			/>
		);
	return (
		<section
			aria-label={decisionText("Waiting")}
			data-card-review-waiting
			className="flex flex-col gap-2"
		>
			<div className="flex items-center justify-between gap-2">
				<Text as="h3" role="section" className="m-0">
					{decisionText("Everything waiting")}
				</Text>
				<Button size="sm" variant="ghost" onClick={onBack}>
					{decisionText("Back")}
				</Button>
			</div>
			<Button size="sm" variant="ghost" onClick={() => setInspect(true)}>
				Inspect all cards
			</Button>
			{waiting.map((item) => (
				<Button
					key={item.key}
					type="button"
					variant="outline"
					multiline
					onClick={() => onOpen(item.key)}
					className="w-full min-w-0 flex-col items-stretch gap-1 p-4 text-left whitespace-normal"
				>
					<span className="flex min-w-0 items-baseline justify-between gap-2">
						<Text
							as="span"
							role="caption"
							tone="secondary"
							className="truncate"
						>
							{`${item.sourceLabel} · ${item.sheetTitle} · #${item.number}`}
						</Text>
						<Text
							as="span"
							role="caption"
							tone="secondary"
							className="shrink-0"
						>
							{relativeTime(item.runCreatedAt, now)}
						</Text>
					</span>
					<Text as="span" className="min-w-0">
						{item.action || plainWhy(item.why) || item.sourceText}
					</Text>
					{item.timing && (
						<Text as="span" role="caption" tone="secondary">
							{OS_COPY.feed.waiting}: {item.timing}
						</Text>
					)}
				</Button>
			))}
		</section>
	);
}

/** What the last run_skill Do it did, with its Work item when it filed one. */
function LastResult({
	number,
	label,
	result,
}: {
	number: string;
	label: string;
	result: string;
}) {
	const parts = resultParts(result);
	return (
		<Text
			as="p"
			role="label"
			tone={parts.failed ? "error" : "secondary"}
			className="m-0"
			aria-live="polite"
			data-card-review-last-result
		>
			#{number} {label}: {parts.text}
			{parts.workHref && (
				<>
					{" "}
					<a
						href={parts.workHref}
						className="text-kumo-link underline-offset-4 hover:underline"
					>
						Open the Work item
					</a>
				</>
			)}
		</Text>
	);
}

/**
 * The owner's own click that lets the source's skills organise their account
 * (archive, label, mark read, unsubscribe, draft replies). It never sends or
 * deletes, and the account's row in the workspace can take it back.
 */
function AllowOrganising({
	access,
	onAllowed,
}: {
	access: NeedsAccess;
	onAllowed: () => void;
}) {
	const queryClient = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = access.providerName;
	const allow = async () => {
		if (!access.resourceId) return;
		setPending(true);
		setError(null);
		try {
			await osApi.osWorkspaces.schedules.setPersonalAccess({
				workspaceId: access.workspaceId,
				resourceId: access.resourceId,
				level: "organise",
			});
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: workspaceSchedulesQueryOptions(access.workspaceId).queryKey,
				}),
				queryClient.invalidateQueries({
					queryKey: osQuery.personalResourceDelegations.list.key(),
				}),
			]);
			toast.success(`Tedix can now organise your ${name}. Press Do it again.`);
			onAllowed();
		} catch (failure) {
			setError(
				failure instanceof Error ? failure.message : "Try again in a moment.",
			);
		} finally {
			setPending(false);
		}
	};
	return (
		<Alert variant="warning" data-card-review-allow-organising>
			<AlertTitle>Allow organising first</AlertTitle>
			<AlertDescription>
				<span className="flex flex-col items-start gap-2">
					<span>
						This action changes your {name}. Tedix can read it now, but not
						organise it.
					</span>
					{access.resourceId ? (
						<Button
							size="sm"
							variant="secondary"
							disabled={pending}
							onClick={() => void allow()}
						>
							Let this organise my {name} (archive, label, unsubscribe; never
							sends or deletes)
						</Button>
					) : (
						<span>
							Attach your {name} to{" "}
							<a href={`/workspace/${access.workspaceId}`}>this workspace</a>{" "}
							first (Add source, then Attach resource).
						</span>
					)}
					{error && <span role="alert">{error}</span>}
				</span>
			</AlertDescription>
		</Alert>
	);
}

function UndoButton({
	undo,
	busy,
	onUndo,
}: {
	undo: UndoEntry | null;
	busy: boolean;
	onUndo: () => void;
}) {
	if (!undo) return null;
	return (
		<Button
			size="sm"
			variant="ghost"
			icon={<ArrowArcLeft aria-hidden />}
			onClick={onUndo}
			disabled={busy}
			aria-keyshortcuts="Z"
		>
			Undo: {undo.label.toLowerCase()}
		</Button>
	);
}

function SwipeCard({
	card,
	ruleText,
	rankedFor,
	onSwipe,
	disabled,
}: {
	card: ReviewCard;
	ruleText: Map<string, string> | undefined;
	/** The factory's top score inputs, e.g. "fresh thread, buyer intent". */
	rankedFor: string | null;
	onSwipe: (direction: "left" | "right") => void;
	disabled: boolean;
}) {
	const [dx, setDx] = useState(0);
	const start = useRef<{ x: number; y: number; id: number } | null>(null);
	const horizontal = useRef(false);

	const onPointerDown = (event: PointerEvent<HTMLElement>) => {
		if (disabled || event.button !== 0) return;
		if ((event.target as HTMLElement).closest("a,button,input,textarea"))
			return;
		start.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
		horizontal.current = false;
	};
	const onPointerMove = (event: PointerEvent<HTMLElement>) => {
		const origin = start.current;
		if (!origin || origin.id !== event.pointerId) return;
		const moveX = event.clientX - origin.x;
		const moveY = event.clientY - origin.y;
		if (!horizontal.current) {
			if (Math.abs(moveX) < 8) return;
			if (Math.abs(moveY) > Math.abs(moveX)) {
				start.current = null;
				return;
			}
			horizontal.current = true;
			event.currentTarget.setPointerCapture(event.pointerId);
		}
		setDx(moveX);
	};
	const finish = () => {
		const moved = dx;
		start.current = null;
		horizontal.current = false;
		if (moved > SWIPE_THRESHOLD) onSwipe("right");
		else if (moved < -SWIPE_THRESHOLD) onSwipe("left");
		setDx(0);
	};

	const rules = card.ruleIds
		.map((id) => ({ id, text: ruleText?.get(id) }))
		.filter((rule): rule is { id: string; text: string } => !!rule.text);
	const intent = dx > 24 ? "useful" : dx < -24 ? "not" : null;
	const strength = Math.min(1, Math.abs(dx) / SWIPE_THRESHOLD);

	return (
		<article
			data-card-review-card
			aria-label={`Card ${card.number}${card.type ? `: ${card.type}` : ""}`}
			className={cn(
				"card-review-card relative flex touch-pan-y select-none flex-col gap-3 rounded-2xl border border-kumo-line bg-kumo-elevated p-4 shadow-tedix-raised sm:p-5",
				dx === 0 && "transition-transform duration-200 ease-out",
			)}
			style={{
				transform: dx ? `translateX(${dx}px) rotate(${dx / 30}deg)` : undefined,
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={finish}
			onPointerCancel={() => {
				start.current = null;
				setDx(0);
			}}
		>
			{intent && (
				<div
					aria-hidden
					className={cn(
						"pointer-events-none absolute top-4 rounded-md border-2 px-2 py-0.5 font-semibold uppercase tracking-wide",
						intent === "useful"
							? "left-4 border-kumo-success text-kumo-success"
							: "right-4 border-kumo-danger text-kumo-danger",
					)}
					style={{ opacity: strength }}
				>
					{intent === "useful"
						? decisionText("Useful")
						: decisionText("Not useful")}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant="secondary">{card.channel}</Badge>
				{card.type && <Badge variant="outline">{card.type}</Badge>}
				<FaceChips card={card} />
				<Text as="span" role="caption" tone="secondary" className="ml-auto">
					{card.sheetTitle} · #{card.number}
				</Text>
			</div>

			{card.who && (
				<Text as="p" role="body" tone="strong" className="m-0">
					{card.who}
				</Text>
			)}
			<SourceLine text={card.sourceText} />

			<Text as="p" role="body" className="m-0 whitespace-pre-wrap">
				{plainWhy(card.why)}
			</Text>
			<RankedFor text={rankedFor} />

			{card.action && !isActionLabel(card.action) && (
				<section
					aria-label={decisionText("Suggested action")}
					className="flex flex-col gap-1"
				>
					<Text as="h3" role="caption" tone="secondary" className="m-0">
						{decisionText("Suggested action")}
					</Text>
					<Text as="p" role="body" className="m-0">
						{card.action}
					</Text>
				</section>
			)}
			{card.result && (
				<Text
					as="p"
					role="label"
					tone={resultParts(card.result).failed ? "error" : "secondary"}
					className="m-0"
					data-card-review-result
				>
					Last try: {card.result}
				</Text>
			)}
			{card.draft && (
				<section
					aria-label={decisionText("Draft")}
					className="flex flex-col gap-1"
				>
					<Text as="h3" role="caption" tone="secondary" className="m-0">
						{decisionText("Draft")}
					</Text>
					<blockquote className="m-0 select-text whitespace-pre-wrap rounded-lg border-l-2 border-kumo-line bg-kumo-tint px-3 py-2 type-tedix-body">
						{card.draft}
					</blockquote>
				</section>
			)}
			{rules.length > 0 && (
				<Details summary={decisionText("Details")}>
					{rules.map((rule) => (
						<Text
							key={rule.id}
							as="p"
							role="caption"
							tone="secondary"
							className="m-0"
						>
							<span className="font-medium">{rule.id}</span> {rule.text}
						</Text>
					))}
				</Details>
			)}
		</article>
	);
}

/** The factory's effort and timing chips; nothing when the sheet has neither. */
function FaceChips({ card }: { card: Pick<ReviewCard, "effort" | "timing"> }) {
	if (!card.effort && !card.timing) return null;
	return (
		<span className="flex flex-wrap gap-1.5" data-card-review-chips>
			{card.effort && <Badge variant="outline">{card.effort}</Badge>}
			{card.timing && <Badge variant="outline">{card.timing}</Badge>}
		</span>
	);
}

/** One line naming the factory's top score inputs for this card. */
function RankedFor({ text }: { text: string | null }) {
	if (!text) return null;
	return (
		<Text
			as="p"
			role="caption"
			tone="secondary"
			className="m-0"
			data-card-review-ranked-for
		>
			{decisionText("Why this card")}: {text}
		</Text>
	);
}

function hostOf(link: string): string {
	try {
		return new URL(link).hostname.replace(/^www\./, "");
	} catch {
		return "source";
	}
}

function SourceLine({ text }: { text: string }) {
	const { label, links } = sourceParts(text);
	return (
		<div className="flex min-w-0 flex-col gap-1">
			{label && (
				<Text as="p" role="body" tone="secondary" className="m-0 break-words">
					{label}
				</Text>
			)}
			{links.length > 0 && (
				<div className="flex flex-wrap gap-x-3 gap-y-1">
					{links.map((link, index) => (
						<a
							key={link}
							href={link}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-kumo-link type-tedix-label underline-offset-4 hover:underline"
						>
							Open {hostOf(link)}
							{links.length > 1 ? ` (${index + 1})` : ""}
							<ArrowSquareOut aria-hidden className="size-3.5" />
						</a>
					))}
				</div>
			)}
		</div>
	);
}

function ReasonPicker({
	chips,
	allChips,
	selected,
	onToggle,
	note,
	onNote,
}: {
	chips: { useful: readonly string[]; notUseful: readonly string[] };
	allChips: readonly string[];
	selected: readonly string[];
	onToggle: (chip: string) => void;
	note: string;
	onNote: (value: string) => void;
}) {
	const chip = (value: string) => (
		<Button
			key={value}
			size="sm"
			variant={selected.includes(value) ? "secondary" : "outline"}
			aria-pressed={selected.includes(value)}
			onClick={() => onToggle(value)}
			title={`Key ${allChips.indexOf(value) + 1}`}
			className="rounded-full!"
		>
			{selected.includes(value) && <CheckCircle aria-hidden weight="fill" />}
			{value}
		</Button>
	);
	return (
		<fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
			<legend className="sr-only">Reason (optional)</legend>
			<div className="flex flex-wrap gap-1.5">
				{chips.notUseful.map(chip)}
				{chips.useful.map(chip)}
			</div>
			<Input
				size="sm"
				aria-label="Reason in your words (optional)"
				placeholder="Add a reason (optional)"
				value={note}
				onChange={(event) => onNote(event.target.value)}
				maxLength={300}
			/>
		</fieldset>
	);
}

/** "Stop showing… Why: …" splits into the change and its reason. */
function splitWhy(text: string): { change: string; why: string } {
	const at = text.search(/\bWhy:/);
	if (at <= 0) return { change: text, why: "" };
	return { change: text.slice(0, at).trim(), why: text.slice(at).trim() };
}

function Details({
	summary,
	children,
}: {
	summary: string;
	children: ReactNode;
}) {
	return (
		<FeedDeckDisclosure title={summary} keepMounted={false}>
			<div className="flex flex-col gap-1 pt-1">{children}</div>
		</FeedDeckDisclosure>
	);
}

function PendingRules({
	rules,
	onDecide,
}: {
	rules: readonly PendingRule[];
	onDecide: (rule: PendingRule, status: "accepted" | "rejected") => void;
}) {
	return (
		<section
			aria-label={decisionText("Suggested changes")}
			className="flex flex-col gap-2 rounded-2xl border border-kumo-line bg-kumo-tint p-3"
		>
			<Text as="h3" role="label" tone="strong" className="m-0">
				{rules.length === 1
					? decisionText("Suggested change")
					: decisionText("Suggested changes")}
			</Text>
			{rules.map((rule) => {
				const { change, why } = splitWhy(rule.text);
				return (
					<div key={rule.key} className="flex flex-col gap-2">
						<Text as="p" role="body" className="m-0">
							{change}
						</Text>
						{why && (
							<Text as="p" role="body" tone="secondary" className="m-0">
								{why}
							</Text>
						)}
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" onClick={() => onDecide(rule, "accepted")}>
								{decisionText("Yes, change it")}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => onDecide(rule, "rejected")}
							>
								{decisionText("No, keep as is")}
							</Button>
						</div>
						<Details summary={decisionText("Details")}>
							<Text as="p" role="caption" tone="secondary" className="m-0">
								{rule.sourceLabel} rule {rule.id}
							</Text>
						</Details>
					</div>
				);
			})}
		</section>
	);
}

function CaughtUp({
	reviewed,
	toDo,
	snoozed,
	hasCards,
	undo,
	busy,
	onUndo,
	decided,
	onReopen,
	nextRun,
	hiddenOpen,
	channel,
	onShowAll,
	sheets,
}: {
	reviewed: number;
	toDo: number;
	snoozed: number;
	hasCards: boolean;
	undo: UndoEntry | null;
	busy: boolean;
	onUndo: () => void;
	decided: readonly DecidedEntry[];
	onReopen: (entry: DecidedEntry) => void;
	/** The next factory run, formatted; null when none is due, undefined while unknown. */
	nextRun: string | null | undefined;
	/** Open cards this view filtered out. */
	hiddenOpen: number;
	channel: string | null;
	onShowAll: () => void;
	sheets: readonly (readonly [outputId: string, title: string])[];
}) {
	const summary = [
		reviewed > 0 ? `${reviewed} reviewed` : null,
		toDo > 0 ? `${toDo} to do` : null,
		snoozed > 0 ? `${snoozed} snoozed` : null,
	].filter(Boolean);
	return (
		<div
			role="status"
			data-card-review-done
			className="card-review-card flex flex-col items-center gap-2 rounded-2xl border border-kumo-line bg-kumo-elevated px-4 py-10 text-center"
		>
			<CheckCircle
				aria-hidden
				className="size-10 text-kumo-success"
				weight="fill"
			/>
			<Text as="h3" role="section" className="m-0">
				{hasCards
					? decisionText("All caught up")
					: decisionText("No cards yet")}
			</Text>
			<Text as="p" role="body" tone="secondary" className="m-0">
				{summary.length > 0
					? summary.join(" · ")
					: hasCards
						? decisionText("Every card here has a verdict.")
						: decisionText("New cards appear here after the next factory run.")}
			</Text>
			{nextRun !== undefined && (
				<Text
					as="p"
					role="caption"
					tone="secondary"
					className="m-0"
					data-card-review-next-run
				>
					{nextRun
						? `New cards arrive with the next factory run, ${nextRun}.`
						: "No factory run is scheduled; new cards arrive when one runs."}
				</Text>
			)}
			<UndoButton undo={undo} busy={busy} onUndo={onUndo} />
			{hiddenOpen > 0 && (
				<div data-card-review-filtered className="flex flex-col gap-1">
					<Text as="p" role="body" className="m-0">
						{channel
							? `Showing only ${channel} cards. ${hiddenOpen} more open ${hiddenOpen === 1 ? "card is" : "cards are"} filtered out.`
							: `${hiddenOpen} more open ${hiddenOpen === 1 ? "card is" : "cards are"} not shown here.`}
					</Text>
					<div className="flex flex-wrap justify-center gap-1">
						{channel && (
							<Button size="sm" variant="ghost" onClick={onShowAll}>
								Show all cards
							</Button>
						)}
						{sheets.map(([outputId, title]) => (
							<a
								key={outputId}
								href={`/outputs/${outputId}`}
								className="inline-flex items-center gap-1 text-sm text-kumo-link"
							>
								{`Open ${title}`}
								<ArrowSquareOut aria-hidden className="size-3.5" />
							</a>
						))}
					</div>
				</div>
			)}
			{decided.length > 0 && (
				<section
					aria-label="Decided just now"
					data-card-review-decided
					className="flex w-full flex-col gap-1 pt-2 text-left"
				>
					<Text as="h4" role="label" tone="secondary" className="m-0">
						Decided just now
					</Text>
					{decided.map((entry) => (
						<div
							key={entry.cardKey}
							className="flex min-w-0 items-center justify-between gap-2 border-t border-kumo-line pt-1"
						>
							<span className="flex min-w-0 flex-col">
								<Text as="span" className="truncate">
									{entry.title}
								</Text>
								<Text as="span" role="caption" tone="secondary">
									{entry.label}
								</Text>
							</span>
							<Button
								size="sm"
								variant="ghost"
								className="shrink-0"
								disabled={busy}
								aria-label={`Reopen: ${entry.title}`}
								onClick={() => onReopen(entry)}
							>
								Reopen
							</Button>
						</div>
					))}
				</section>
			)}
		</div>
	);
}
