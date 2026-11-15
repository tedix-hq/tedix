import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	snoozeUntil,
	TriageTable,
	triageQueueOptions,
} from "./work-triage-view";

const item = (id: string, projectId: string | null = null) => ({
	id,
	title: `Proposal ${id}`,
	priority: "high" as const,
	projectId,
	accountableOwnerType: null,
	accountableOwnerId: null,
	acceptanceContract: null,
	version: 1,
	createdAt: "2026-11-01T00:00:00.000Z",
});

describe("Triage view", () => {
	it("offers the organization queue first, then projects by how much waits", () => {
		const names = new Map([
			["project-pine", "Pine launch"],
			["project-oak", "Oak support"],
			["project-fir", "Fir research"],
		]);
		expect(
			triageQueueOptions(
				[
					{ projectId: "project-pine", count: 2 },
					{ projectId: null, count: 4 },
					{ projectId: "project-oak", count: 7 },
				],
				names,
				"project-fir",
			),
		).toEqual([
			{ value: "none", label: "No project yet (4)" },
			{ value: "project-oak", label: "Oak support (7)" },
			{ value: "project-pine", label: "Pine launch (2)" },
			{ value: "project-fir", label: "Fir research (0)" },
		]);
		expect(triageQueueOptions([], names, undefined)).toEqual([
			{ value: "none", label: "No project yet (0)" },
		]);
	});

	it("brings a snoozed proposal back the given number of days later", () => {
		expect(snoozeUntil(7, new Date("2026-11-15T09:30:00.000Z"))).toBe(
			"2026-11-22T09:30:00.000Z",
		);
	});

	it("shows the four exits only to someone who may decide", () => {
		const props = {
			items: [item("cedar"), item("birch", "project-pine")],
			projectNames: new Map([["project-pine", "Pine launch"]]),
		};
		const deciding = renderToStaticMarkup(
			<TriageTable {...props} onExit={() => {}} />,
		);
		for (const label of ["Accept", "Decline", "Duplicate", "Snooze"])
			expect(deciding.split(`>${label}<`).length - 1, label).toBe(2);
		expect(deciding).toContain("No project");
		expect(deciding).toContain("Pine launch");
		expect(deciding).toContain('href="/work/items/cedar"');
		const reading = renderToStaticMarkup(<TriageTable {...props} />);
		expect(reading).not.toContain(">Accept<");
		expect(reading).toContain("Proposal birch");
	});
});
