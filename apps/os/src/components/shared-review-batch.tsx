import {
	ArrowLeft,
	ArrowRight,
	ArrowSquareOut,
	CheckCircle,
	Circle,
	PencilSimple,
} from "@phosphor-icons/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import type {
	OsReviewBatch,
	OsReviewFeedback,
} from "@tedix/api-contract/contracts/os-shares";
import { Alert, AlertDescription, AlertTitle } from "@/components/kumo/alert";
import { Badge } from "@/components/kumo/badge";
import { Button } from "@/components/kumo/button";
import { Input } from "@/components/kumo/input";
import { Progress } from "@/components/kumo/progress";
import { SegmentedControl } from "@/components/kumo/segmented-control";
import { Textarea } from "@/components/kumo/textarea";
import { cn } from "@/lib/utils";

type Card = OsReviewBatch["cards"][number];
type Decision = OsReviewFeedback["decision"];
type Saved = {
	decision: Decision;
	reply: string;
	reason: string;
	revision: number;
	updatedAt: string | null;
};
type SaveState =
	| "idle"
	| "saving"
	| "saved"
	| "conflict"
	| "newRound"
	| "error";
type Draft = Saved & { save: SaveState };

// Plain-language reviewer choices. The stored values stay the contract enum;
// "ready" is a review opinion and never means anything was posted.
const DECISIONS = [
	{ value: "needs_checking", label: "Not sure yet" },
	{ value: "edit", label: "Use with changes" },
	{ value: "ready", label: "Looks good" },
	{ value: "skip", label: "Skip" },
] as const satisfies readonly { value: Decision; label: string }[];
const DECISION_LABEL = Object.fromEntries(
	DECISIONS.map((d) => [d.value, d.label]),
) as Record<Decision, string>;

type Filter = "all" | "open" | "done";

/**
 * A card's rationale may open with a short verdict sentence ("Skip. …").
 * Showing it as its own badge keeps the recommendation visibly separate from
 * effort; the stored rationale is left untouched.
 */
export function splitRecommendation(relevance: string): {
	recommendation: string | null;
	rationale: string;
} {
	const match = /^\s*([A-Za-z][A-Za-z -]{1,30}?)\.\s+/.exec(relevance);
	if (!match || match[1]!.trim().split(/\s+/).length > 3)
		return { recommendation: null, rationale: relevance };
	return {
		recommendation: match[1]!.trim(),
		rationale: relevance.slice(match[0].length),
	};
}

function recommendationVariant(label: string) {
	const value = label.toLowerCase();
	if (/\b(skip|avoid|reject)/.test(value)) return "error" as const;
	if (/deprioriti|later|low priority/.test(value)) return "warning" as const;
	if (/check|unclear|verify/.test(value)) return "info" as const;
	return "success" as const;
}

const EFFORT_VARIANT = {
	low: "success",
	medium: "warning",
	high: "error",
} as const;

function savedFrom(card: Card, feedback: OsReviewFeedback | undefined): Saved {
	return {
		decision: feedback?.decision ?? "needs_checking",
		reply: feedback?.editedReply ?? card.draft,
		reason: feedback?.reason ?? "",
		revision: feedback?.revision ?? 0,
		updatedAt: feedback?.updatedAt ?? null,
	};
}

function isDirty(draft: Draft, saved: Saved) {
	return (
		draft.decision !== saved.decision ||
		draft.reply !== saved.reply ||
		draft.reason !== saved.reason
	);
}

/** Reviewed means a saved decision other than "not sure yet". */
function isReviewed(saved: Saved) {
	return saved.revision > 0 && saved.decision !== "needs_checking";
}

/** The link moved on to a newer round while this one was open. */
function isNewRound(error: unknown) {
	return (
		isConflict(error) &&
		/newer review round/i.test(String((error as { message?: unknown }).message))
	);
}

function isConflict(error: unknown) {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { code?: unknown }).code === "CONFLICT"
	);
}

type ReviewData = {
	batch: OsReviewBatch | null;
	feedback: OsReviewFeedback[];
};
type FeedbackInput = {
	batchId: string;
	cardId: string;
	expectedRevision: number;
	decision: Decision;
	editedReply: string;
	reason: string;
};
/**
 * Where one review is read from and saved to. A share recipient and a
 * workspace member reach the same batch and the same per-reviewer feedback
 * record through different authorized entry points; the UI is identical.
 */
