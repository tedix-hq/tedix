import { Badge } from "@/components/kumo/badge";
import { Link } from "@/components/kumo/link";
import { Page, SectionCollection } from "@/components/kumo/page";
import { Text } from "@/components/kumo/text";
import {
	ProjectBrief,
	ProjectSummary,
	WorkItemsTable,
} from "@/components/work-factory-pages";
import { WorkProjectContributors } from "@/components/work-project-contributors";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import { sentenceCase } from "@/lib/format";
import {
	projectDetailQueryOptions,
	projectRollupQueryOptions,
	workCaseListQueryOptions,
	workItemListQueryOptions,
} from "@/lib/os-query-options";
import { absoluteDate } from "@/lib/time";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useWorkPrincipalNames } from "./work-operations-shared";
import { useQuery } from "@tanstack/react-query";

const OPEN_EPIC_STAGES = [
	"investigating",
	"planning",
	"executing",
	"monitoring",
] as const;

export function ProjectEpics({
	epics,
}: {
	epics: readonly {
		id: string;
		title: string;
		stage: string;
		targetResolutionAt: string | null;
	}[];
}) {
	return (
		<SectionCollection
			title="Open epics"
			description="Larger outcomes this project is actively serving."
			empty="No open epics in this project."
		>
			{epics.map((epic) => (
				<li
					key={epic.id}
					className="flex min-w-0 flex-wrap items-center justify-between gap-3"
				>
					<Link variant="record" href={`/work/cases/${epic.id}`}>
						{epic.title}
					</Link>
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline">{sentenceCase(epic.stage)}</Badge>
						<Text role="label" tone="secondary">
							Target:{" "}
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

export function WorkProjectGoalsPage({ projectId }: { projectId: string }) {
	const project = useQuery(projectDetailQueryOptions(projectId));
	const rollup = useQuery(projectRollupQueryOptions(projectId));
	const epics = useQuery(
		workCaseListQueryOptions({
			projectId,
			stages: [...OPEN_EPIC_STAGES],
			limit: 100,
		}),
	);
	const items = useQuery(workItemListQueryOptions({ projectId, limit: 100 }));
	const principalNames = useWorkPrincipalNames(items.data?.data[0]?.orgId);
	useDocumentTitle(
		project.data ? `${project.data.name} · Projects` : "Project",
	);

	if ([project, rollup, epics, items].some((query) => query.isPending))
		return (
			<Page width="full">
				<WorkListSkeleton />
			</Page>
		);
	if (project.isError || !project.data)
		return (
			<Page width="full">
				<WorkReadFailure
					title="Project unavailable"
					fallback="The project could not be loaded. Retry once."
				/>
			</Page>
		);

	return (
		<Page width="full">
			<WorkPageHeader
				title={project.data.name}
				description={`${project.data.key} · ${
					project.data.objective
						? `Goal: ${project.data.objective.title}`
						: "No goal yet"
				}`}
			/>
			<ProjectBrief description={project.data.description} />
			<ProjectSummary
				status={project.data.status}
				progress={rollup.data}
				targetDate={project.data.targetDate}
				projectId={projectId}
			/>
			<WorkProjectContributors projectId={projectId} />
			{epics.isError ? (
				<WorkReadFailure
					title="Project epics unavailable"
					fallback="The project's epics could not be loaded. Retry once."
				/>
			) : (
				<ProjectEpics epics={epics.data?.data ?? []} />
			)}
			{items.isError ? (
				<WorkReadFailure
					title="Project work unavailable"
					fallback="The project's Work Items could not be loaded. Retry once."
				/>
			) : items.data?.data.length ? (
				<WorkItemsTable
					items={items.data.data}
					principalNames={principalNames}
				/>
			) : (
				<WorkEmpty
					title="No work in this project"
					description="Projects are not executable; admit bounded Work Items when outcomes are ready."
				/>
			)}
		</Page>
	);
}
