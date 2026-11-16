import { createRoot } from "react-dom/client";
import type {
	SkillEntry,
	SkillSchedule,
} from "@tedix/api-contract/contracts/cognitive";
import type { WorkflowDefinition } from "@tedix/api-contract/contracts/workflows";
import { SkillRow, WorkflowRow } from "../src/components/skills-page";
import { Collection, Page, PageSection } from "../src/components/kumo/page";
import "../src/styles.css";

const dark = new URLSearchParams(location.search).get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";

const skill: SkillEntry = {
	id: "11111111-1111-4111-8111-111111111111",
	organizationId: "org-fictional",
	tediId: "22222222-2222-4222-8222-222222222222",
	title: "Weekly digest",
	slug: "weekly-digest",
	description: null,
	content: "# Weekly digest",
	successCount: 8,
	failureCount: 1,
	lastUsedAt: "2026-08-10T09:00:00.000Z",
	revision: 3,
	visibility: "org",
	lifecycleState: "proven",
};
const definition: WorkflowDefinition = {
	kind: "static_platform",
	id: "platform:memory_reflection",
	title: "Memory reflection",
	description: null,
	engine: "cloudflare_workflows",
	binding: "MEMORY_REFLECTION",
	entrypoint: "MemoryReflectionWorkflow",
	triggers: ["cron"],
	operatorSurface: {
		namespace: "workflows",
		runTool: null,
		statusTool: "workflows_get_status",
		historyTool: "workflows_list_runs",
		revisionsTool: null,
		mutationMode: "deploy_main",
		mutationTool: null,
	},
	scope: "platform",
	ownerKind: "platform",
	sourceKind: "deployed_entrypoint",
	workflowType: "memory_reflection",
	lifecycleState: "active",
};
const schedule: SkillSchedule = {
	id: "33333333-3333-4333-8333-333333333333",
	organizationId: "org-fictional",
	skillId: skill.id,
	tediId: skill.tediId!,
	cron: "0,10,20,30,40,50 9,10,11,12,13,14,15,16,17 * * 1,2,3,4,5",
	params: {},
	enabled: true,
	nextFireAt: null,
};

createRoot(document.getElementById("root")!).render(
	<Page width="lg">
		<PageSection>
			<Collection>
				<SkillRow
					skill={skill}
					executable
					tediNames={{
						[skill.tediId!]: "SupplierOperationsAndCustomerSuccessTeam",
					}}
				/>
				<WorkflowRow definition={definition} schedules={[schedule]} />
			</Collection>
		</PageSection>
	</Page>,
);
