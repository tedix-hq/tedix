import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import type { SkillEntry } from "@tedix/api-contract/contracts/cognitive";
import { createRoot } from "react-dom/client";
import { Page } from "../src/components/kumo/page";
import { SkillSettingsPage } from "../src/components/skill-settings-page";
import { SkillSourcePage } from "../src/components/skill-source-page";
import { setOsFormattingPreferences } from "../src/lib/format";
import {
	installedAppEligibilityQueryOptions,
	skillDetailQueryOptions,
	skillRunsQueryOptions,
	skillSpecificSchedulesQueryOptions,
	tediNamesQueryOptions,
} from "../src/lib/os-query-options";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const dark = query.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
document.documentElement.dataset.mode = dark ? "dark" : "light";
document.documentElement.style.colorScheme = dark ? "dark" : "light";
setOsFormattingPreferences({ locale: "en-US", timezone: "Europe/Berlin" });

const client = new QueryClient({
	defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const skillId = "fictional-skill";
const entry: SkillEntry = {
	id: skillId,
	organizationId: "fictional-org",
	tediId: "fictional-agent",
	title: "Weekly revenue report",
	content:
		"# Weekly revenue report\n\n1. Read the orders.\n2. Write the report.",
	files: {
		"scripts/workflow.ts": [
			"export default { async run(event, step, env) {",
			"  const label = event.payload.label;",
			'  await step.do("fetch-orders", async () => env.MCP.storefront.list_orders({}));',
			"  await step.do(label, async () => env.MCP.sheets.write_report({}));",
			"  await step.do(label, async () => env.MCP.inbox.send_summary({}));",
			"} };",
		].join("\n"),
	},
	inputSchema: {
		type: "object",
		properties: {
			period: {
				type: "string",
				description: "Reporting period to summarize",
				enum: ["last_7_days", "last_30_days"],
			},
			includeRefunds: {
				type: "boolean",
				description: "Count refunded orders in the totals",
				default: false,
			},
		},
		required: ["period"],
	},
	mcpAppBindings: {
		storefront: "fictional-app-storefront",
		inbox: "fictional-app-inbox",
	},
	successCount: 6,
	failureCount: 0,
	visibility: "org",
	paceLayer: "innovation",
	revision: 3,
};
client.setQueryData(skillDetailQueryOptions(skillId).queryKey, { entry });
client.setQueryData(skillSpecificSchedulesQueryOptions(skillId).queryKey, {
	schedules: [
		{
			id: "fictional-schedule",
			organizationId: "fictional-org",
			skillId,
			tediId: "fictional-agent",
			// 08:00 UTC is 09:00 in Berlin in January.
			cron: "0 8 * * *",
			params: { period: "last_7_days" },
			enabled: true,
			nextFireAt: "2031-01-15T08:00:00Z",
			lastFireAt: "2026-10-30T08:00:00Z",
			lastRunId: "fictional-run",
		},
	],
	total: 1,
	offset: 0,
	limit: 200,
	nextOffset: null,
});
client.setQueryData(tediNamesQueryOptions().queryKey, {
	data: [{ id: "fictional-agent", name: "miles", displayName: "Miles" }],
} as never);
const eligibility = (badge: "ready" | "setup_needed") => ({
	eligible: badge === "ready",
	degraded: false,
	missing: [],
	availableTools: [],
	unavailableTools: [],
});
client.setQueryData(installedAppEligibilityQueryOptions().queryKey, [
	{
		appId: "fictional-app-storefront",
		appName: "Storefront",
		result: eligibility("ready"),
		badge: "ready",
	},
	{
		appId: "fictional-app-inbox",
		appName: "Support inbox",
		result: eligibility("setup_needed"),
		badge: "setup_needed",
	},
]);
client.setQueryData(skillRunsQueryOptions(skillId).queryKey, { runs: [] });

function Fixture() {
	return (
		<Page width="lg">
			{query.get("tab") === "source" ? (
				<SkillSourcePage />
			) : (
				<SkillSettingsPage />
			)}
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
