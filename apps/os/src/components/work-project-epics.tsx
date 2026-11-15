import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import { SectionCollection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import { WORK_STREAM_STAGE_LABELS } from "@/components/work-cases-pages";
import { WorkReadFailure } from "@/components/work-surface-primitives";
import { workCaseListQueryOptions } from "@/lib/os-query-options";
import { absoluteDate } from "@/lib/time";

const OPEN_EPIC_STAGES = [
	"investigating",
	"planning",
	"executing",
	"monitoring",
] as const;

/** The project's epics that are not closed, each with its stage and target date. */
export function ProjectEpics({ projectId }: { projectId: string }) {
	const epics = useQuery(
		workCaseListQueryOptions({
			projectId,
			stages: [...OPEN_EPIC_STAGES],
			limit: 100,
		}),
	);
	if (epics.isError)
		return (
			<WorkReadFailure
				title="Open epics unavailable"
				fallback="This project's epics could not be loaded. Try again."
				error={epics.error}
			/>
		);
	return (
		<SectionCollection
			title="Open epics"
			description="Bigger pieces of work in this project that are not closed yet."
			empty={
				epics.isPending ? "Loading epics…" : "No open epics in this project."
			}
		>
			{(epics.data?.data ?? []).map((epic) => (
				<li
					key={epic.id}
					className="flex min-w-0 flex-wrap items-center justify-between gap-3"
				>
					<Link variant="record" href={`/work/cases/${epic.id}`}>
						{epic.title}
					</Link>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<Badge variant="outline">
							{WORK_STREAM_STAGE_LABELS[epic.stage]}
						</Badge>
						<Text role="label" tone="secondary">
							Target date:{" "}
							{epic.targetResolutionAt
								? absoluteDate(epic.targetResolutionAt)
								: "Not set"}
						</Text>
					</div>
				</li>
			))}
		</SectionCollection>
	);
}
