import { OS_COPY } from "@/shared/os-copy";
import { Page } from "@/components/kumo/page";
import {
	ProjectBrief,
	ProjectSummary,
	WorkItemsTable,
} from "@/components/work-factory-pages";
import { ProjectEpics } from "@/components/work-project-epics";
import { WorkProjectContributors } from "@/components/work-project-contributors";
import {
	WorkEmpty,
	WorkListSkeleton,
	WorkPageHeader,
	WorkReadFailure,
} from "@/components/work-surface-primitives";
import {
	projectDetailQueryOptions,
	projectRollupQueryOptions,
	workItemListQueryOptions,
} from "@/lib/os-query-options";
import { useDocumentTitle } from "@/lib/use-document-title";
import { useWorkPrincipalNames } from "./work-operations-shared";
import { useQuery } from "@tanstack/react-query";

export function WorkProjectGoalsPage({ projectId }: { projectId: string }) {
	const project = useQuery(projectDetailQueryOptions(projectId));
	const rollup = useQuery(projectRollupQueryOptions(projectId));
	const items = useQuery(workItemListQueryOptions({ projectId, limit: 100 }));
	const principalNames = useWorkPrincipalNames(items.data?.data[0]?.orgId);
	useDocumentTitle(
		project.data ? `${project.data.name} · Projects` : "Project",
	);

	if ([project, rollup, items].some((query) => query.isPending))
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
						? `${OS_COPY.work.objective}: ${project.data.objective.title}`
						: "No objective yet"
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
			<ProjectEpics projectId={projectId} />
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
					description="This project has no Work Items yet. Add one when an outcome is ready to be worked on."
				/>
			)}
		</Page>
	);
}
