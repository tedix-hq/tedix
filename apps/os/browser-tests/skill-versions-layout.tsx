import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type {
	SkillEntry,
	SkillWorkflowRevision,
} from "@tedix/api-contract/contracts/cognitive";
import { createRoot } from "react-dom/client";
import {
	Page,
	SectionHeader,
	SectionHeading,
	SectionTitle,
	SettingsSection,
} from "../src/components/kumo/page";
import { Text } from "../src/components/kumo/text";
import { SkillVersionsPage } from "../src/components/skill-versions-page";
import {
	operationalContextQueryOptions,
	skillDetailQueryOptions,
	skillRevisionsQueryOptions,
	skillWorkflowDraftsQueryOptions,
	skillRunsQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const skillId = "fictional-skill";
const baseline: SkillEntry = {
	id: skillId,
	organizationId: "fictional-org",
	title: "Research workflow",
	content: "# Research workflow",
	files: { "scripts/workflow.ts": "export default { run() { return 1; } };" },
	successCount: 6,
	failureCount: 0,
	visibility: "org",
	paceLayer: "innovation",
	revision: 3,
	revisionReasoning: "Clearer review conditions.",
};
client.setQueryData(skillDetailQueryOptions(skillId).queryKey, {
	entry: baseline,
});
client.setQueryData(operationalContextQueryOptions().queryKey, {
	authority: { permissions: ["tedis:update"] },
	organization: { id: "fictional-org" },
});
const showImprovements = new URLSearchParams(location.search).has(
	"improvements",
);
const proposal = {
	...baseline,
	id: "waiting-copy",
	title: "Clearer source review",
	lifecycleState: "draft",
	sourceSkillId: skillId,
	sourceRevision: 3,
	tags: ["workflow-improvement"],
};
const improvements = showImprovements
	? [
			proposal,
			{
				...proposal,
				id: "adopted-copy",
				lifecycleState: "archived",
				improvementAdoption: {
					activatedIntoRevision: 3,
					certificationRunId: "passed-test",
					adoptedAt: "2026-10-30T10:00:00Z",
					reason: "Skip duplicate source requests",
				},
			},
			{
				...proposal,
				id: "rejected-copy",
				title: "Abandoned wider search",
				lifecycleState: "archived",
			},
		]
	: [];
client.setQueryData(skillWorkflowDraftsQueryOptions(skillId).queryKey, {
	pages: [{ entries: improvements, total: improvements.length }],
	pageParams: [0],
});
client.setQueryData(skillRunsQueryOptions(proposal.id, undefined, 5).queryKey, {
	runs: [],
});
const revisions: SkillWorkflowRevision[] = [3, 2, 1].map((revision) => ({
	skillId,
	tediId: "fictional-agent",
	status: "completed",
	firstObservedAt: "2026-10-30T12:00:00Z",
	lastObservedAt: "2026-10-30T14:00:00Z",
	runtimeDriftObserved: false,
	runtimeDriftBlocked: false,
	workerVersionId: null,
	workerVersionTag: null,
	workerVersionTimestamp: null,
	executionCompatibilityHash: null,
	dispatchShimVersion: null,
	compatibilityDate: null,
	dynamicWorkflowsVersion: null,
	loaderConfigHash: null,
	tenantCpuMs: null,
	tenantSubRequests: null,
	runId: `fictional-run-${revision}`,
	revision,
	observedRunCount: 2,
	completedCount: 2,
	failedCount: 0,
	canceledCount: 0,
	runtimeVariants: [],
	workflowSourceSha256: "fictional-workflow",
	skillDocSha256: "fictional-instructions",
}));
client.setQueryData(skillRevisionsQueryOptions(skillId).queryKey, {
	revisions,
	provenance: "observed_executed_runs",
	sampledRunCount: 6,
	mayBeTruncated: false,
});

function Fixture() {
	return (
		<Page width="lg">
			<SkillVersionsPage />
			<SettingsSection aria-label="Section spacing example">
				<SectionHeader>
					<SectionHeading>
						<SectionTitle>Settings example</SectionTitle>
					</SectionHeading>
				</SectionHeader>
				<Text as="p" className="m-0" data-layout-summary>
					Readable summary
				</Text>
				<Text as="span" className="m-0" data-layout-next>
					Separate supporting information
				</Text>
			</SettingsSection>
		</Page>
	);
}

const root = createRootRoute({ component: Outlet });
const session = createRoute({ getParentRoute: () => root, id: "_session" });
const tenant = createRoute({ getParentRoute: () => session, id: "_tenant" });
const skill = createRoute({
	getParentRoute: () => tenant,
	path: "skills/$skillId",
	component: Fixture,
});
const router = createRouter({
	routeTree: root.addChildren([
		session.addChildren([tenant.addChildren([skill])]),
	]),
	history: createMemoryHistory({ initialEntries: [`/skills/${skillId}`] }),
});
createRoot(document.getElementById("root")!).render(
	<QueryClientProvider client={client}>
		<RouterProvider router={router} />
	</QueryClientProvider>,
);
