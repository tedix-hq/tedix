import { useQuery } from "@tanstack/react-query";
import { osQuery } from "@/lib/os-query-options";
import { Link } from "@/components/kumo/link";
import { Text } from "@/components/kumo/text";
import type { AgentLessonEntry } from "@tedix/api-contract/schemas/agent-session-lessons";

export function feedbackToday(
	lessons: AgentLessonEntry[],
	now: Date,
	timeZone?: string,
) {
	const day = (date: Date) =>
		new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(date);
	return lessons.filter(
		(lesson) =>
			lesson.fromCallerFeedback &&
			lesson.addedAt &&
			day(new Date(lesson.addedAt)) === day(now) &&
			lesson.evidence?.sources.some((source) => source.kind === "correction"),
	);
}

export function LearnedToday({ timeZone }: { timeZone?: string }) {
	const query = useQuery({
		...osQuery.agentTurnTriage.listLessons.queryOptions({
			input: { limit: 100 },
		}),
		refetchInterval: 30_000,
	});
	if (query.isError)
		return <Text tone="secondary">Learned today is unavailable.</Text>;
	if (!query.data) return null;
	const lessons = feedbackToday(query.data.lessons, new Date(), timeZone);
	return (
		<div className="grid gap-1" aria-label="Learned today">
			<Text weight="semibold">Learned today</Text>
			<Text>
				{lessons.length
					? `${lessons.length} new ${lessons.length === 1 ? "rule" : "rules"} from your feedback today:`
					: "No new rules from your feedback today."}
			</Text>
			{lessons.slice(0, 6).map((lesson) => (
				<Link key={lesson.id} href={`/brain#lesson-${lesson.id}`}>
					{lesson.text}
				</Link>
			))}
			{lessons.length > 6 && (
				<Text tone="secondary">{lessons.length - 6} more in your lessons.</Text>
			)}
		</div>
	);
}
