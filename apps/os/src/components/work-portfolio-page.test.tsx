import type {
	FactoryScoreboardEntry,
	Project,
	ProjectPortfolioEntry,
} from "@tedix/api-contract/contracts/projects";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { isRedirect } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	factoryScoreboardQueryOptions,
	projectPortfolioQueryOptions,
	workApprovalsQueryOptions,
	workOfficeKnocksQueryOptions,
} from "@/lib/os-query-options";
import { Route as WorkIndexRoute } from "@/routes/_session/_tenant/work.index";
import {
	PORTFOLIO_BUCKETS,
	WorkPortfolioPage,
	crossOrgPortfolioUrl,
	groupFactories,
	groupPortfolio,
	isPlaceholderBrief,
	needsYouRows,
	projectBriefLine,
} from "./work-portfolio-page";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const TEDI_ID = "44444444-4444-4444-8444-444444444444";

function projectRow(
	n: number,
	name: string,
	metadata: Project["metadata"],
	overrides: Partial<Project> = {},
): Project {
	return {
		id: `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`,
		orgId: ORG_ID,
		key: `P-${n}`,
		name,
		description: null,
		status: "active",
		leadTediId: null,
		ownerUserId: "owner-1",
		objectiveId: null,
		targetDate: null,
		metadata,
		createdAt: "2026-09-01T00:00:00.000Z",
		updatedAt: "2026-09-02T00:00:00.000Z",
		archivedAt: null,
		...overrides,
	};
}

const PROJECTS = [
	projectRow(1, "zeta", { portfolioBucket: "Side", portfolioTitle: "Zeta" }),
	projectRow(
		2,
		"Harbor tours",
		{ portfolioBucket: " projects " },
		{
			description: "\n## Run weekend harbor tours\nSecond line",
			leadTediId: TEDI_ID,
		},
	),
	projectRow(3, "Alpha", { portfolioBucket: "PROJECTS" }),
	projectRow(4, "Loose notes", null),
	projectRow(
		5,
		"Old shop",
		{ portfolioBucket: "Active" },
		{ status: "archived", archivedAt: "2026-09-03T00:00:00.000Z" },
	),
	projectRow(
		6,
		"Placeholder",
		{ portfolioBucket: "Leads", portfolioOrg: "acme-demo" },
		{ description: "No records yet; owner to define" },
	),
];

function portfolioRow(
	project: Project,
	overrides: Partial<ProjectPortfolioEntry> = {},
): ProjectPortfolioEntry {
	return {
		project,
		leadTediName: null,
		total: 0,
		byDisposition: {},
		next: null,
		health: null,
		lastActivityAt: null,
		...overrides,
	};
}

const PORTFOLIO = PROJECTS.map((project) =>
	project.id === PROJECTS[1]!.id
		? portfolioRow(project, {
				leadTediName: "Nova",
				total: 3,
				byDisposition: { proposed: 2, accepted: 1 },
				next: { id: "item-accepted", title: "Book the boat" },
				health: "at_risk",
			})
		: portfolioRow(project),
);

function interaction(n: number, state: "open" | "resolved" = "open") {
	return {
		request: {
			id: `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`,
			subject: `Question ${n}`,
			metadata: {},
			workItemId: null,
			requestedAt: `2026-09-10T00:00:${String(n).padStart(2, "0")}.000Z`,
		},
		effectiveState: state,
		canRespond: true,
		canCancel: false,
		workItem: null,
		responseCount: 0,
	};
}

function factory(
	overrides: Partial<FactoryScoreboardEntry> = {},
): FactoryScoreboardEntry {
	return {
		kind: "skill_loop",
		id: "skill-digest",
		name: "Daily digest",
		tediId: TEDI_ID,
		tediName: "Nova",
		cron: "0 7 * * *",
		runs: 7,
		succeeded: 6,
		lastRunAt: "2026-09-09 07:00:00",
		outputs: 2,
		workClosed: 1,
		lastResult: {
			kind: "output",
			id: "output-brief",
			title: "Weekly brief",
			at: "2026-09-09 07:05:00",
		},
		paused: false,
		idle: false,
		...overrides,
	};
}

const FACTORIES = [
	factory(),
	factory({
		kind: "blueprint",
		id: "bp-crm",
		name: "CRM factory",
		tediId: null,
		tediName: null,
		cron: null,
		outputs: 0,
		workClosed: 0,
		lastResult: null,
		idle: true,
	}),
];

function seededClient({
	interactions = [] as ReturnType<typeof interaction>[],
	factories = FACTORIES,
} = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	queryClient.setQueryData(projectPortfolioQueryOptions().queryKey, {
		data: PORTFOLIO,
	});
	queryClient.setQueryData(factoryScoreboardQueryOptions().queryKey, {
		data: factories,
		since: "2026-09-03T00:00:00.000Z",
	});
	queryClient.setQueryData(workOfficeKnocksQueryOptions().queryKey, {
		data: interactions,
		nextCursor: null,
		hasMore: false,
		observedAt: "2026-09-10T00:00:00.000Z",
	} as never);
	queryClient.setQueryData(workApprovalsQueryOptions().queryKey, {
		data: [],
		nextCursor: null,
		hasMore: false,
		observedAt: "2026-09-10T00:00:00.000Z",
	});
	return queryClient;
}

