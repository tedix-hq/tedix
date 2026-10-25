import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { FocusItem } from "@tedix/api-contract/utils/focus-feed";
import copySpec from "@tedix/api-contract/assets/decision-card-copy.v2.json";
import {
	decisionCardFaceText,
	decisionCardFallbackTitle,
} from "@tedix/api-contract/utils/decision-card-copy";
import { decisionText } from "@/shared/os-copy";
import { FACE_WAIT_MS } from "./deck-presentation-context";
import { useOsFormattingPreferences } from "@/lib/format";
import { absoluteTime, relativeTime } from "@/lib/time";
import { osQuery } from "@/lib/os-query-options";
import { Loader } from "./kumo/loader";
import { Skeleton } from "./kumo/skeleton";
import { Button } from "./kumo/button";
import { Link } from "./kumo/link";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "./kumo/collapsible";

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
		// A writer is still working on a fresh request; pick up its story without
		// a reload. Freshness is read at each poll, not at the last render.
		refetchInterval: (query) => {
			const left = FEED_FACE_FRESH_MS - (Date.now() - Date.parse(item.at));
			return !item.presentation &&
				!query.state.data?.presentation &&
				left > 0 &&
				!slow
				? Math.min(10_000, left)
				: false;
		},
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
