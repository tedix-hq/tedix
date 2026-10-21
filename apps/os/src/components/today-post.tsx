import { ArrowsClockwise } from "@phosphor-icons/react";
import { LearnedToday } from "@/components/learned-today";
import { WeeklyCardContext } from "@/components/weekly-card-context";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityFeedConfig } from "@tedix/api-contract/schemas/os-activity-feed";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { OS_COPY } from "@/shared/os-copy";
import {
	readToday,
	todayProjectLabel,
	todayProgress,
	todayShortcut,
} from "@/lib/today-digest";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Loader } from "@/components/kumo/loader";
import { Skeleton } from "@/components/kumo/skeleton";
import { Text } from "@/components/kumo/text";
import type { FeedSourceState } from "@/components/activity-feed-sources";

/** A requested refresh that has not produced a new revision by then stops being shown as in progress. */
const TODAY_REFRESH_WAIT_MS = 10 * 60_000;

export function TodayPost({
	config,
	onUpdate,
	compact = false,
	changesSinceLook,
}: {
	config: NonNullable<ActivityFeedConfig["today"]>;
	onUpdate: (id: string, state: FeedSourceState) => void;
	compact?: boolean;
	changesSinceLook?: Map<string, string>;
}) {
	const cache = useQueryClient();
	const options = osQuery.osWorkspaces.outputs.get.queryOptions({
		input: { outputId: config.outputId },
	});
	// The revision a manual refresh started from; the chip stays until a newer one lands.
	const [awaiting, setAwaiting] = useState<{
		revisionId: string | null;
		at: number;
	} | null>(null);
	const output = useQuery({
		...options,
		refetchInterval: awaiting ? 10_000 : 60_000,
	});
	const deck = useQuery({
		...osQuery.attention.listDeckCards.queryOptions({
			input: { limit: 100 },
		}),
		refetchInterval: 30_000,
	});
	const revisionId = output.data?.currentRevision?.id ?? null;
	useEffect(() => {
		if (!awaiting) return;
		if (
			(output.data && revisionId !== awaiting.revisionId) ||
			Date.now() - awaiting.at > TODAY_REFRESH_WAIT_MS
		) {
			setAwaiting(null);
			return;
		}
		const timer = setTimeout(
			() => setAwaiting(null),
			Math.max(0, TODAY_REFRESH_WAIT_MS - (Date.now() - awaiting.at)),
		);
		return () => clearTimeout(timer);
	}, [awaiting, output.data, revisionId]);
	const content = output.data?.currentRevision?.content;
	const digest = useMemo(() => content && readToday(content), [content]);
	useEffect(
		() =>
			onUpdate("today-receipts", {
				items: digest?.receipts ?? [],
				loading: output.isPending,
				failed: output.isError,
				more: false,
			}),
		[digest, output.isPending, output.isError, onUpdate],
	);
	const heading = useRef<HTMLHeadingElement>(null);
	const [requesting, setRequesting] = useState(false);
	const [message, setMessage] = useState("");
	const [expanded, setExpanded] = useState(false);
	useEffect(() => {
		const jump = (event: KeyboardEvent) => {
			if (!todayShortcut(event)) return;
			event.preventDefault();
			heading.current?.focus();
			heading.current?.scrollIntoView({ block: "start", behavior: "instant" });
		};
		if (window.location.hash === "#today-heading") {
			heading.current?.focus();
			heading.current?.scrollIntoView?.({ block: "start" });
		}
		document.addEventListener("keydown", jump);
		return () => document.removeEventListener("keydown", jump);
	}, []);
	const refreshing = requesting || !!awaiting;
	async function refresh() {
		setRequesting(true);
		setMessage("");
		try {
			await osApi.skills.runWorkflow({
				skillId: config.skillId,
				tediId: config.tediId,
				params: {
					manual: true,
					outputId: config.outputId,
					personId: config.personId,
					timeZone: config.timeZone,
				},
				confirmDestructive: true,
				reason: "Refresh the saved Today post",
				idempotencyKey: `today:${config.outputId}:${Math.floor(Date.now() / 60_000)}`,
			});
			setAwaiting({ revisionId, at: Date.now() });
			await cache.invalidateQueries({ queryKey: options.queryKey });
		} catch {
			setMessage("Could not refresh Today. Try again.");
		} finally {
			setRequesting(false);
		}
	}
	return (
		<Card aria-labelledby="today-heading" className="focus-today">
			<CardHeader>
				<div className="focus-today-heading flex items-baseline justify-between gap-3">
					<div className="flex min-w-0 flex-wrap items-baseline gap-3">
						<CardTitle id="today-heading" ref={heading} tabIndex={-1}>
							Today
						</CardTitle>
						{awaiting && (
							<span
								role="status"
								className="focus-today-refreshing"
								data-today-refreshing
							>
								<Loader aria-hidden="true" size="sm" />
								Refreshing…
							</span>
						)}
					</div>
					<Button
						variant="ghost"
						size="sm"
						disabled={refreshing}
						onClick={() => void refresh()}
					>
						<span className="inline-flex items-center gap-2">
							<span>Refresh</span>
							<ArrowsClockwise size={16} aria-hidden />
						</span>
					</Button>
				</div>
			</CardHeader>
			<CardContent className="grid gap-4">
				{deck.isPending ? (
					<Skeleton
						role="status"
						aria-label="Checking Deck"
						className="h-5 w-28"
						data-today-deck-pending
					/>
				) : (
					<Link variant="record" href="/work?view=deck">
						{deck.data?.complete && !deck.isError
							? OS_COPY.feed.decisionsWaiting(String(deck.data.count))
							: "Open Deck · count unavailable"}
					</Link>
				)}
				{(!compact || expanded) && <LearnedToday timeZone={config.timeZone} />}
				<WeeklyCardContext />
				{output.isPending ? (
					<div
						role="status"
						aria-busy="true"
						aria-label="Opening Today"
						className="focus-today-skeleton"
						data-today-pending
					>
						<Skeleton aria-hidden="true" className="h-3.5 w-2/5" />
						<Skeleton aria-hidden="true" className="h-4 w-full" />
						<Skeleton aria-hidden="true" className="h-4 w-11/12" />
						<Skeleton aria-hidden="true" className="h-4 w-3/5" />
					</div>
				) : !digest ? (
					<Text tone="secondary" data-today-empty>
						{output.isError
							? "Today could not be opened. Try Refresh."
							: "Your first summary of today arrives after the next refresh."}
					</Text>
				) : (
					<>
						<Text tone="secondary" className="type-tedix-caption">
							{digest.updated}
						</Text>
						{(compact && !expanded ? digest.rows.slice(0, 1) : digest.rows).map(
							([name, goal, progress, running, , project, receipts]) => (
								<article
									key={project}
									className="focus-today-project grid gap-3"
								>
									<Link
										variant="record"
										className="font-medium"
										href={project!}
									>
										{todayProjectLabel(name!)}
									</Link>
									{!compact && <Text tone="secondary">{goal}</Text>}
									<div className="focus-today-chips">
										{compact && (
											<Text tone="secondary">
												{running !== "Nothing running now."
													? "Moving"
													: "Updated"}
											</Text>
										)}
										<Link variant="record" href={receipts!}>
											{todayProgress(
												compact
													? (changesSinceLook?.get(
															project!.split("/").at(-1)!,
														) ?? progress!)
													: progress!,
											)}
										</Link>
										{!compact && <Text>{running}</Text>}
									</div>
								</article>
							),
						)}
						<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-kumo-subtle type-tedix-control">
							{compact && digest.rows.length > 1 && (
								<Button
									variant="link"
									size="sm"
									className="!px-0 text-kumo-subtle"
									aria-expanded={expanded}
									onClick={() => setExpanded((value) => !value)}
								>
									{expanded
										? "Fewer projects"
										: `${digest.rows.length - 1} more projects`}
								</Button>
							)}
							{digest.quiet && <span>{digest.quiet}</span>}
						</div>
					</>
				)}
				{message && (
					<div role="status">
						<Text>{message}</Text>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
