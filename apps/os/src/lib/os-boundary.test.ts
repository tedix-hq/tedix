import { readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { OS_NAVIGATION } from "@/lib/os-navigation";
import { describe, expect, test } from "vite-plus/test";

const OS_ROOT = /[\\/]apps[\\/]os$/.test(process.cwd())
	? process.cwd()
	: resolve(process.cwd(), "apps/os");

const sourceRoot = (relative: string): string => resolve(OS_ROOT, relative);

const SRC = sourceRoot("src");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.")
			? [path]
			: [];
	});
}

describe("Tedix OS boundary", () => {
	test("starts from Activity and exposes every first-party surface", () => {
		expect(OS_NAVIGATION[0]).toMatchObject({ id: "work", path: "/work" });
		expect(OS_NAVIGATION.map(({ id }) => id)).toEqual([
			"work",
			"chat",
			"workspaces",
			"blueprints",
			"outputs",
			"team",
			"skills",
			"sites",
			"gateways",
			"brain",
			"audit",
			"widget",
			"compute",
			"install",
		]);
	});

	test("does not import or address the temporary derived product", () => {
		const source = sourceFiles(SRC)
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(source).not.toMatch(/cloudflare-os/i);
		expect(source).not.toContain("@gadgets/");
		expect(source).not.toContain("products/os");
	});
});
