import { ArrowsClockwise } from "@phosphor-icons/react";
import { LearnedToday } from "@/components/learned-today";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ActivityFeedConfig } from "@tedix/api-contract/schemas/os-activity-feed";
import { osApi } from "@/lib/api";
import { osQuery } from "@/lib/os-query-options";
import { readToday, todayShortcut } from "@/lib/today-digest";
import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/kumo/card";
import { Button } from "@/components/kumo/button";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import type { FeedSourceState } from "@/components/activity-feed-sources";

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
	const output = useQuery({ ...options, refetchInterval: 60_000 });
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
	const [refreshing, setRefreshing] = useState(false);
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
	async function refresh() {
		setRefreshing(true);
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
			await cache.invalidateQueries({ queryKey: options.queryKey });
			setMessage(
				"Refresh requested. The saved post will update when it finishes.",
			);
		} catch {
			setMessage("Could not refresh Today. Try again.");
		} finally {
			setRefreshing(false);
		}
	}
	return (
		<Card aria-labelledby="today-heading" className="focus-today">
			<CardHeader>
				<div className="flex items-baseline justify-between gap-3">
					<CardTitle id="today-heading" ref={heading} tabIndex={-1}>
						Today
					</CardTitle>
					<Button
						variant="ghost"
						size="sm"
						icon={<ArrowsClockwise size={16} aria-hidden />}
						disabled={refreshing}
						onClick={() => void refresh()}
					>
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="grid gap-4">
				{(!compact || expanded) && <LearnedToday timeZone={config.timeZone} />}
				{output.isPending ? (
					<Text>Opening Today…</Text>
				) : !digest ? (
					<Text>Today is unavailable. Try Refresh.</Text>
				) : (
					<>
						<Text>{digest.purpose}</Text>
						<Text tone="secondary" className="type-tedix-caption">
							{digest.updated}
						</Text>
						{(compact && !expanded ? digest.rows.slice(0, 1) : digest.rows).map(
							([
								name,
								goal,
								progress,
								running,
								needs,
								project,
								receipts,
								deck,
							]) => (
								<article
									key={project}
									className="focus-today-project grid gap-3"
								>
									<Link
										variant="record"
										className="font-medium"
										href={project!}
									>
										{name}
									</Link>
									{!compact && <Text tone="secondary">{goal}</Text>}
									<div className="focus-today-chips">
										{compact && (
											<Text tone="secondary">
												{Number(needs) > 0
													? "Needs you"
													: running !== "Nothing running now."
														? "Moving"
														: "Updated"}
											</Text>
										)}
										<Link variant="record" href={receipts!}>
											{compact
												? (changesSinceLook?.get(project!.split("/").at(-1)!) ??
													progress)
												: progress}
										</Link>
										{!compact && <Text>{running}</Text>}
										<Link variant="record" href={deck!}>
											{needs} need{needs === "1" ? "s" : ""} you
										</Link>
									</div>
								</article>
							),
						)}
						<div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-kumo-subtle type-tedix-caption">
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
