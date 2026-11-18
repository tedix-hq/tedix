import { describe, expect, it } from "vite-plus/test";
import { skillFolderPaths } from "./skill-folders";

describe("skillFolderPaths", () => {
	it("lists each used folder once, with its parents, sorted", () => {
		expect(
			skillFolderPaths([
				{ folderPath: "reddit/reports" },
				{ folderPath: "reddit" },
				{ folderPath: null },
				{},
				{ folderPath: "finance" },
				{ folderPath: "reddit/reports" },
			]),
		).toEqual(["finance", "reddit", "reddit/reports"]);
	});

	it("is empty when no skill uses a folder", () => {
		expect(skillFolderPaths([{ folderPath: null }])).toEqual([]);
	});
});
