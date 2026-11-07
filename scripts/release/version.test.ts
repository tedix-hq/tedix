import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseSteps, runRelease } from "./version";

const root = resolve(import.meta.dirname, "../..");

describe("releaseSteps", () => {
	test("refreshes bun.lock between the version bump and the drift check", () => {
		expect(releaseSteps().map((step) => step.argv.join(" "))).toEqual([
			"bun changeset version",
			"bun install",
			"bun scripts/ci/check-deps.mjs",
		]);
	});
});

describe("runRelease", () => {
	test("runs the steps in order", () => {
		const ran: string[] = [];
		const status = runRelease(root, releaseSteps(), (argv) => {
			ran.push(argv.join(" "));
			return 0;
		});
		expect(status).toBe(0);
		expect(ran).toEqual([
			"bun changeset version",
			"bun install",
			"bun scripts/ci/check-deps.mjs",
		]);
	});

	test("stops at the first failure and reports its exit code", () => {
		const ran: string[] = [];
		const status = runRelease(root, releaseSteps(), (argv) => {
			ran.push(argv.join(" "));
			return argv[1] === "install" ? 7 : 0;
		});
		expect(status).toBe(7);
		expect(ran).toEqual(["bun changeset version", "bun install"]);
	});
});

/**
 * A release run only stays fixed while the documented steps and the
 * package.json entry point both route through this script; either can rot
 * independently, so both are pinned here.
 */
describe("the documented flow stays wired to this script", () => {
	test("package.json exposes release:version at this file", () => {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		);
		const command = manifest.scripts?.["release:version"] ?? "";
		const target = command
			.split(/\s+/)
			.find((part: string) => part.endsWith(".ts"));
		expect(target).toBe("scripts/release/version.ts");
		expect(existsSync(join(root, target))).toBe(true);
	});

	test("CONTRIBUTING.md release steps invoke release:version", () => {
		const contributing = readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
		const releases = contributing.slice(contributing.indexOf("## Releases"));
		expect(releases).toContain("bun run release:version");
	});
});
