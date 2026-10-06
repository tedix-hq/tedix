import { SquaresFour } from "@phosphor-icons/react";
import { describe, expect, it } from "vite-plus/test";
import { matchesCommand } from "./os-command-palette";

const command = {
	id: "canvas",
	title: "Canvas",
	description: "Workspaces, Gadgets, layouts, and previews",
	icon: SquaresFour,
	run: () => undefined,
};

describe("OS command palette matching", () => {
	it("matches title and description tokens without case sensitivity", () => {
		expect(matchesCommand(command, "canvas")).toBe(true);
		expect(matchesCommand(command, "GADGET previews")).toBe(true);
	});

	it("requires every search token", () => {
		expect(matchesCommand(command, "workspace policy")).toBe(false);
		expect(matchesCommand(command, "   ")).toBe(true);
	});
});
