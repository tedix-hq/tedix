import { SquaresFour } from "@phosphor-icons/react";
import { describe, expect, it, vi } from "vite-plus/test";
import { WORK_VIEWS } from "@/lib/work-views";
import {
	matchesCommand,
	pageCommands,
	workViewCommands,
} from "./os-command-palette";

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

describe("page commands", () => {
	it("finds admin and account pages by all search tokens and navigates", () => {
		const open = vi.fn();
		const commands = pageCommands(open, "/work");
		for (const [query, path, id] of [
			[
				"go to organization settings",
				"/admin/organization",
				"admin-organization",
			],
			["api keys", "/admin/api-keys", "admin-api-keys"],
			["account profile", "/account/profile", "account-profile"],
		]) {
			const command = commands.find((item) => item.id === `page-${id}`);
			expect(command).toBeDefined();
			expect(matchesCommand(command!, query!)).toBe(true);
			command!.run();
			expect(open).toHaveBeenLastCalledWith(path);
		}
	});
	it("offers every tedi tab using the current tedi identity", () => {
		const open = vi.fn();
		const commands = pageCommands(open, "/team/tedi-1/memory");
		for (const tab of [
			"authority",
			"learning",
			"mailbox",
			"memory",
			"settings",
			"telemetry",
		]) {
			const command = commands.find((item) => item.id === `page-tedi-${tab}`);
			expect(command).toBeDefined();
			expect(matchesCommand(command!, `team tedi ${tab}`)).toBe(true);
			command!.run();
			expect(open).toHaveBeenLastCalledWith(`/team/tedi-1/${tab}`);
		}
	});
	it("never navigates to unresolved dynamic placeholders or mistakes new for a tedi", () => {
		for (const path of ["/work", "/team/new"]) {
			const open = vi.fn();
			const commands = pageCommands(open, path);
			expect(
				commands.some((command) => command.id.startsWith("page-tedi-")),
			).toBe(false);
			commands.forEach((command) => command.run());
			expect(
				open.mock.calls.every(([destination]) => !destination.includes("$")),
			).toBe(true);
		}
	});
});
