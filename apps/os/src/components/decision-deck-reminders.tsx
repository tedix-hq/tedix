import { Badge } from "@/components/kumo/badge";
import {
	Collapsible,
	CollapsibleDefaultContent,
	CollapsibleDefaultTrigger,
} from "@/components/kumo/collapsible";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import { relativeTime } from "@/lib/time";
import { decisionText } from "@/shared/os-copy";
import type { openCommitmentReminders } from "@/lib/commitment-reminders";

type Reminder = ReturnType<typeof openCommitmentReminders>[number];

/**
 * Automatic "Follow up" reminders sit in one collapsed row above the decision
 * card, newest first. They never count as decisions; the person can open the
 * Work behind each one for more context.
 */
export function DeckReminders({
	reminders,
	now,
}: {
	reminders: readonly Reminder[];
	now: Date;
}) {
	if (!reminders.length) return null;
	return (
		<Collapsible data-deck-reminders>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<CollapsibleDefaultTrigger>
					<span className="inline-flex items-center gap-2">
						{decisionText("Reminders")}
						<Badge variant="secondary">{reminders.length}</Badge>
					</span>
				</CollapsibleDefaultTrigger>
			</div>
			<CollapsibleDefaultContent>
				<Text role="caption" tone="secondary">
					{decisionText(
						"Automatic follow-ups for idle or overdue Work. They close by themselves when the Work moves on.",
					)}
				</Text>
				<ul className="grid gap-1" aria-label={decisionText("Reminders")}>
					{reminders.map((row) => (
						<li
							key={row.request.id}
							className="flex min-w-0 items-baseline justify-between gap-2"
						>
							<Link
								variant="record"
								className="truncate"
								href={
									row.workItem
										? `/work/items/${row.workItem.id}`
										: `/work/interactions/${row.request.id}`
								}
							>
								{row.workItem?.title ?? row.request.subject}
							</Link>
							<Text as="span" role="caption" tone="secondary">
								{relativeTime(row.request.requestedAt, now)}
							</Text>
						</li>
					))}
				</ul>
			</CollapsibleDefaultContent>
		</Collapsible>
	);
}
