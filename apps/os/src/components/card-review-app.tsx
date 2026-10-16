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
import type { CardReviewConfig } from "@tedix/api-contract/schemas/os-card-review";
import type { OsOutputContent } from "@tedix/api-contract/schemas/os-workspaces";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
	type KeyboardEvent,
	type PointerEvent,
	useCallback,
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
import { Input } from "@/components/kumo/input";
import { Kbd } from "@/components/kumo/kbd";
import { Progress } from "@/components/kumo/progress";
import { Text } from "@/components/kumo/text";
import { toast } from "@/components/kumo/toast";
import { osApi } from "@/lib/api";
import {
	cardSheetsForSource,
	cardsFromSheet,
	columnIndex,
	formatReason,
	type MissingColumns,
	pendingRules,
	type PendingRule,
	reasonChips,
	type ReviewCard,
	reviewQueue,
	rowWrite,
	ruleTextById,
	type SheetBody,
	snoozeUntil,
	sourceParts,
	type Verdict,
	verdictCells,
} from "@/lib/card-review";
import {
	canvasOutputsQueryOptions,
	outputDetailQueryOptions,
} from "@/lib/os-query-options";
import { cn } from "@/lib/utils";
import { useAppWebMcpTools } from "@/lib/webmcp/use-app-webmcp-tools";

type Cell = string | number | boolean | null;
type SheetState = { body: SheetBody; revision: number };

const SNOOZE_STORAGE_KEY = "tedix.cardReview.snoozes";
const SWIPE_THRESHOLD = 96;

