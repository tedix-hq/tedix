import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	AllWorkTable,
	allWorkQuery,
	sortWorkItems,
	TriageLink,
	triageCount,
} from "./work-items-view";

const item = (
	id: string,
	overrides: Partial<Parameters<typeof sortWorkItems>[0][number]> = {},
) => ({
	id,
	title: `Item ${id}`,
	disposition: "accepted" as const,
	priority: "medium" as const,
	projectId: null,
	parentWorkItemId: null,
	accountableOwnerType: null,
	accountableOwnerId: null,
	dueDate: null,
	deadline: null,
	metadata: null,
	createdAt: "2026-11-01T00:00:00.000Z",
	...overrides,
});

describe("All work list", () => {
	it("sorts by priority, then the nearest due date, undated last", () => {
		const sorted = sortWorkItems([
			item("low-soon", { priority: "low", dueDate: "2026-11-02" }),
			item("high-undated", { priority: "high" }),
			item("high-late", { priority: "high", dueDate: "2026-12-01" }),
			item("high-soon", { priority: "high", deadline: "2026-11-20" }),
			item("critical", { priority: "critical" }),
			item("medium", {}),
		]);
		expect(sorted.map((row) => row.id)).toEqual([
			"critical",
			"high-soon",
			"high-late",
			"high-undated",
			"medium",
			"low-soon",
		]);
	});

	it("leaves proposed work to Triage unless the status filter asks for it", () => {
		expect(allWorkQuery({})).toEqual({ excludeDisposition: "proposed" });
		expect(
			allWorkQuery({ project: "project-pine", executor: "codex" }),
		).toEqual({
			excludeDisposition: "proposed",
			projectId: "project-pine",
			executor: "codex",
		});
		for (const status of ["proposed", "accepted", "cancelled"] as const)
			expect(allWorkQuery({ status })).toEqual({ disposition: status });
	});

	it("links to Triage with how many proposals wait there", () => {
		const triage = {
			pagination: { total: 3 },
			queues: [{ count: 3 }, { count: 4 }],
		};
		expect(triageCount(triage, undefined)).toBe(7);
		expect(triageCount(triage, "project-pine")).toBe(3);
		expect(triageCount(undefined, undefined)).toBe(0);
		const link = renderToStaticMarkup(<TriageLink count={7} />);
		expect(link).toContain('href="/work?view=triage"');
		expect(link).toContain(">7 in triage</a>");
		expect(
			renderToStaticMarkup(<TriageLink count={3} project="project-pine" />),
		).toContain('href="/work?view=triage&amp;project=project-pine"');
		expect(renderToStaticMarkup(<TriageLink count={0} />)).toBe("");
	});

	it("shows status, project, owner, executor, priority and due date per item", () => {
		const html = renderToStaticMarkup(
			<AllWorkTable
				items={[
					item("cedar", {
						title: "Publish the cedar report",
						disposition: "proposed",
						priority: "critical",
						projectId: "project-pine",
						accountableOwnerType: "user",
						accountableOwnerId: "user-1",
						dueDate: "2026-11-20",
						metadata: { executor: "claude-code" },
					}),
					item("bare", { disposition: "cancelled" }),
					item("child", { parentWorkItemId: "cedar" }),
				]}
				projectNames={new Map([["project-pine", "Pine launch"]])}
				principalNames={new Map([["user:user-1", "Robin Example"]])}
			/>,
		);
		for (const text of [
			'href="/work/items/cedar"',
			"Publish the cedar report",
			"Proposed",
			'href="/work/projects/project-pine"',
			"Pine launch",
			"Robin Example",
			"Claude Code",
			"Critical",
			"Fri 20 Nov",
			"Cancelled",
			"No project",
			"Not set",
			"No due date",
			"No epic",
			'href="/work/items/cedar"',
			"target",
			"Fri 20 Nov",
		])
			expect(html).toContain(text);
		expect(html).not.toMatch(/sprint|milestone/i);
		expect(html).not.toContain("w-max");
	});
});
