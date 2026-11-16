import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SkillEntry } from "@tedix/api-contract/schemas/cognitive";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import {
	installedAppEligibilityQueryOptions,
	skillDetailQueryOptions,
	skillSpecificSchedulesQueryOptions,
	tediNamesQueryOptions,
} from "@/lib/os-query-options";

vi.mock("@tanstack/react-router", () => ({
	useParams: () => ({ skillId: "skill-1" }),
	Link: ({
		to,
		params,
		children,
	}: {
		to: string;
		params?: Record<string, string>;
		children?: ReactNode;
	}) => (
		<a
			href={Object.entries(params ?? {}).reduce(
				(href, [name, value]) => href.replace(`$${name}`, value),
				to,
			)}
		>
			{children}
		</a>
	),
}));

const { SkillConnectionsList, SkillSettingsPage } =
	await import("./skill-settings-page");
const { SkillSourcePage } = await import("./skill-source-page");

const WORKFLOW = `export default { async run(event, step, env) {
	const name = event.payload.label;
	await step.do("fetch-orders", async () => env.MCP.storefront.list_orders({}));
	await step.do(name, async () => env.MCP.sheets.write_report({}));
} };`;

const entry = (overrides: Partial<SkillEntry> = {}): SkillEntry =>
	({
		id: "skill-1",
		organizationId: "org",
		tediId: "tedi-1",
		title: "Weekly revenue report",
		content: "# Weekly revenue report\n\n1. Gather\n2. Report",
		files: { "scripts/workflow.ts": WORKFLOW },
		inputSchema: {
			type: "object",
			properties: {
				period: { type: "string", description: "Reporting period" },
			},
			required: ["period"],
		},
		mcpAppBindings: { storefront: "app-storefront" },
		successCount: 0,
		failureCount: 0,
		revision: 7,
		visibility: "org",
		lifecycleState: "active",
		paceLayer: "differentiation",
		...overrides,
	}) as SkillEntry;

const installedRead = (overrides: Record<string, unknown> = {}) => ({
	data: [
		{ appId: "app-storefront", appName: "Storefront", badge: "ready" as const },
	],
	isPending: false,
	isError: false,
	isFetching: false,
	refetch: () => Promise.resolve(),
	...overrides,
});

function page(
	element: ReactNode,
	skill: SkillEntry | null | undefined,
	seed?: (client: QueryClient) => void,
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, enabled: false } },
	});
	if (skill !== undefined)
		client.setQueryData(skillDetailQueryOptions("skill-1").queryKey, {
			entry: skill,
		} as never);
	seed?.(client);
	return renderToStaticMarkup(
		<QueryClientProvider client={client}>{element}</QueryClientProvider>,
	);
}