export type ReviewSource = {
	key: string;
	load: () => Promise<ReviewData>;
	save: (input: FeedbackInput) => Promise<{ feedback: OsReviewFeedback }>;
};

function shareReviewSource(
	shareId: string,
	sessionToken: string,
): ReviewSource {
	return {
		key: `share:${shareId}:${sessionToken}`,
		load: async () =>
			(await import("@/lib/api")).osApi.osShares.reviews.get({
				shareId,
				sessionToken,
			}),
		save: async (input) =>
			(await import("@/lib/api")).osApi.osShares.reviews.saveFeedback({
				shareId,
				sessionToken,
				...input,
			}),
	};
}

function workspaceReviewSource(
	workspaceId: string,
	gadgetId: string,
): ReviewSource {
	return {
		key: `workspace:${workspaceId}:${gadgetId}`,
		load: async () =>
			(await import("@/lib/api")).osApi.osShares.reviews.getForGadget({
				workspaceId,
				gadgetId,
			}),
		save: async (input) =>
			(await import("@/lib/api")).osApi.osShares.reviews.saveGadgetFeedback({
				workspaceId,
				gadgetId,
				...input,
			}),
	};
}

function useReviewData(source: ReviewSource) {
	const [data, setData] = useState<ReviewData | null>(null);
	const [failed, setFailed] = useState(false);
	const { key, load } = source;
	useEffect(() => {
		setData(null);
		setFailed(false);
		let alive = true;
		load().then(
			(value) => {
				if (alive) setData(value);
			},
			() => {
				if (alive) setFailed(true);
			},
		);
		return () => {
			alive = false;
		};
	}, [key, load]);
	return { data, failed };
}

export function SharedReviewBatch({
	shareId,
	sessionToken,
	fallback,
}: {
	shareId: string;
	sessionToken: string;
	fallback: ReactNode;
}) {
	const source = useMemo(
		() => shareReviewSource(shareId, sessionToken),
		[shareId, sessionToken],
	);
	const { data, failed } = useReviewData(source);
	if (failed)
		return (
			<Alert variant="warning">
				<AlertTitle>Review unavailable</AlertTitle>
				<AlertDescription>
					This review cannot be opened. Check your access or ask for a new link.
				</AlertDescription>
			</Alert>
		);
	if (!data) return <p role="status">Opening review…</p>;
	if (!data.batch) return fallback;
	return (
		<ReviewApp
			// A new batch never inherits another batch's local edits.
			key={data.batch.id}
			batch={data.batch}
			feedback={data.feedback}
			source={source}
		/>
	);
}

type WorkspaceView = "review" | "gadget";

/**
 * The workspace entry point to the same review. When the gadget's active
 * review link binds a batch, members review it here with the shared UI; the
 * gadget's own app stays one click away. Without a bound batch, or when the
 * review cannot be read, the gadget renders exactly as before.
 */
export function WorkspaceGadgetReview({
	workspaceId,
	gadgetId,
	gadget,
}: {
	workspaceId: string;
	gadgetId: string;
	gadget: ReactNode;
}) {
	const source = useMemo(
		() => workspaceReviewSource(workspaceId, gadgetId),
		[workspaceId, gadgetId],
	);
	const { data } = useReviewData(source);
	const [view, setView] = useState<WorkspaceView>("review");
	if (!data?.batch) return gadget;
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<SegmentedControl<WorkspaceView>
				ariaLabel="App view"
				compact
				value={view}
				onValueChange={setView}
				options={[
					{ value: "review", label: "Review" },
					{ value: "gadget", label: "Full gadget" },
				]}
			/>
			{view === "review" ? (
				<ReviewApp
					key={data.batch.id}
					batch={data.batch}
					feedback={data.feedback}
					source={source}
				/>
			) : (
				gadget
			)}
		</div>
	);
}

