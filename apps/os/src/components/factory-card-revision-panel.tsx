import { CaretRight } from "@phosphor-icons/react";
import {
	Collapsible,
	CollapsibleTrigger,
	CollapsibleContent,
} from "@/components/kumo/collapsible";
import { useEffect, useState, useContext, useRef } from "react";
import { DecisionAttentionContext } from "./decision-attention-context";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import type { CardReviewSource } from "@tedix/api-contract/schemas/os-card-review";
import {
	cellText,
	columnIndex,
	type ReviewCard,
} from "@tedix/api-contract/utils/card-review";
import {
	credentialCard,
	CARD_SECRET_MESSAGE,
	containsCardSecret,
} from "@tedix/api-contract/utils/card-secrets";
import { Button } from "@/components/kumo/button";
import { Textarea } from "@/components/kumo/textarea";
import { Link } from "@/components/kumo/link";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { cardRevisionDiff } from "@/lib/card-revision-diff";

/** True when the card's draft can be rewritten by its source's writing skill. */
export function canReviseFactoryCard(
	card: ReviewCard,
	source: CardReviewSource,
) {
	return Boolean(
		card.draft &&
		source.columns.draft &&
		source.run &&
		!credentialCard(`${card.action} ${card.draft}`),
	);
}

/**
 * Ask the source's writing skill for a new version of the card's draft, or
 * restore an earlier one. Each round is a new revision of the same sheet.
 */
export async function requestFactoryCardRevision(
	cardKey: string,
	expectedRevision: number,
	change: { instruction?: string; restoreRevision?: number },
) {
	const cardId = `factory:${cardKey}`;
	if (change.restoreRevision)
		return osApi.attention.decideDeckCard({
			decision: {
				kind: "factory_restore",
				cardId,
				expectedRevision,
				restoreRevision: change.restoreRevision,
			},
		});
	const instruction = change.instruction?.trim() ?? "";
	if (containsCardSecret(instruction)) throw new Error(CARD_SECRET_MESSAGE);
	return osApi.attention.decideDeckCard({
		decision: {
			kind: "factory_changes",
			cardId,
			expectedRevision,
			instruction,
		},
	});
}

export function FactoryCardRevisionPanel({
	card,
	source,
	revision,
	onPending,
}: {
	card: ReviewCard;
	source: CardReviewSource;
	revision: number;
	onPending: (pending: boolean) => void;
}) {
	const client = useQueryClient();
	const attention = useContext(DecisionAttentionContext);
	const mountedAt = useRef(Date.now());
	const [open, setOpen] = useState(false);
	const [instruction, setInstruction] = useState("");
	const [optimistic, setOptimistic] = useState(false);
	const history = useInfiniteQuery({
		...osQuery.osWorkspaces.outputs.history.infiniteOptions({
			input: (beforeRevision: number | undefined) => ({
				outputId: card.outputId,
				beforeRevision,
			}),
			initialPageParam: undefined,
			getNextPageParam: (page) => page.nextBeforeRevision ?? undefined,
		}),
		refetchInterval: (query) =>
			!document.hidden &&
			(optimistic || query.state.data?.pages[0]?.pending.length)
				? 2000
				: 120000,
	});
	const pending =
		optimistic ||
		Boolean(
			history.data?.pages[0]?.pending.some(
				(request) => request.cardId === `factory:${card.key}`,
			),
		);
	useEffect(() => {
		onPending(pending);
		return () => onPending(false);
	}, [pending, onPending]);
	const refresh = () =>
		Promise.all([
			client.invalidateQueries({
				queryKey: osQuery.osWorkspaces.outputs.key(),
			}),
			client.invalidateQueries({ queryKey: osQuery.attention.key() }),
		]);
	const mutate = useMutation({
		mutationFn: async (restoreRevision?: number) => {
			if (!restoreRevision) setOptimistic(true);
			const decidedAt = Date.now();
			await requestFactoryCardRevision(card.key, revision, {
				instruction,
				restoreRevision,
			});
			if (!restoreRevision)
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
	const versions = (
		history.data?.pages.flatMap((page) => page.revisions) ?? []
	).flatMap((version) =>
		version.content.kind === "sheet" && source.columns.draft
			? [
					{
						revision: version.revision,
						body: cellText(
							version.content.rows[card.rowIndex]?.[
								columnIndex(version.content.columns, source.columns.draft)
							],
						),
						note: version.note,
					},
				]
			: [],
	);
	const current = versions[0];
	const previous = versions.find((version) => version.body !== current?.body);
	if (
		!card.draft ||
		!source.columns.draft ||
		credentialCard(`${card.action} ${card.draft}`)
	)
		return null;
	return (
		<section className="grid gap-3" aria-label="Card revisions">
			<div className="flex flex-wrap items-center gap-2">
				<Button
					variant="outline"
					disabled={pending || mutate.isPending || !source.run}
					onClick={() => setOpen(!open)}
				>
					Ask for changes
				</Button>
				<span className="text-kumo-subtle">Version {revision}</span>
			</div>
			{pending && (
				<p role="status">
					Revising… Your feedback is saved in Home for this card's writing
					agent. <Link href="/chat">Open Home</Link>
				</p>
			)}
			{open && (
				<div className="grid gap-2">
					<Textarea
						aria-label="What should change?"
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						rows={3}
					/>
					<Button
						className="w-fit"
						disabled={!instruction.trim() || mutate.isPending}
						onClick={() => mutate.mutate(undefined)}
					>
						Request changes
					</Button>
				</div>
			)}
			{previous && current && (
				<Collapsible>
					<CollapsibleTrigger className="group/disclosure">
						<CaretRight
							size={14}
							aria-hidden
							className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
						/>
						What changed
					</CollapsibleTrigger>
					<CollapsibleContent keepMounted>
						<p className="whitespace-pre-wrap break-words">
							{cardRevisionDiff(previous.body, current.body).map(
								([kind, text], index) =>
									kind > 0 ? (
										<ins
											key={index}
											className="rounded bg-kumo-tint px-1 font-medium no-underline"
										>
											{text}
										</ins>
									) : kind < 0 ? (
										<del key={index} className="px-1 text-kumo-subtle">
											{text}
										</del>
									) : (
										<span key={index}>{text}</span>
									),
							)}
						</p>
					</CollapsibleContent>
				</Collapsible>
			)}
			<Collapsible>
				<CollapsibleTrigger className="group/disclosure">
					<CaretRight
						size={14}
						aria-hidden
						className="shrink-0 transition-transform group-data-[panel-open]/disclosure:rotate-90 motion-reduce:transition-none"
					/>
					Version history
				</CollapsibleTrigger>
				<CollapsibleContent keepMounted>
					<div className="grid gap-4 pt-3">
						{versions.map((version) => (
							<article key={version.revision} className="grid gap-2">
								<p>Version {version.revision}</p>
								<p className="whitespace-pre-wrap break-words">
									{version.body}
								</p>
								{version.note && (
									<p className="text-kumo-subtle">{version.note}</p>
								)}
								{version.revision !== revision && (
									<Button
										variant="outline"
										className="w-fit"
										disabled={pending || mutate.isPending}
										onClick={() => mutate.mutate(version.revision)}
									>
										Restore version {version.revision}
									</Button>
								)}
							</article>
						))}
					</div>
					{history.hasNextPage && (
						<Button
							variant="ghost"
							onClick={() => void history.fetchNextPage()}
						>
							Load older versions
						</Button>
					)}
				</CollapsibleContent>
			</Collapsible>
			{(mutate.error || history.error) && (
				<p role="alert">{(mutate.error || history.error)?.message}</p>
			)}
		</section>
	);
}
