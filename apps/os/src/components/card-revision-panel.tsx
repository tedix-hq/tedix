import { useState, useEffect, useContext, useRef } from "react";
import { DecisionAttentionContext } from "./decision-attention-context";
import {
	useMutation,
	useInfiniteQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { cardRevisionDiff } from "@/lib/card-revision-diff";
import { Button } from "@/components/kumo/button";
import { Textarea } from "@/components/kumo/textarea";
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
}: {
	target: CardRevisionTarget;
	disabled?: boolean;
	onRevising?: (pending: boolean) => void;
}) {
	const client = useQueryClient();
	const attention = useContext(DecisionAttentionContext);
	const mountedAt = useRef(Date.now());
	const [open, setOpen] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [optimistic, setOptimistic] = useState(false);
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
	const revisions = (
		history.data?.pages.flatMap((page) => page.revisions) ?? []
	).sort((a, b) => a.revision - b.revision);
	const current = revisions.at(-1);
	const previous = revisions.at(-2);
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
			if (containsCardSecret(instruction)) throw new Error(CARD_SECRET_MESSAGE);
			setOptimistic(true);
			const decidedAt = Date.now();
			await osApi.workInteractions.requestCardChanges({
				requestId: target.requestId,
				expectedRequestVersion: target.version,
				instruction: instruction.trim(),
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
			await refresh();
			setOptimistic(false);
		},
		onError: () => setOptimistic(false),
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
	return (
		<section className="grid min-w-0 gap-3" aria-label="Card revisions">
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
			</div>
			{open && (
				<div className="grid gap-2">
					<Textarea
						aria-label="What should change?"
						placeholder="Tell the agent what to improve…"
						value={instruction}
						rows={3}
						disabled={changes.isPending}
						onChange={(event) => setInstruction(event.target.value)}
					/>
					<div className="flex gap-2">
						<Button
							disabled={!instruction.trim() || changes.isPending}
							onClick={() => changes.mutate()}
						>
							Request changes
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
			{previous && current && (
				<details>
					<summary>What changed</summary>
					<p className="whitespace-pre-wrap break-words">
						{cardRevisionDiff(previous.body, current.body).map(
							([kind, text], index) =>
								kind === 1 ? (
									<ins
										key={index}
										className="rounded bg-kumo-tint px-1 font-medium no-underline"
									>
										{text}
									</ins>
								) : kind === -1 ? (
									<del key={index} className="px-1 text-kumo-subtle">
										{text}
									</del>
								) : (
									<span key={index}>{text}</span>
								),
						)}
					</p>
				</details>
			)}
			{revisions.length > 0 && (
				<details>
					<summary>Version history</summary>
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
				</details>
			)}
			{history.hasNextPage && (
				<Button
					variant="ghost"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					Load older versions
				</Button>
			)}
			{(changes.error || restore.error || history.error) && (
				<p role="alert">
					{(changes.error || restore.error || history.error)?.message}
				</p>
			)}
		</section>
	);
}