function ReviewApp({
	batch,
	feedback,
	source,
}: {
	batch: OsReviewBatch;
	feedback: OsReviewFeedback[];
	source: ReviewSource;
}) {
	const [saved, setSaved] = useState<Record<string, Saved>>(() =>
		Object.fromEntries(
			batch.cards.map((card) => [
				card.id,
				savedFrom(
					card,
					feedback.find((f) => f.cardId === card.id),
				),
			]),
		),
	);
	const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
		Object.fromEntries(
			Object.entries(saved).map(([id, value]) => [
				id,
				{ ...value, save: "idle" },
			]),
		),
	);
	const [selectedId, setSelectedId] = useState(batch.cards[0]?.id ?? "");
	// Mobile shows the list or one card; desktop always shows both.
	const [mobileDetail, setMobileDetail] = useState(false);
	const [filter, setFilter] = useState<Filter>("all");
	const [recommendationFilter, setRecommendationFilter] = useState("any");

	const recommendations = useMemo(
		() =>
			Object.fromEntries(
				batch.cards.map((card) => [
					card.id,
					splitRecommendation(card.relevance),
				]),
			),
		[batch.cards],
	);
	const recommendationOptions = useMemo(() => {
		const labels = [
			...new Set(
				batch.cards
					.map((card) => recommendations[card.id]?.recommendation)
					.filter((label): label is string => Boolean(label)),
			),
		];
		return labels.length > 1
			? [
					{ value: "any", label: "Any" },
					...labels.map((label) => ({ value: label, label })),
				]
			: [];
	}, [batch.cards, recommendations]);

	const reviewedCount = batch.cards.filter((card) =>
		isReviewed(saved[card.id]!),
	).length;
	const unsavedCount = batch.cards.filter((card) =>
		isDirty(drafts[card.id]!, saved[card.id]!),
	).length;

	const visible = batch.cards.filter((card) => {
		const done = isReviewed(saved[card.id]!);
		if (filter === "open" && done) return false;
		if (filter === "done" && !done) return false;
		if (
			recommendationFilter !== "any" &&
			recommendations[card.id]?.recommendation !== recommendationFilter
		)
			return false;
		return true;
	});
	const selected =
		batch.cards.find((card) => card.id === selectedId) ?? batch.cards[0];

	// Warn before leaving with edits that were never saved.
	useEffect(() => {
		if (unsavedCount === 0) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [unsavedCount]);

	const update = useCallback(
		(cardId: string, patch: Partial<Saved>) =>
			setDrafts((current) => ({
				...current,
				[cardId]: { ...current[cardId]!, ...patch, save: "idle" },
			})),
		[],
	);

	const save = useCallback(
		async (card: Card) => {
			const draft = drafts[card.id]!;
			if (draft.save === "saving") return;
			setDrafts((current) => ({
				...current,
				[card.id]: { ...current[card.id]!, save: "saving" },
			}));
			try {
				const result = await source.save({
					batchId: batch.id,
					cardId: card.id,
					expectedRevision: draft.revision,
					decision: draft.decision,
					editedReply: draft.reply,
					reason: draft.reason,
				});
				const next: Saved = {
					decision: draft.decision,
					reply: draft.reply,
					reason: draft.reason,
					revision: result.feedback.revision,
					updatedAt: result.feedback.updatedAt ?? new Date().toISOString(),
				};
				setSaved((current) => ({ ...current, [card.id]: next }));
				setDrafts((current) => ({
					...current,
					[card.id]: {
						...current[card.id]!,
						revision: next.revision,
						updatedAt: next.updatedAt,
						save: "saved",
					},
				}));
			} catch (error) {
				setDrafts((current) => ({
					...current,
					[card.id]: {
						...current[card.id]!,
						save: isNewRound(error)
							? "newRound"
							: isConflict(error)
								? "conflict"
								: "error",
					},
				}));
			}
		},
		[batch.id, drafts, source],
	);

	// After a conflict, load the latest saved feedback but keep the reviewer's
	// text: saving again is a deliberate choice to replace the newer version.
	const reloadLatest = useCallback(
		async (card: Card) => {
			try {
				const latest = await source.load();
				if (!latest.batch || latest.batch.id !== batch.id) throw new Error();
				const next = savedFrom(
					card,
					latest.feedback.find((f) => f.cardId === card.id),
				);
				setSaved((current) => ({ ...current, [card.id]: next }));
				setDrafts((current) => ({
					...current,
					[card.id]: {
						...current[card.id]!,
						revision: next.revision,
						updatedAt: next.updatedAt,
						save: "idle",
					},
				}));
			} catch {
				setDrafts((current) => ({
					...current,
					[card.id]: { ...current[card.id]!, save: "error" },
				}));
			}
		},
		[batch.id, source],
	);

	const listRef = useRef<HTMLUListElement>(null);
	function focusCard(cardId: string) {
		listRef.current
			?.querySelector<HTMLButtonElement>(
				`[data-card-id="${CSS.escape(cardId)}"]`,
			)
			?.focus();
	}
	function choose(cardId: string) {
		setSelectedId(cardId);
		setMobileDetail(true);
		// Small screens scroll the page; start the opened card at its top.
		if (!window.matchMedia?.("(min-width: 64rem)").matches)
			requestAnimationFrame(() =>
				listRef.current
					?.closest("section")
					?.querySelector("article")
					?.scrollIntoView({ block: "start" }),
			);
	}
	function onListKey(event: KeyboardEvent<HTMLUListElement>) {
		const index = visible.findIndex((card) => card.id === selected?.id);
		const target =
			event.key === "ArrowDown"
				? visible[Math.min(visible.length - 1, index + 1)]
				: event.key === "ArrowUp"
					? visible[Math.max(0, index - 1)]
					: event.key === "Home"
						? visible[0]
						: event.key === "End"
							? visible[visible.length - 1]
							: undefined;
		if (!target) return;
		event.preventDefault();
		setSelectedId(target.id);
		focusCard(target.id);
	}

	const position = selected
		? batch.cards.findIndex((card) => card.id === selected.id)
		: -1;
	const total = batch.cards.length;

	return (
		<section
			aria-label="Review"
			className="flex flex-1 flex-col gap-3 lg:min-h-0"
		>
			<header className="grid shrink-0 gap-2 rounded-xl border border-kumo-line bg-kumo-elevated p-3 sm:p-4">
				<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
					<div className="min-w-0">
						<h2 className="m-0 text-base font-semibold text-kumo-strong sm:text-lg">
							{batch.title}
						</h2>
						<p className="m-0 text-sm text-kumo-subtle max-sm:text-xs">
							Your feedback is saved for the team under your name. Nothing is
							posted anywhere and the source research stays unchanged.
						</p>
					</div>
					<p
						className="m-0 shrink-0 text-sm font-medium text-kumo-default"
						aria-live="polite"
					>
						{reviewedCount} of {total} reviewed
						{unsavedCount > 0 && (
							<span className="text-kumo-warning">
								{" "}
								· {unsavedCount} unsaved
							</span>
						)}
					</p>
				</div>
				<Progress
					value={total === 0 ? 0 : Math.round((reviewedCount / total) * 100)}
					aria-label={`${reviewedCount} of ${total} reviewed`}
				/>
			</header>

			<div className="grid flex-1 gap-3 lg:min-h-0 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
				<nav
					aria-label="Suggestions"
					className={cn(
						"flex-col gap-2 rounded-xl border border-kumo-line bg-kumo-base p-2 lg:min-h-0",
						mobileDetail ? "hidden lg:flex" : "flex",
					)}
				>
					<div className="grid shrink-0 gap-2 px-1 pt-1">
						<SegmentedControl<Filter>
							ariaLabel="Show"
							compact
							value={filter}
							onValueChange={setFilter}
							options={[
								{ value: "all", label: `All ${total}` },
								{ value: "open", label: `To review ${total - reviewedCount}` },
								{ value: "done", label: `Reviewed ${reviewedCount}` },
							]}
						/>
						{recommendationOptions.length > 0 && (
							<div className="grid min-w-0 gap-1">
								<span className="text-xs text-kumo-subtle">Suggested</span>
								<SegmentedControl<string>
									ariaLabel="Filter by suggestion"
									className="w-full flex-wrap"
									compact
									value={recommendationFilter}
									onValueChange={setRecommendationFilter}
									options={recommendationOptions}
								/>
							</div>
						)}
					</div>
					<ul
						ref={listRef}
						className="m-0 grid list-none content-start gap-1 p-0 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain"
						onKeyDown={onListKey}
					>
						{visible.map((card) => {
							const rec = recommendations[card.id]!;
							const draft = drafts[card.id]!;
							const cardSaved = saved[card.id]!;
							const dirty = isDirty(draft, cardSaved);
							const active = card.id === selected?.id;
							return (
								<li key={card.id}>
									<Button
										variant="ghost"
										multiline
										data-card-id={card.id}
										aria-current={active ? "true" : undefined}
										tabIndex={active ? 0 : -1}
										onClick={() => choose(card.id)}
										className={cn(
											"grid h-auto w-full justify-stretch gap-1.5 border px-3 py-2.5 text-left font-normal",
											active
												? "border-kumo-brand bg-kumo-tint"
												: "border-transparent",
										)}
									>
										<span className="flex items-start gap-2">
											<StatusIcon saved={cardSaved} dirty={dirty} />
											<span className="min-w-0 flex-1 text-sm font-medium text-kumo-default">
												{card.title}
											</span>
										</span>
										<span className="flex flex-wrap gap-1 pl-6">
											{rec.recommendation && (
												<Badge
													variant={recommendationVariant(rec.recommendation)}
												>
													{rec.recommendation}
												</Badge>
											)}
											<Badge variant={EFFORT_VARIANT[card.effort]}>
												{card.effort} effort
											</Badge>
										</span>
										<span className="pl-6 text-xs text-kumo-subtle">
											{dirty
												? "Unsaved changes"
												: cardSaved.revision > 0
													? `Saved · ${DECISION_LABEL[cardSaved.decision]}`
													: "Not reviewed yet"}
										</span>
									</Button>
								</li>
							);
						})}
						{visible.length === 0 && (
							<li className="p-3 text-sm text-kumo-subtle">
								Nothing matches this filter.
							</li>
						)}
					</ul>
				</nav>

				{selected && (
					<CardDetail
						key={selected.id}
						className={mobileDetail ? "flex" : "hidden lg:flex"}
						card={selected}
						recommendation={recommendations[selected.id]!}
						draft={drafts[selected.id]!}
						saved={saved[selected.id]!}
						position={position}
						total={total}
						onBack={() => {
							setMobileDetail(false);
							requestAnimationFrame(() => focusCard(selected.id));
						}}
						onStep={(delta) => {
							const next = batch.cards[position + delta];
							if (next) setSelectedId(next.id);
						}}
						onChange={(patch) => update(selected.id, patch)}
						onSave={() => void save(selected)}
						onReload={() => void reloadLatest(selected)}
					/>
				)}
			</div>
		</section>
	);
}