function readSnoozes(): Record<string, string> {
	try {
		const raw = localStorage.getItem(SNOOZE_STORAGE_KEY);
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

function writeSnoozes(value: Record<string, string>) {
	try {
		localStorage.setItem(SNOOZE_STORAGE_KEY, JSON.stringify(value));
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

function isTypingTarget(target: EventTarget | null) {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.isContentEditable ||
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.tagName === "SELECT"
	);
}

type UndoEntry =
	| {
			kind: "write";
			label: string;
			outputId: string;
			rowIndex: number;
			previous: Record<string, Cell>;
			counted: keyof Tally | null;
	  }
	| { kind: "snooze"; label: string; key: string }
	| { kind: "skip"; label: string; key: string };

type Tally = { useful: number; notUseful: number; doIt: number };

/**
 * The card review app: one factory card at a time, decided by a swipe, a key
 * or a big button, with the verdict written into the card sheet's own cells.
 */
export function CardReviewApp({ config }: { config: CardReviewConfig }) {
	const queryClient = useQueryClient();
	const sources = config.sources;

	const outputLists = useQueries({
		queries: sources.map((source) =>
			canvasOutputsQueryOptions(source.workspaceId),
		),
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
		queries: detailIds.map((id) => outputDetailQueryOptions(id)),
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

	const { cards, missing } = useMemo(() => {
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
		return { cards: all, missing: gaps };
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
	const [snoozes, setSnoozes] = useState<Record<string, string>>(readSnoozes);
	const [now] = useState(() => new Date());
	const queue = useMemo(
		() =>
			reviewQueue(cards, {
				channel: activeChannel,
				snoozes,
				skipped,
				now,
			}),
		[cards, activeChannel, snoozes, skipped, now],
	);
	const inChannel = cards.filter(
		(card) => activeChannel === null || card.channel === activeChannel,
	);
	const card = queue[0] ?? null;
	const source = card ? sources[card.sourceIndex] : undefined;

	const [selectedChips, setSelectedChips] = useState<string[]>([]);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [undo, setUndo] = useState<UndoEntry | null>(null);
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

	const decide = useCallback(
		async (
			verdict: Verdict["kind"],
			reasonOverride?: string,
		): Promise<CardReviewActionResult> => {
			if (!card || !source) return { ok: false, error: "No card is open" };
			if (busy) return { ok: false, error: "The last action is still saving" };
			const reason = reasonOverride ?? formatReason(selectedChips, note);
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
				setTally((t) => ({ ...t, [counted]: t[counted] + 1 }));
				setUndo({
					kind: "write",
					label:
						verdict === "useful"
							? "Marked useful"
							: verdict === "not_useful"
								? "Marked not useful"
								: source.doIt === "copy_and_open"
									? "Draft copied, marked done"
									: "Marked to do",
					outputId: card.outputId,
					rowIndex: card.rowIndex,
					previous,
					counted,
				});
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
		[busy, card, note, selectedChips, source, writeRow],
	);

	const snooze = useCallback((): CardReviewActionResult => {
		if (!card) return { ok: false, error: "No card is open" };
		const next = { ...snoozes, [card.key]: snoozeUntil(new Date()) };
		setSnoozes(next);
		writeSnoozes(next);
		setUndo({ kind: "snooze", label: "Snoozed until tomorrow", key: card.key });
		return { ok: true };
	}, [card, snoozes]);

	const skip = useCallback((): CardReviewActionResult => {
		if (!card) return { ok: false, error: "No card is open" };
		if (queue.length < 2)
			return {
				ok: false,
				error: "This is the last card; there is none to skip to",
			};
		setSkipped((keys) => [...keys.filter((key) => key !== card.key), card.key]);
		setUndo({ kind: "skip", label: "Skipped", key: card.key });
		return { ok: true };
	}, [card, queue.length]);

	const undoLast = useCallback(async (): Promise<CardReviewActionResult> => {
		if (!undo) return { ok: false, error: "There is nothing to undo" };
		if (busy) return { ok: false, error: "The last action is still saving" };
		if (undo.kind === "snooze") {
			const next = { ...snoozes };
			delete next[undo.key];
			setSnoozes(next);
			writeSnoozes(next);
		} else if (undo.kind === "skip") {
			setSkipped((keys) => keys.filter((key) => key !== undo.key));
		} else {
			setBusy(true);
			try {
				await writeRow(
					undo.outputId,
					undo.rowIndex,
					undo.previous,
					"Card review: verdict undone",
				);
				const counted = undo.counted;
				if (counted)
					setTally((t) => ({ ...t, [counted]: Math.max(0, t[counted] - 1) }));
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Try again in a moment.";
				toast.error("Undo failed", { description: message });
				return { ok: false, error: `Undo failed: ${message}` };
			} finally {
				setBusy(false);
			}
		}
		setUndo(null);
		return { ok: true };
	}, [busy, snoozes, undo, writeRow]);

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

	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		rootRef.current?.focus({ preventScroll: true });
	}, []);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (isTypingTarget(event.target)) {
			if (event.key === "Escape") rootRef.current?.focus();
			return;
		}
		const key = event.key.toLowerCase();
		const digit = Number.parseInt(key, 10);
		if (key === "arrowright" || key === "u") void decide("useful");
		else if (key === "arrowleft" || key === "n") void decide("not_useful");
		else if (key === "d") void decide("do_it");
		else if (key === "s") snooze();
		else if (key === "k") skip();
		else if (key === "z") void undoLast();
		else if (digit >= 1 && digit <= allChips.length)
			toggleChip(allChips[digit - 1]!);
		else return;
		event.preventDefault();
	};

	const failed = outputLists.some((q) => q.isError);
	const reviewed = tally.useful + tally.notUseful + tally.doIt;

	return (
		<div
			ref={rootRef}
			tabIndex={-1}
			onKeyDown={onKeyDown}
			data-card-review
			className="mx-auto flex w-full max-w-xl min-w-0 flex-col gap-4 outline-none"
			aria-label="Card review"
		>
			{rules.pending.length > 0 && (
				<PendingRules rules={rules.pending} onDecide={decideRule} />
			)}

			<header className="flex flex-wrap items-center justify-between gap-2">
				{channels.length > 1 ? (
					<div
						className="flex flex-wrap gap-1.5"
						role="group"
						aria-label="Show cards from"
					>
						{[null, ...channels].map((value) => (
							<Button
								key={value ?? "all"}
								size="sm"
								variant={activeChannel === value ? "secondary" : "ghost"}
								aria-pressed={activeChannel === value}
								onClick={() => setChannel(value)}
							>
								{value ?? "All"}
							</Button>
						))}
					</div>
				) : (
					<Text as="span" role="label" tone="secondary">
						{channels[0] ?? sources.map((s) => s.label).join(" · ")}
					</Text>
				)}
				{inChannel.length > 0 && (
					<Text
						as="span"
						role="label"
						tone="secondary"
						aria-live="polite"
						data-card-review-progress
					>
						{queue.length} of {inChannel.length} left
					</Text>
				)}
			</header>
			{inChannel.length > 0 && (
				<Progress
					aria-label="Cards reviewed"
					value={Math.round(
						((inChannel.length - queue.length) / inChannel.length) * 100,
					)}
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

			{failed ? (
				<Alert variant="warning">
					<AlertTitle>Cards are unavailable</AlertTitle>
					<AlertDescription>
						A workspace in this app's settings cannot be read. Check that it
						exists and that you can open it.
					</AlertDescription>
				</Alert>
			) : loading && cards.length === 0 ? (
				<div
					role="status"
					className="h-80 animate-pulse rounded-2xl bg-kumo-fill motion-reduce:animate-none"
				>
					<span className="sr-only">Loading cards…</span>
				</div>
			) : card && source ? (
				<>
					<SwipeCard
						key={card.key}
						card={card}
						ruleText={rules.text.get(card.sourceIndex)}
						onSwipe={(direction) =>
							void decide(direction === "right" ? "useful" : "not_useful")
						}
						disabled={busy}
					/>
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
								disabled={busy}
								onClick={() => void decide("not_useful")}
								aria-keyshortcuts="ArrowLeft"
							>
								Not useful
							</Button>
							<Button
								size="lg"
								variant="outline"
								className="h-14! w-full justify-center"
								icon={<ThumbsUp aria-hidden />}
								disabled={busy}
								onClick={() => void decide("useful")}
								aria-keyshortcuts="ArrowRight"
							>
								Useful
							</Button>
							<Button
								size="lg"
								className="col-span-2 h-14! w-full justify-center"
								icon={<Lightning aria-hidden />}
								disabled={busy}
								onClick={() => void decide("do_it")}
								aria-keyshortcuts="D"
							>
								{source.doItLabel ??
									(source.doIt === "copy_and_open"
										? "Do it: copy draft and open"
										: "Do it")}
							</Button>
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
									Snooze
								</Button>
								<Button
									size="sm"
									variant="ghost"
									icon={<SkipForward aria-hidden />}
									onClick={skip}
									disabled={queue.length < 2}
									aria-keyshortcuts="K"
								>
									Skip
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
						<Kbd>←</Kbd> not useful · <Kbd>→</Kbd> useful · <Kbd>D</Kbd> do it ·{" "}
						<Kbd>S</Kbd> snooze · <Kbd>K</Kbd> skip · <Kbd>1</Kbd>–
						<Kbd>{allChips.length}</Kbd> reasons · <Kbd>Z</Kbd> undo
					</Text>
					{source.doIt === "approve" && (
						<Text
							as="p"
							role="caption"
							tone="secondary"
							className="text-center"
						>
							Do it only marks the card approved. Nothing is sent or changed in
							your mailbox from here.
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
				/>
			)}
		</div>
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
	onSwipe,
	disabled,
}: {
	card: ReviewCard;
	ruleText: Map<string, string> | undefined;
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
					{intent === "useful" ? "Useful" : "Not useful"}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-1.5">
				<Badge variant="secondary">{card.channel}</Badge>
				{card.type && <Badge variant="outline">{card.type}</Badge>}
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

			<section aria-label="Why this card" className="flex flex-col gap-1">
				<Text as="h3" role="caption" tone="secondary" className="m-0">
					Why it matters
				</Text>
				<Text as="p" role="body" className="m-0 whitespace-pre-wrap">
					{card.why}
				</Text>
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
			</section>

			{card.action && (
				<section aria-label="Suggested action" className="flex flex-col gap-1">
					<Text as="h3" role="caption" tone="secondary" className="m-0">
						Suggested action
					</Text>
					<Text as="p" role="body" className="m-0">
						{card.action}
					</Text>
				</section>
			)}
			{card.draft && (
				<section aria-label="Draft" className="flex flex-col gap-1">
					<Text as="h3" role="caption" tone="secondary" className="m-0">
						Draft
					</Text>
					<blockquote className="m-0 select-text whitespace-pre-wrap rounded-lg border-l-2 border-kumo-line bg-kumo-tint px-3 py-2 type-tedix-body">
						{card.draft}
					</blockquote>
				</section>
			)}
		</article>
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

function PendingRules({
	rules,
	onDecide,
}: {
	rules: readonly PendingRule[];
	onDecide: (rule: PendingRule, status: "accepted" | "rejected") => void;
}) {
	return (
		<section
			aria-label="Suggested rule changes"
			className="flex flex-col gap-2 rounded-2xl border border-kumo-line bg-kumo-tint p-3"
		>
			<Text as="h3" role="label" tone="strong" className="m-0">
				{rules.length === 1
					? "1 suggested rule change"
					: `${rules.length} suggested rule changes`}
			</Text>
			{rules.map((rule) => (
				<div key={rule.key} className="flex flex-col gap-2">
					<Text as="p" role="body" className="m-0">
						<span className="font-medium">
							{rule.sourceLabel} {rule.id}
						</span>{" "}
						{rule.text}
					</Text>
					<div className="flex gap-2">
						<Button size="sm" onClick={() => onDecide(rule, "accepted")}>
							Accept
						</Button>
						<Button
							size="sm"
							variant="outline"
							onClick={() => onDecide(rule, "rejected")}
						>
							Reject
						</Button>
					</div>
				</div>
			))}
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
}: {
	reviewed: number;
	toDo: number;
	snoozed: number;
	hasCards: boolean;
	undo: UndoEntry | null;
	busy: boolean;
	onUndo: () => void;
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
				{hasCards ? "All caught up" : "No cards yet"}
			</Text>
			<Text as="p" role="body" tone="secondary" className="m-0">
				{summary.length > 0
					? summary.join(" · ")
					: hasCards
						? "Every card here has a verdict."
						: "New cards appear here after the next factory run."}
			</Text>
			<UndoButton undo={undo} busy={busy} onUndo={onUndo} />
		</div>
	);
}