function render(queryClient: QueryClient) {
	return renderToStaticMarkup(
		<QueryClientProvider client={queryClient}>
			<WorkPortfolioPage />
		</QueryClientProvider>,
	);
}

describe("Portfolio grouping", () => {
	it("orders buckets canonically, matches names loosely, and sorts by title", () => {
		const { buckets, other } = groupPortfolio(PORTFOLIO);
		expect(buckets.map((bucket) => bucket.name)).toEqual([
			...PORTFOLIO_BUCKETS,
		]);
		expect(buckets[0]!.entries.map((entry) => entry.title)).toEqual([
			"Alpha",
			"Harbor tours",
		]);
		expect(buckets[3]!.entries.map((entry) => entry.title)).toEqual(["Zeta"]);
		expect(buckets[2]!.entries[0]!.org).toBe("acme-demo");
		expect(other.map((entry) => entry.title)).toEqual([
			"Loose notes",
			"Old shop",
		]);
	});

	it("links cross-org entries to that organization's Portfolio", () => {
		expect(crossOrgPortfolioUrl("acme-demo")).toBe(
			"https://acme-demo.os.tedix.dev/work/portfolio",
		);
		expect(crossOrgPortfolioUrl("not a slug")).toBeNull();
	});

	it("takes the first meaningful description line as the brief", () => {
		expect(projectBriefLine("\n## Run tours\nmore")).toBe("Run tours");
		expect(projectBriefLine("  \n- first item")).toBe("first item");
		expect(projectBriefLine(null)).toBeNull();
	});

	it("keeps open questions and decidable approvals, newest first", () => {
		const rows = needsYouRows(
			[interaction(1), interaction(2, "resolved")],
			[
				{
					proposal: {
						id: "approval-1",
						requestedAt: "2026-09-11T00:00:00.000Z",
						requestRationale: "Ship it",
					},
					effectiveStatus: "pending",
					canDecide: true,
					workItem: { id: "item-9", title: "Approve the fare table" },
				},
				{
					proposal: {
						id: "approval-2",
						requestedAt: "2026-09-12T00:00:00.000Z",
						requestRationale: "Not mine",
					},
					effectiveStatus: "pending",
					canDecide: false,
					workItem: { id: "item-10", title: "Someone else's call" },
				},
			],
		);
		expect(rows.map((row) => row.href)).toEqual([
			"/work/items/item-9",
			`/work/interactions/${interaction(1).request.id}`,
		]);
	});
});