function StatusIcon({ saved, dirty }: { saved: Saved; dirty: boolean }) {
	if (dirty)
		return (
			<PencilSimple
				aria-hidden
				size={16}
				className="mt-0.5 shrink-0 text-kumo-warning"
			/>
		);
	if (isReviewed(saved))
		return (
			<CheckCircle
				aria-hidden
				size={16}
				weight="fill"
				className="mt-0.5 shrink-0 text-kumo-success"
			/>
		);
	return (
		<Circle
			aria-hidden
			size={16}
			className="mt-0.5 shrink-0 text-kumo-subtle"
		/>
	);
}

function CardDetail({
	card,
	recommendation,
	draft,
	saved,
	position,
	total,
	className,
	onBack,
	onStep,
	onChange,
	onSave,
	onReload,
}: {
	card: Card;
	recommendation: { recommendation: string | null; rationale: string };
	draft: Draft;
	saved: Saved;
	position: number;
	total: number;
	className: string;
	onBack: () => void;
	onStep: (delta: number) => void;
	onChange: (patch: Partial<Saved>) => void;
	onSave: () => void;
	onReload: () => void;
}) {
	const busy = draft.save === "saving";
	const dirty = isDirty(draft, saved);
	const upToDate = !dirty && saved.revision > 0;
	const justSaved = draft.save === "saved" && !dirty;
	const savedAt = saved.updatedAt ? new Date(saved.updatedAt) : null;
	const savedTime = savedAt ? savedAt.toLocaleTimeString() : "just now";
	const savedDate = savedAt ? savedAt.toLocaleString() : "earlier";
	const replyChanged = draft.reply !== card.draft;
	return (
		<article
			aria-labelledby={`review-card-${card.id}`}
			className={cn(
				"flex-col rounded-xl border border-kumo-line bg-kumo-base lg:min-h-0 lg:overflow-hidden",
				className,
			)}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "s") {
					event.preventDefault();
					if (!busy && !upToDate) onSave();
				}
			}}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-3 py-2">
				<Button
					variant="ghost"
					size="sm"
					className="lg:hidden"
					onClick={onBack}
				>
					<ArrowLeft size={14} aria-hidden /> All suggestions
				</Button>
				<span className="text-xs text-kumo-subtle max-lg:hidden">
					Suggestion {position + 1} of {total}
				</span>
				<span className="flex items-center gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Previous suggestion"
						disabled={position <= 0}
						onClick={() => onStep(-1)}
					>
						<ArrowLeft size={14} aria-hidden />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Next suggestion"
						disabled={position >= total - 1}
						onClick={() => onStep(1)}
					>
						<ArrowRight size={14} aria-hidden />
					</Button>
				</span>
			</div>

			<div className="grid flex-1 content-start gap-5 p-4 sm:p-5 lg:min-h-0 lg:overflow-y-auto lg:overscroll-contain">
				<header className="grid gap-2">
					<h3
						id={`review-card-${card.id}`}
						className="m-0 text-lg font-semibold text-kumo-strong"
					>
						{card.title}
					</h3>
					<div className="flex flex-wrap items-center gap-1.5">
						{recommendation.recommendation && (
							<Badge
								variant={recommendationVariant(recommendation.recommendation)}
							>
								Suggested: {recommendation.recommendation}
							</Badge>
						)}
						<Badge variant={EFFORT_VARIANT[card.effort]}>
							{card.effort} effort
						</Badge>
						<Badge variant="secondary">
							{saved.revision > 0
								? `Your decision: ${DECISION_LABEL[saved.decision]}`
								: "Not reviewed yet"}
						</Badge>
					</div>
					<a
						className="inline-flex w-fit items-center gap-1 text-sm font-medium text-kumo-link underline-offset-2 hover:underline"
						href={card.url}
						target="_blank"
						rel="noopener noreferrer"
					>
						Open original conversation
						<ArrowSquareOut size={14} aria-hidden />
					</a>
				</header>

				{recommendation.rationale && (
					<section className="grid gap-1">
						<h4 className="m-0 text-sm font-semibold text-kumo-default">
							Why this suggestion
						</h4>
						<p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-kumo-default">
							{recommendation.rationale}
						</p>
						<p className="m-0 text-xs text-kumo-subtle">
							Effort says how much work a reply takes. It does not mean the
							thread is suitable to reply to.
						</p>
					</section>
				)}

				{card.checks.length > 0 && (
					<section className="grid gap-1 rounded-lg bg-kumo-warning-tint p-3">
						<h4 className="m-0 text-sm font-semibold text-kumo-warning">
							Still to check
						</h4>
						<ul className="m-0 grid list-disc gap-1 pl-5 text-sm text-kumo-default">
							{card.checks.map((check, index) => (
								<li key={index}>{check}</li>
							))}
						</ul>
					</section>
				)}

				{card.evidence.length > 0 && (
					<section className="grid gap-1">
						<h4 className="m-0 text-sm font-semibold text-kumo-default">
							Sources
						</h4>
						<ul className="m-0 flex flex-wrap gap-2 p-0">
							{card.evidence.map((source, index) => (
								<li key={index} className="list-none">
									<a
										className="inline-flex items-center gap-1 rounded-md border border-kumo-line px-2 py-1 text-sm text-kumo-link hover:bg-kumo-tint"
										href={source.url}
										target="_blank"
										rel="noopener noreferrer"
									>
										{source.label}
										<ArrowSquareOut size={12} aria-hidden />
									</a>
								</li>
							))}
						</ul>
					</section>
				)}

				<section className="grid gap-2">
					<div className="flex flex-wrap items-baseline justify-between gap-2">
						<label
							htmlFor={`reply-${card.id}`}
							className="text-sm font-semibold text-kumo-default"
						>
							Suggested reply
						</label>
						{replyChanged && (
							<Button
								variant="ghost"
								size="xs"
								disabled={busy}
								onClick={() => onChange({ reply: card.draft })}
							>
								Restore original draft
							</Button>
						)}
					</div>
					<Textarea
						id={`reply-${card.id}`}
						aria-label={`Reply for ${card.title}`}
						rows={6}
						value={draft.reply}
						maxLength={8000}
						disabled={busy}
						placeholder="No draft yet. Write a reply here if one would help."
						onChange={(e) => onChange({ reply: e.target.value })}
					/>
				</section>

				<fieldset className="m-0 grid gap-2 border-0 p-0">
					<legend className="mb-1 p-0 text-sm font-semibold text-kumo-default">
						Your decision
					</legend>
					<div className="flex flex-wrap gap-2">
						{DECISIONS.map(({ value, label }) => (
							<Button
								key={value}
								aria-pressed={draft.decision === value}
								variant={draft.decision === value ? "default" : "outline"}
								size="sm"
								disabled={busy}
								onClick={() => onChange({ decision: value })}
							>
								{label}
							</Button>
						))}
					</div>
					<p className="m-0 text-xs text-kumo-subtle">
						“Looks good” records your opinion only. It does not post anything or
						start any research.
					</p>
				</fieldset>

				<div className="grid gap-2">
					<label
						htmlFor={`reason-${card.id}`}
						className="text-sm font-semibold text-kumo-default"
					>
						Feedback{" "}
						<span className="font-normal text-kumo-subtle">(optional)</span>
					</label>
					<Input
						id={`reason-${card.id}`}
						aria-label={`Feedback for ${card.title}`}
						value={draft.reason}
						maxLength={4000}
						disabled={busy}
						placeholder="One sentence: why, or what to change"
						onChange={(e) => onChange({ reason: e.target.value })}
					/>
				</div>
			</div>

			<footer className="sticky bottom-0 grid shrink-0 gap-2 rounded-b-xl border-t border-kumo-line bg-kumo-elevated px-4 py-3 lg:static">
				{draft.save === "newRound" && (
					<Alert variant="warning">
						<AlertTitle>A new review round is ready</AlertTitle>
						<AlertDescription>
							This link now shows newer suggestions. Copy your text if you need
							it, then reload the page.
						</AlertDescription>
					</Alert>
				)}
				{draft.save === "conflict" && (
					<Alert variant="warning">
						<AlertTitle>Someone saved a newer version</AlertTitle>
						<AlertDescription>
							Your text is still here. Load the latest version, then save again
							if you want to replace it.
							<Button
								className="mt-2"
								variant="secondary"
								size="sm"
								onClick={onReload}
							>
								Load latest version
							</Button>
						</AlertDescription>
					</Alert>
				)}
				{draft.save === "error" && (
					<Alert variant="destructive">
						<AlertTitle>Could not save</AlertTitle>
						<AlertDescription>
							Sharing may have ended or your connection dropped. Copy your text
							before leaving this page, then try again.
						</AlertDescription>
					</Alert>
				)}
				<div className="flex flex-wrap items-center justify-between gap-3">
					<span
						role="status"
						className={cn(
							"flex min-w-0 flex-1 items-center gap-1.5 text-sm",
							justSaved
								? "font-medium text-kumo-success"
								: dirty
									? "text-kumo-warning"
									: "text-kumo-subtle",
						)}
					>
						{justSaved && <CheckCircle aria-hidden size={16} weight="fill" />}
						{busy
							? "Saving…"
							: justSaved
								? `Feedback saved at ${savedTime}. Nothing was posted.`
								: dirty
									? "Unsaved changes"
									: saved.revision > 0
										? `Last saved ${savedDate}.`
										: "Not reviewed yet."}
					</span>
					{/* With nothing new to save, the button says so instead of
					    silently saving the same feedback again. */}
					<Button disabled={busy || upToDate} onClick={onSave}>
						{busy ? (
							"Saving…"
						) : upToDate ? (
							<>
								<CheckCircle aria-hidden size={14} weight="fill" /> Saved
							</>
						) : (
							"Save feedback"
						)}
					</Button>
				</div>
			</footer>
		</article>
	);
}