describe("SkillSettingsPage", () => {
	const seeded = (client: QueryClient) => {
		client.setQueryData(
			skillSpecificSchedulesQueryOptions("skill-1").queryKey,
			{
				schedules: [
					{
						id: "schedule-1",
						organizationId: "org",
						skillId: "skill-1",
						tediId: "tedi-1",
						cron: "0 8 * * *",
						params: {},
						enabled: true,
						nextFireAt: "2999-01-01T08:00:00Z",
					},
				],
				total: 1,
				offset: 0,
				limit: 200,
				nextOffset: null,
			} as never,
		);
		client.setQueryData(tediNamesQueryOptions().queryKey, {
			data: [{ id: "tedi-1", name: "miles", displayName: "Miles" }],
		} as never);
		client.setQueryData(installedAppEligibilityQueryOptions().queryKey, [
			{
				appId: "app-storefront",
				appName: "Storefront",
				badge: "ready",
				result: {
					eligible: true,
					degraded: false,
					missing: [],
					availableTools: [],
					unavailableTools: [],
				},
			},
		] as never);
	};

	it("holds the schedule, owner, connections and inputs in that order", () => {
		const html = page(<SkillSettingsPage />, entry(), seeded);
		const order = ["Schedule", "Owner", "Connections and tools", "Inputs"].map(
			(title) => html.indexOf(`>${title}</h2>`),
		);
		expect(order.every((index) => index > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(html).toContain("Every day at");
		expect(html).toContain("Miles");
		expect(html).toContain('href="/team/tedi-1"');
		expect(html).toContain("Reporting period");
	});

	it("says a shared skill has no single owner", () => {
		const html = page(<SkillSettingsPage />, entry({ tediId: null }), seeded);
		expect(html).toContain("No single tedi owns this skill");
		expect(html).not.toContain("Open tedi");
	});

	it("separates loading from a skill that is not there", () => {
		expect(page(<SkillSettingsPage />, undefined)).not.toContain(
			"Skill not found",
		);
		expect(page(<SkillSettingsPage />, null)).toContain("Skill not found");
	});
});

describe("SkillConnectionsList", () => {
	const render = (skill: SkillEntry, installed = installedRead()) =>
		renderToStaticMarkup(
			<SkillConnectionsList skill={skill} installed={installed} />,
		);

	it("names each connection, whether it is ready and what the skill uses on it", () => {
		const html = render(entry());
		const technical = html.indexOf("Technical details");
		const readable = html.slice(0, technical);
		expect(readable).toContain("Storefront");
		expect(readable).toContain("Ready");
		expect(readable).toContain("Uses: List orders");
		expect(readable).toContain('href="/apps/app-storefront"');
		expect(readable).toContain("Sheets");
		expect(readable).toContain("No app found");
		expect(readable).toContain("Uses: Write report");
		expect(readable).toContain("No installed app matches this connection.");
		// Raw call names and ids are a technical detail.
		expect(readable).not.toContain("list_orders");
		expect(readable).not.toContain("app app-storefront");
		expect(html.slice(technical)).toContain("storefront.list_orders");
		expect(html.slice(technical)).toContain("storefront · app app-storefront");
	});

	it("passes on that an app still needs setup", () => {
		const html = render(
			entry(),
			installedRead({
				data: [
					{
						appId: "app-storefront",
						appName: "Storefront",
						badge: "setup_needed",
					},
				],
			}),
		);
		expect(html).toContain("Needs setup");
		expect(html).toContain("Finish setting up this app");
	});

	it("claims no status while the check is running or after it failed", () => {
		const checking = render(
			entry(),
			installedRead({ data: undefined, isPending: true }),
		);
		expect(checking).toContain("Checking…");
		expect(checking).not.toContain("Ready");
		expect(checking).not.toContain("No app found");

		const failed = render(
			entry(),
			installedRead({ data: undefined, isError: true }),
		);
		expect(failed).toContain(
			"Could not check whether these connections are ready.",
		);
		expect(failed).toContain("Retry");
		expect(failed).toContain("Not checked");
		expect(failed).not.toContain("No app found");
	});

	it("says so when a skill names no connection", () => {
		// A linked app the source never calls by name is still listed.
		expect(
			render(entry({ files: { "scripts/workflow.ts": "export default {}" } })),
		).toContain("May use any of its tools.");
		expect(
			render(
				entry({
					files: { "scripts/workflow.ts": "export default {}" },
					mcpAppBindings: null,
				}),
			),
		).toContain("This skill calls no connected apps.");
		expect(render(entry({ files: null, mcpAppBindings: null }))).toContain(
			"This skill names no connections.",
		);
	});
});

describe("SkillSourcePage", () => {
	it("holds the files, the steps with readable labels and the stored input definition", () => {
		const html = page(<SkillSourcePage />, entry());
		const order = [
			"Instructions and files",
			"Workflow anatomy",
			"Input definition",
		].map((title) => html.indexOf(`>${title}</h2>`));
		expect(order.every((index) => index > -1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(html).toContain("Everything saved in version 7.");
		expect(html).toContain("workflow.ts");
		expect(html).toContain("fetch-orders");
		// A step named by a variable is called by what it does, never "name".
		expect(html).toContain("Write report in sheets");
		expect(html).not.toMatch(/>name</);
		expect(html).toContain("&quot;period&quot;");
	});

	it("says so when a version stores no input definition", () => {
		const html = page(<SkillSourcePage />, entry({ inputSchema: null }));
		expect(html).toContain("This version stores no input definition.");
	});

	it("separates loading from a skill that is not there", () => {
		expect(page(<SkillSourcePage />, undefined)).not.toContain(
			"Skill not found",
		);
		expect(page(<SkillSourcePage />, null)).toContain("Skill not found");
	});
});
