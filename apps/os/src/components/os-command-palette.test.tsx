import { SquaresFour } from "@phosphor-icons/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { WORK_VIEWS } from "@/lib/work-views";
import { matchesCommand, workViewCommands } from "./os-command-palette";

const command = {
	id: "canvas",
	title: "Canvas",
	description: "Workspaces, Apps, layouts, and previews",
	icon: SquaresFour,
	run: () => undefined,
};

describe("OS command palette matching", () => {
	it("matches title and description tokens without case sensitivity", () => {
		expect(matchesCommand(command, "canvas")).toBe(true);
		expect(matchesCommand(command, "APP previews")).toBe(true);
	});

	it("requires every search token", () => {
		expect(matchesCommand(command, "workspace policy")).toBe(false);
		expect(matchesCommand(command, "   ")).toBe(true);
	});
});

describe("Work view commands", () => {
	it("offers a Go to command for every registered Work view", () => {
		const open = vi.fn();
		const commands = workViewCommands(open);
		expect(commands.map((command) => command.title)).toEqual(
			WORK_VIEWS.map((view) => `Go to ${view.label}`),
		);
		for (const [index, view] of WORK_VIEWS.entries()) {
			expect(commands[index]!.description).toContain(view.description);
			commands[index]!.run();
			expect(open).toHaveBeenLastCalledWith(view);
		}
		expect(open).toHaveBeenCalledTimes(WORK_VIEWS.length);
	});

	it("is found by the page name and by what the page shows", () => {
		const commands = workViewCommands(() => undefined);
		expect(commands.filter((c) => matchesCommand(c, "approvals"))).toHaveLength(
			1,
		);
		expect(commands.some((c) => matchesCommand(c, "go to projects"))).toBe(
			true,
		);
		expect(commands.some((c) => matchesCommand(c, "budgets"))).toBe(true);
	});
});
