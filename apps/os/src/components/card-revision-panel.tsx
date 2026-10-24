import { useState, useEffect, useContext, useRef, type RefObject } from "react";
import { DecisionAttentionContext } from "./decision-attention-context";
import {
	useMutation,
	useInfiniteQuery,
	useQueryClient,
} from "@tanstack/react-query";
import {
	cardRevisionDiff,
	cardRevisionHunks,
	keepOriginalHunks,
	proposalRevisionHunks,
	keepOriginalProposalHunks,
	proposalRevisionBody,
} from "@/lib/card-revision-diff";
import { DecisionContextSection } from "@/components/decision-context-rail";
import { CaretRight } from "@phosphor-icons/react";

import { Button } from "@/components/kumo/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/kumo/collapsible";
import { OS_COPY } from "@/shared/os-copy";
import { Input } from "@/components/kumo/input";
import { createPortal } from "react-dom";
import type { CardFeedbackAnchor } from "@tedix/api-contract/schemas/card-revisions";
import { osApi } from "@/lib/api";
import { osQuery, workAttentionQueryOptions } from "@/lib/os-query-options";
import { workRefreshOptions } from "@/lib/work-refresh";
import {
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";

export interface CardRevisionTarget {
	requestId: string;
	version: number;
}

export function CardRevisionPanel({
	target,
	disabled = false,
	onRevising,
	cardRef,
	onOpen,
	contentKind = "text",
	agentName = "owning agent",
}: {
	target: CardRevisionTarget;
	disabled?: boolean;
	onRevising?: (pending: boolean) => void;
	cardRef?: RefObject<HTMLElement | null>;
	onOpen?: () => void;
	contentKind?: "email" | "plan" | "text";
	agentName?: string;
}) {
	const client = useQueryClient();
	const attention = useContext(DecisionAttentionContext);
	const mountedAt = useRef(Date.now());
	const [open, setOpen] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [optimistic, setOptimistic] = useState(false);
	const panel = useRef<HTMLElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const [focusRequest, setFocusRequest] = useState(0);
	useEffect(() => {
		if (!focusRequest) return;
		// Native key handlers can reach a frame before React mounts the input.
		const frame = requestAnimationFrame(() => input.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [focusRequest]);
	const [anchors, setAnchors] = useState<CardFeedbackAnchor[]>([]);
	const [chips, setChips] = useState<string[]>([]);
	const [selection, setSelection] = useState<{
		anchor: CardFeedbackAnchor;
		top: number;
		left: number;
	} | null>(null);
	const [comment, setComment] = useState("");
	const selectionDialog = useRef<HTMLDivElement>(null);
	const selectionReturnFocus = useRef<HTMLElement | null>(null);
	const field = contentKind === "plan" ? "plan" : "draft";
	const options = OS_COPY.cardRevisionChips[contentKind];
	const selectionOpen = selection !== null;
	useEffect(() => {
		if (selectionOpen)
			selectionReturnFocus.current =
				document.activeElement instanceof HTMLElement
					? document.activeElement
					: null;
		const frame = requestAnimationFrame(() => {
			if (selectionOpen) {
				selectionDialog.current?.focus();
				return;
			}
			selectionReturnFocus.current?.focus();
			selectionReturnFocus.current = null;
		});
		return () => cancelAnimationFrame(frame);
	}, [selectionOpen]);
	const addComment = (chip?: string) => {
		if (!selection || (!chip && !comment.trim()) || anchors.length >= 20)
			return;
		setAnchors([
			...anchors,
			{ ...selection.anchor, ...(chip ? { chip } : { note: comment.trim() }) },
		]);
		setSelection(null);
		window.getSelection()?.removeAllRanges();
		setComment("");
		setOpen(true);
		onOpen?.();
	};

	const history = useInfiniteQuery({
		...osQuery.workInteractions.cardHistory.infiniteOptions({
			input: (beforeRevision: number | undefined) => ({
				requestId: target.requestId,
				beforeRevision,
			}),
			initialPageParam: undefined,
			getNextPageParam: (page) => page.nextBeforeRevision ?? undefined,
		}),
		...workRefreshOptions,
		refetchInterval: (query) =>
			!document.hidden && query.state.data?.pages[0]?.pending ? 2000 : 120000,
	});
	useEffect(() => {
		const card =
			cardRef?.current ?? panel.current?.parentElement?.closest("section");
		if (!card) return;
		const select = () => {
			if (disabled || optimistic || history.data?.pages[0]?.pending) return;
			const selected = window.getSelection();
			if (!selected || selected.isCollapsed || !selected.rangeCount) return;
			const range = selected.getRangeAt(0);
			const content = card.querySelector("[data-card-feedback-content]");
			if (!content?.contains(range.commonAncestorContainer)) return;
			const quote = selected.toString();
			if (!quote.trim() || quote.length > 8000) return;
			const before = range.cloneRange();
			before.selectNodeContents(content);
			before.setEnd(range.startContainer, range.startOffset);
			const after = range.cloneRange();
			after.selectNodeContents(content);
			after.setStart(range.endContainer, range.endOffset);
			const rect = range.getBoundingClientRect();
			setSelection({
				anchor: {
					quote,
					prefix: before.toString().slice(-200),
					suffix: after.toString().slice(0, 200),
					field,
				},
				top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 200)),
				left: Math.max(16, Math.min(rect.left, window.innerWidth - 336)),
			});
		};
		const keyboard = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				window.getSelection()?.removeAllRanges();
				setSelection(null);
				return;
			}
			if (
				event.key.toLowerCase() !== "c" ||
				event.ctrlKey ||
				event.metaKey ||
				event.altKey ||
				disabled ||
				optimistic ||
				history.data?.pages[0]?.pending ||
				(event.target as Element).closest(
					"input,textarea,button,a,[contenteditable=true]",
				)
			)
				return;
			event.preventDefault();
			setOpen(true);
			onOpen?.();
			setFocusRequest((request) => request + 1);
		};
		card.addEventListener("mouseup", select);
		card.addEventListener("keyup", select);
		card.addEventListener("keydown", keyboard);
		const touchSelection = window.matchMedia("(pointer: coarse)").matches;
		if (touchSelection) document.addEventListener("selectionchange", select);
		return () => {
			card.removeEventListener("mouseup", select);
			card.removeEventListener("keyup", select);
			card.removeEventListener("keydown", keyboard);
			if (touchSelection)
				document.removeEventListener("selectionchange", select);
		};
	}, [disabled, optimistic, field, history.data, cardRef, onOpen]);
	const revisions = (
		history.data?.pages.flatMap((page) => page.revisions) ?? []
	).sort((a, b) => a.revision - b.revision);
	const current = revisions.at(-1);
	const keptHunks = current?.keptHunks ?? [];
	const reviewed = keptHunks.length
		? revisions.find(
				(revision) => revision.revision === keptHunks[0]!.fromRevision,
			)
		: current;
	const previous = revisions.find(
		(revision) => revision.revision === (reviewed?.revision ?? 0) - 1,
	);
	const hunks =
		reviewed && previous
			? reviewed.proposal && previous.proposal
				? proposalRevisionHunks(previous.proposal, reviewed.proposal)
				: cardRevisionHunks(previous.body, reviewed.body)
			: [];
	const [showClean, setShowClean] = useState(false);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [compareBefore, setCompareBefore] = useState<number>();
	const [compareAfter, setCompareAfter] = useState<number>();
	const left =
		revisions.find((revision) => revision.revision === compareBefore) ??
		revisions.at(-2);
	const right =
		revisions.find((revision) => revision.revision === compareAfter) ?? current;
	const comparison =
		left && right ? cardRevisionDiff(left.body, right.body) : [];

	const revising = Boolean(history.data?.pages[0]?.pending) || optimistic;
	useEffect(() => {
		if (current && current.revision > 1)
			void client.invalidateQueries({
				queryKey: osQuery.workInteractions.key({ type: "query" }),
			});
	}, [current?.id, client]);
	useEffect(() => {
		onRevising?.(revising);
		return () => onRevising?.(false);
	}, [revising, onRevising]);
	const refresh = () =>
		Promise.all([
			client.invalidateQueries({ queryKey: osQuery.workInteractions.key() }),
			client.invalidateQueries({ queryKey: osQuery.attention.key() }),
			client.invalidateQueries({ queryKey: osQuery.learningFeedback.key() }),
			client.invalidateQueries(workAttentionQueryOptions()),
		]);
	const changes = useMutation({
		mutationFn: async () => {
			if (containsCardSecret([instruction, anchors, chips]))
				throw new Error(CARD_SECRET_MESSAGE);
			setOptimistic(true);
			const decidedAt = Date.now();
			await osApi.workInteractions.requestCardChanges({
				requestId: target.requestId,
				expectedRequestVersion: target.version,
				instruction:
					instruction.trim() ||
					chips.join(", ") ||
					"Revise the quoted passages using the attached comments.",
				field,
				chips,
				anchors,
			});
			attention?.({
				action: "request_changes",
				intent: "change",
				signal: "edited",
				decidedAt,
				elapsedMs: decidedAt - mountedAt.current,
			});
		},
		onSuccess: async () => {
			setOpen(false);
			setInstruction("");
			setAnchors([]);
			setChips([]);
			setSelection(null);
			await refresh();
			setOptimistic(false);
		},
		onError: () => setOptimistic(false),
	});
	const rules = history.data?.pages[0]?.styleRules ?? [];
	const [justThisRevision, setJustThisRevision] = useState<number>();
	const remember = useMutation({
		mutationFn: () =>
			osApi.workInteractions.rememberCardStyle({
				requestId: target.requestId,
				expectedRevision: current!.revision,
				contentKind,
			}),
		onSuccess: refresh,
	});
	const reviewRule = useMutation({
		mutationFn: (input: { ruleId: string; decision: "keep" | "not_true" }) =>
			osApi.workInteractions.reviewCardStyleRule({
				requestId: target.requestId,
				...input,
			}),
		onSuccess: refresh,
	});
	const restore = useMutation({
		mutationFn: (revision: number) =>
			osApi.workInteractions.reviseCard({
				requestId: target.requestId,
				expectedRequestVersion: target.version,
				expectedRevision: current?.revision ?? 0,
				restoreRevision: revision,
			}),
		onSuccess: refresh,
	});
	const keep = useMutation({
		mutationFn: async (index: number) => {
			const hunk = hunks.find((hunk) => hunk.index === index)!;
			const kept = [
				...keptHunks,
				{
					fromRevision: reviewed!.revision,
					index,
					original: hunk.original,
					replacement: hunk.replacement,
				},
			];
			const keptIndexes = kept.map((hunk) => hunk.index);
			const proposal =
				reviewed!.proposal && previous?.proposal
					? keepOriginalProposalHunks(
							previous.proposal,
							reviewed!.proposal,
							keptIndexes,
						)
					: undefined;
			return osApi.workInteractions.reviseCard({
				requestId: target.requestId,
				expectedRequestVersion: target.version,
				expectedRevision: current!.revision,
				body: proposal
					? proposalRevisionBody(proposal)
					: keepOriginalHunks(hunks, keptIndexes),
				proposal,
				keptHunks: kept,
				summary: `Kept original wording in ${kept.length} ${kept.length === 1 ? "change" : "changes"}.`,
			});
		},
		onSuccess: refresh,
	});
	return (
		<section
			ref={panel}
			className="grid min-w-0 gap-3"
			aria-label="Card revisions"
		>
			{selection &&
				createPortal(
					<div
						ref={selectionDialog}
						role="dialog"
						aria-label="Comment on selected text"
						tabIndex={-1}
						className="fixed z-50 grid w-80 max-w-[calc(100vw-32px)] gap-2 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-lg"
						style={{ top: selection.top, left: selection.left }}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								window.getSelection()?.removeAllRanges();
								setSelection(null);
							}
						}}
					>
						<p className="type-tedix-caption line-clamp-2 break-words">
							“{selection.anchor.quote}”
						</p>
						<div className="flex flex-wrap gap-2">
							{options.map((chip) => (
								<Button
									key={chip}
									variant="outline"
									size="sm"
									onClick={() => addComment(chip)}
								>
									{chip}
								</Button>
							))}
						</div>
						<Input
							aria-label="Comment on selection"
							placeholder="Comment…"
							value={comment}
							onChange={(event) => setComment(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && comment.trim()) {
									event.preventDefault();
									addComment();
								}
							}}
						/>
						<div className="flex gap-2">
							<Button
								size="sm"
								disabled={!comment.trim() || anchors.length >= 20}
								onClick={() => addComment()}
							>
								Add comment
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={() => setSelection(null)}
							>
								Close
							</Button>
						</div>
					</div>,
					document.body,
				)}
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					disabled={disabled || changes.isPending || revising}
					onClick={() => setOpen(!open)}
				>
					Ask for changes
				</Button>
				{current && (
					<span className="text-kumo-subtle">Version {current.revision}</span>
				)}
				{revising && (
					<p role="status">
						Revising… Your feedback goes to the agent that owns this card.
					</p>
				)}
				{!revising && history.data?.pages[0]?.stalled && (
					<p role="status">
						The agent that owns this card has not applied your last change
						request. Decide on this version or ask again.
					</p>
				)}
			</div>
			{open && (
				<div className="grid gap-2">
					<ol className="grid gap-2" aria-label="Comments to send">
						{anchors.map((anchor, index) => (
							<li
								key={index}
								className="rounded-lg border border-kumo-line p-3"
							>
								<p className="type-tedix-caption break-words">
									{index + 1}. “{anchor.quote}”
								</p>
								<div className="flex items-center justify-between gap-2">
									<span>{anchor.chip ?? anchor.note}</span>
									<Button
										variant="ghost"
										size="sm"
										aria-label={`Remove comment ${index + 1}`}
										onClick={() =>
											setAnchors(anchors.filter((_, i) => i !== index))
										}
									>
										Remove
									</Button>
								</div>
							</li>
						))}
					</ol>
					<div className="flex flex-wrap gap-2" aria-label="Suggested changes">
						{options.map((chip) => (
							<Button
								key={chip}
								variant={chips.includes(chip) ? "secondary" : "outline"}
								aria-pressed={chips.includes(chip)}
								disabled={changes.isPending}
								onClick={() =>
									setChips(
										chips.includes(chip)
											? chips.filter((value) => value !== chip)
											: [...chips, chip],
									)
								}
							>
								{chip}
							</Button>
						))}
					</div>
					<Input
						ref={input}
						aria-label="What should change?"
						placeholder="What should change?"
						value={instruction}
						disabled={changes.isPending}
						onChange={(event) => setInstruction(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								(event.metaKey || event.ctrlKey) &&
								(instruction.trim() || anchors.length || chips.length) &&
								!changes.isPending
							) {
								event.preventDefault();
								changes.mutate();
							}
						}}
					/>
					<div className="flex gap-2">
						<Button
							disabled={
								(!instruction.trim() && !anchors.length && !chips.length) ||
								changes.isPending
							}
							onClick={() => changes.mutate()}
						>
							Send to {agentName}
						</Button>
						<Button
							variant="ghost"
							disabled={changes.isPending}
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{previous && current && reviewed && (
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure w-full px-0">
						What changed
						<CaretRight
							size={14}
							aria-hidden
							className="ml-auto shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						{reviewed.summary && <p className="py-2">{reviewed.summary}</p>}
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowClean(!showClean)}
						>
							{showClean ? "Show changes" : "Show clean"}
						</Button>
						<div
							className="whitespace-pre-wrap break-words"
							aria-label="Revision diff"
						>
							{showClean
								? current.body
								: hunks.map((hunk) =>
										hunk.unchanged ? (
											<span key={hunk.index}>{hunk.replacement}</span>
										) : (
											<span
												key={hunk.index}
												className="block rounded-lg border border-kumo-line p-3"
											>
												{keptHunks.some((kept) => kept.index === hunk.index) ? (
													<span>
														{hunk.original}
														<span className="type-tedix-caption text-kumo-subtle">
															{" "}
															(Original kept)
														</span>
													</span>
												) : (
													<>
														{cardRevisionDiff(
															hunk.original,
															hunk.replacement,
														).map(([kind, text], index) =>
															kind < 0 ? (
																<del
																	key={index}
																	className="px-1 text-kumo-subtle"
																>
																	{text}
																</del>
															) : kind > 0 ? (
																<ins
																	key={index}
																	className="rounded bg-kumo-tint px-1 font-medium no-underline"
																>
																	{text}
																</ins>
															) : (
																<span key={index}>{text}</span>
															),
														)}
														{hunk.canKeep !== false &&
															(!current.proposal || previous.proposal) && (
																<Button
																	variant="ghost"
																	size="xs"
																	aria-label={`Keep original change ${hunk.index + 1}`}
																	disabled={
																		disabled ||
																		revising ||
																		keep.isPending ||
																		restore.isPending
																	}
																	onClick={() => keep.mutate(hunk.index)}
																>
																	Keep original
																</Button>
															)}
													</>
												)}
											</span>
										),
									)}
						</div>
						{reviewed.anchors?.length ? (
							<ol className="grid gap-2 pt-3" aria-label="Comment results">
								{reviewed.anchors.map((anchor, index) => {
									const resolution = reviewed.anchorsResolved?.find(
										(item) => item.index === index,
									);
									return (
										<li
											key={index}
											className={
												resolution?.status === "done"
													? "text-kumo-subtle"
													: "text-kumo-default"
											}
										>
											{index + 1}. {anchor.chip ?? anchor.note} —{" "}
											{resolution?.status === "done"
												? "Done"
												: resolution?.status === "kept"
													? "Kept"
													: "Still open"}
											{resolution?.note ? `: ${resolution.note}` : ""}
										</li>
									);
								})}
							</ol>
						) : null}
					</CollapsibleContent>
				</Collapsible>
			)}
			{current &&
				current.revision > 1 &&
				previous &&
				current.body !== previous.body &&
				!revising &&
				justThisRevision !== current.revision &&
				!rules.some(
					(rule) =>
						rule.sourceRequestId === target.requestId &&
						rule.sourceRevision === current.revision,
				) && (
					<div className="grid gap-2 type-tedix-caption">
						<p>Always do it this way?</p>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								disabled={disabled || remember.isPending}
								onClick={() => remember.mutate()}
							>
								{contentKind === "email"
									? "Yes, for all emails"
									: contentKind === "plan"
										? "Yes, for all plans"
										: "Yes, for written cards"}
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={() => setJustThisRevision(current.revision)}
							>
								Just this one
							</Button>
						</div>
					</div>
				)}
			{rules.length > 0 && (
				<DecisionContextSection title="Your writing rules" sectionId="why">
					<ul className="grid gap-3">
						{rules.map((rule) => (
							<li key={rule.id} className="grid gap-2">
								<p>{rule.text}</p>
								<div className="flex gap-2">
									<Button
										variant="ghost"
										size="sm"
										disabled={disabled || reviewRule.isPending}
										onClick={() =>
											reviewRule.mutate({
												ruleId: rule.id,
												decision: "not_true",
											})
										}
									>
										Not true
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={disabled || reviewRule.isPending}
										onClick={() =>
											reviewRule.mutate({ ruleId: rule.id, decision: "keep" })
										}
									>
										Keep
									</Button>
								</div>
							</li>
						))}
					</ul>
				</DecisionContextSection>
			)}
			{revisions.length > 0 && (
				<DecisionContextSection
					title="Versions"
					sectionId="why"
					trigger
					defaultOpen
				>
					<Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
						<CollapsibleTrigger className="group/disclosure w-full px-0">
							Version history
							<CaretRight
								size={14}
								aria-hidden
								className="ml-auto shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
							/>
						</CollapsibleTrigger>
						<CollapsibleContent keepMounted>
							{left && right && (
								<div className="grid min-w-0 gap-3 pt-3">
									<div className="grid grid-cols-2 gap-2">
										<label className="grid min-w-0 gap-2 type-tedix-control">
											From version
											<Input
												type="number"
												min={revisions[0]!.revision}
												max={current!.revision}
												value={left.revision}
												aria-label="Compare from version"
												onChange={(event) =>
													setCompareBefore(Number(event.target.value))
												}
											/>
										</label>
										<label className="grid min-w-0 gap-2 type-tedix-control">
											To version
											<Input
												type="number"
												min={revisions[0]!.revision}
												max={current!.revision}
												value={right.revision}
												aria-label="Compare to version"
												onChange={(event) =>
													setCompareAfter(Number(event.target.value))
												}
											/>
										</label>
									</div>
									<div
										className="grid min-w-0 gap-3 sm:grid-cols-2"
										aria-label="Version comparison"
									>
										<div className="min-w-0 rounded-lg border border-kumo-line p-3">
											<h4 className="type-tedix-control mb-3">
												Version {left.revision}
											</h4>
											<p className="whitespace-pre-wrap break-words">
												{comparison
													.filter(([kind]) => kind <= 0)
													.map(([kind, text], index) =>
														kind < 0 ? (
															<del key={index} className="text-kumo-subtle">
																{text}
															</del>
														) : (
															<span key={index}>{text}</span>
														),
													)}
											</p>
										</div>
										<div className="min-w-0 rounded-lg border border-kumo-line p-3">
											<h4 className="type-tedix-control mb-3">
												Version {right.revision}
											</h4>
											<p className="whitespace-pre-wrap break-words">
												{comparison
													.filter(([kind]) => kind >= 0)
													.map(([kind, text], index) =>
														kind > 0 ? (
															<ins
																key={index}
																className="rounded bg-kumo-tint font-medium no-underline"
															>
																{text}
															</ins>
														) : (
															<span key={index}>{text}</span>
														),
													)}
											</p>
										</div>
									</div>
								</div>
							)}

							<div className="grid gap-4 pt-3">
								{[...revisions].reverse().map((revision) => (
									<article key={revision.id} className="grid gap-2">
										<p>
											Version {revision.revision} ·{" "}
											{revision.cause === "agent_rewrite"
												? "Agent rewrite"
												: revision.cause === "human_edit"
													? "Your edit"
													: revision.cause === "restore"
														? "Restored"
														: "Original"}
										</p>
										{revision.instruction && (
											<p className="text-kumo-subtle">
												Requested: {revision.instruction}
											</p>
										)}
										<p className="whitespace-pre-wrap break-words">
											{revision.body}
										</p>
										{revision.proposal && (
											<ul className="grid gap-2">
												{[
													revision.proposal.item,
													...revision.proposal.children,
												].map((item) => (
													<li key={item.sourceIntentId}>
														<strong>{item.title}</strong>
														{item.description && (
															<p className="whitespace-pre-wrap">
																{item.description}
															</p>
														)}
													</li>
												))}
											</ul>
										)}
										{revision.revision !== current?.revision && (
											<Button
												variant="outline"
												className="w-fit"
												disabled={disabled || restore.isPending || revising}
												onClick={() => restore.mutate(revision.revision)}
											>
												Restore version {revision.revision}
											</Button>
										)}
									</article>
								))}
							</div>
						</CollapsibleContent>
					</Collapsible>
					{history.hasNextPage && (
						<Button
							variant="ghost"
							disabled={history.isFetchingNextPage}
							onClick={() => void history.fetchNextPage()}
						>
							Load older versions
						</Button>
					)}
				</DecisionContextSection>
			)}
			{(changes.error ||
				restore.error ||
				keep.error ||
				remember.error ||
				reviewRule.error ||
				history.error) && (
				<p role="alert">
					{
						(
							changes.error ||
							restore.error ||
							keep.error ||
							remember.error ||
							reviewRule.error ||
							history.error
						)?.message
					}
				</p>
			)}
		</section>
	);
}