describe("WorkPortfolioPage", () => {
	it("renders every bucket in order with empty buckets marked", () => {
		const doc = new DOMParser().parseFromString(
			render(seededClient()),
			"text/html",
		);
		const sections = [
			...doc.querySelectorAll<HTMLElement>("[data-portfolio-bucket]"),
		];
		expect(sections.map((section) => section.dataset.portfolioBucket)).toEqual([
			...PORTFOLIO_BUCKETS,
		]);
		const active = sections[1]!;
		expect(active.textContent).toContain("No records yet");
		expect(active.querySelector("[data-portfolio-card]")).toBeNull();
		const projects = sections[0]!;
		const titles = [...projects.querySelectorAll("[data-portfolio-card] a")]
			.map((link) => link.textContent)
			.filter((text) => text === "Alpha" || text === "Harbor tours");
		expect(titles).toEqual(["Alpha", "Harbor tours"]);
	});

	it("shows brief, lead, counts and the next accepted item on a card", () => {
		const html = render(seededClient());
		expect(html).toContain("Run weekend harbor tours");
		expect(html).toContain("Lead: Nova");
		expect(html).toContain("2 open · 1 accepted");
		expect(html).toContain("At risk");
		expect(html).toContain('href="/work/items/item-accepted"');
		expect(html).toContain("No records yet; owner to define");
		expect(html).toContain("in acme-demo");
		expect(html).toContain("https://acme-demo.os.tedix.dev/work/portfolio");
	});

	it("keeps archived and unbucketed projects in a collapsed Other disclosure", async () => {
		const queryClient = seededClient();
		const html = render(queryClient);
		expect(html).toContain("Other (2)");
		expect(html).not.toContain(`data-portfolio-card="${PROJECTS[3]!.id}"`);
		expect(html).not.toContain(`data-portfolio-card="${PROJECTS[4]!.id}"`);
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		try {
			await act(async () =>
				root.render(
					<QueryClientProvider client={queryClient}>
						<WorkPortfolioPage />
					</QueryClientProvider>,
				),
			);
			const trigger = [...host.querySelectorAll("button")].find((button) =>
				button.textContent?.includes("Other (2)"),
			);
			if (!trigger) throw new Error("Other disclosure missing");
			await act(async () => trigger.click());
			const other = host.querySelector('[aria-label="Other projects"]');
			expect(other?.textContent).toContain("Loose notes");
			expect(other?.textContent).toContain("Old shop");
			expect(other?.textContent).toContain("Archived");
		} finally {
			await act(async () => root.unmount());
			host.remove();
			queryClient.clear();
		}
	});

	it("caps the needs-you strip at five rows and links to the Office", () => {
		const doc = new DOMParser().parseFromString(
			render(
				seededClient({
					interactions: Array.from({ length: 7 }, (_, index) =>
						interaction(index + 1),
					),
				}),
			),
			"text/html",
		);
		const strip = doc.querySelector('[aria-label="Needs you"]');
		expect(strip?.querySelectorAll("li")).toHaveLength(5);
		expect(strip?.textContent).toContain("Question 7");
		expect(strip?.textContent).not.toContain("Question 2");
		expect(doc.querySelector('a[href="/work/office"]')?.textContent).toContain(
			"See all",
		);
	});

	it("scores each factory by tedi and flags one running but idle", () => {
		const doc = new DOMParser().parseFromString(
			render(seededClient()),
			"text/html",
		);
		const nova = doc.querySelector('[aria-label="Nova factories"]');
		const digest = nova?.querySelector(
			'[data-factory="skill_loop:skill-digest"]',
		);
		expect(digest?.textContent).toContain(
			"7 runs (6 ok) · 2 Outputs · 1 Work closed",
		);
		expect(
			digest?.querySelector('a[href="/skills/skill-digest/runs"]'),
		).not.toBeNull();
		expect(
			digest?.querySelector('a[href="/outputs/output-brief"]')?.textContent,
		).toBe("Weekly brief");
		expect(digest?.textContent).not.toContain("Running but idle");
		const crm = doc.querySelector(
			'[aria-label="No tedi factories"] [data-factory="blueprint:bp-crm"]',
		);
		expect(crm?.textContent).toContain("Running but idle");
		expect(crm?.textContent).toContain("No results in the last 30 days");
		expect(crm?.querySelector('a[href="/blueprints"]')).not.toBeNull();
	});

	it("marks paused loops, counts in the singular and folds unused Blueprints into one link", () => {
		const doc = new DOMParser().parseFromString(
			render(
				seededClient({
					factories: [
						factory({
							id: "skill-off",
							paused: true,
							runs: 1,
							succeeded: 1,
							outputs: 1,
						}),
						factory({
							kind: "blueprint",
							id: "bp-unused",
							name: "Unused template",
							tediId: null,
							tediName: null,
							cron: null,
							runs: 0,
							succeeded: 0,
							lastResult: null,
						}),
					],
				}),
			),
			"text/html",
		);
		const paused = doc.querySelector('[data-factory="skill_loop:skill-off"]');
		expect(paused?.textContent).toContain("Paused");
		expect(paused?.textContent).toContain("1 run (1 ok) · 1 Output ·");
		expect(
			doc.querySelector('[data-factory="blueprint:bp-unused"]'),
		).toBeNull();
		expect(doc.querySelector('a[href="/blueprints"]')?.textContent).toBe(
			"1 Blueprint with no runs",
		);
	});

	it("keeps tedis in server order with unassigned factories in their own group", () => {
		expect(
			groupFactories(FACTORIES).map((group) => [
				group.tedi,
				group.factories.map((row) => row.id),
			]),
		).toEqual([
			["Nova", ["skill-digest"]],
			["No tedi", ["bp-crm"]],
		]);
	});

	it("hides the needs-you strip when nothing waits", () => {
		const html = render(seededClient());
		expect(html).not.toContain('aria-label="Needs you"');
	});

	it("shows actionable serialized failure messages", () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, retryOnMount: false } },
		});
		const query = queryClient
			.getQueryCache()
			.build(queryClient, projectPortfolioQueryOptions());
		query.setState({
			status: "error",
			error: { message: "Project access denied. Sign in again." } as Error,
		});
		const html = render(queryClient);
		expect(html).toContain("Portfolio unavailable");
		expect(html).toContain("Project access denied. Sign in again.");
	});
});

describe("Work landing", () => {
	const beforeLoad = WorkIndexRoute.options.beforeLoad as unknown as (input: {
		search: Record<string, unknown>;
	}) => void;

	function thrown(search: Record<string, unknown>) {
		try {
			beforeLoad({ search });
		} catch (error) {
			return error;
		}
		throw new Error("beforeLoad did not redirect");
	}

	it("redirects /work to the Portfolio", () => {
		const result = thrown({});
		expect(isRedirect(result)).toBe(true);
		expect((result as { options: { to: string } }).options.to).toBe(
			"/work/portfolio",
		);
	});

	it("keeps old disposition links on the queue", () => {
		const result = thrown({ disposition: "proposed" });
		expect((result as { options: { to: string } }).options.to).toBe(
			"/work/queue",
		);
	});
});

describe("isPlaceholderBrief", () => {
	it("treats a brief that mentions the placeholder phrase as empty", () => {
		expect(isPlaceholderBrief("No records yet; owner to define")).toBe(true);
		expect(
			isPlaceholderBrief(
				"Portfolio bucket: Leads. No records yet; owner to define purpose.",
			),
		).toBe(true);
		expect(isPlaceholderBrief("Weekly winners report for the shop team.")).toBe(
			false,
		);
	});
});
