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
}: {
	config: NonNullable<ActivityFeedConfig["today"]>;
	onUpdate: (id: string, state: FeedSourceState) => void;
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
	useEffect(() => {
		const jump = (event: KeyboardEvent) => {
			if (!todayShortcut(event)) return;
			event.preventDefault();
			heading.current?.focus();
			heading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
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
		<Card aria-labelledby="today-heading">
			<CardHeader>
				<div className="flex items-center justify-between gap-3">
					<CardTitle id="today-heading" ref={heading} tabIndex={-1}>
						Today
					</CardTitle>
					<Button
						variant="ghost"
						disabled={refreshing}
						onClick={() => void refresh()}
					>
						{refreshing ? "Refreshing…" : "Refresh"}
					</Button>
				</div>
			</CardHeader>
			<CardContent className="grid gap-4">
				<LearnedToday timeZone={config.timeZone} />
				{output.isPending ? (
					<Text>Opening Today…</Text>
				) : !digest ? (
					<Text>Today is unavailable. Try Refresh.</Text>
				) : (
					<>
						<Text>{digest.purpose}</Text>
						<Text tone="secondary">{digest.updated}</Text>
						{digest.rows.map(
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
									className="grid gap-1 border-t border-kumo-line pt-3"
								>
									<Link href={project!}>{name}</Link>
									<Text tone="secondary">{goal}</Text>
									<Link href={receipts!}>{progress}</Link>
									<Text>{running}</Text>
									<Link href={deck!}>
										{needs} need{needs === "1" ? "s" : ""} you
									</Link>
								</article>
							),
						)}
						{digest.quiet && <Text tone="secondary">{digest.quiet}</Text>}
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
