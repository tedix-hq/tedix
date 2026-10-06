import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
	localRepeatCommand,
	parseLocalDevArguments,
	runLocalProcess,
} from "./local-installation";
import { findTopLevelCommand, topLevelHelp } from "./command-registry";

const root = resolve(import.meta.dir, "../../..");
const account = "a".repeat(32);

describe("local installation launcher", () => {
	test("preserves a beta-owned gateway in the repeat command", () => {
		const args = parseLocalDevArguments([
			"--inference",
			"--account-id",
			account,
			"--ai-gateway",
			"beta-gateway",
		]);
		expect(args).toEqual([
			"--inference=workers-ai",
			`--workers-ai-account=${account}`,
			"--ai-gateway=beta-gateway",
		]);
		expect(localRepeatCommand(args)).toBe(
			`tedix dev --inference --account-id ${account} --ai-gateway beta-gateway`,
		);
		for (const invalid of [
			["--ai-gateway", "beta"],
			["--inference", "--account-id", account, "--ai-gateway", "../bad"],
			[
				"--inference",
				"--account-id",
				account,
				"--ai-gateway",
				"beta",
				"--ai-gateway",
				"other",
			],
		])
			expect(() => parseLocalDevArguments(invalid)).toThrow();
	});
	test("defaults offline and maps only explicit Workers AI", () => {
		expect(parseLocalDevArguments([])).toEqual([]);
		expect(
			parseLocalDevArguments(["--inference", "--account-id", account]),
		).toEqual(["--inference=workers-ai", `--workers-ai-account=${account}`]);
	});
	test("teaches the reproducible public command", () => {
		expect(localRepeatCommand([])).toBe("tedix dev");
		expect(
			localRepeatCommand(
				parseLocalDevArguments(["--inference", "--account-id", account]),
			),
		).toBe(`tedix dev --inference --account-id ${account}`);
	});
	test("rejects ambiguous, malformed, and foreign flags", () => {
		for (const args of [
			["--inference"],
			["--account-id", account],
			["--account-id"],
			["--inference", "--account-id", "bad"],
			["--inference=gateway"],
			["--local"],
			["--inference", "--inference"],
			["--account-id", account, "--account-id", account],
		])
			expect(() => parseLocalDevArguments(args)).toThrow();
	});
	test("registers local help without gateway login", async () => {
		for (const command of ["setup", "dev"]) {
			expect(findTopLevelCommand(command)?.surface).toBe("local");
			expect(topLevelHelp(command)).toContain("No Tedix Cloud login");
			expect(topLevelHelp(command)).toContain("Bun and Node.js 22+");
			const result = Bun.spawnSync(
				[process.execPath, "packages/cli/src/index.ts", command, "--help"],
				{ cwd: root },
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("Tedix local installation");
		}
	});
	test("noninteractive setup gives an explicit command instead of prompting", () => {
		const result = Bun.spawnSync(
			[process.execPath, "packages/cli/src/index.ts", "setup"],
			{ cwd: root, stdin: "pipe" },
		);
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("Use tedix dev");
	});
	test("propagates process exit, spawn failure and signal exits", async () => {
		expect(
			await runLocalProcess(process.execPath, ["-e", "process.exit(7)"], root),
		).toBe(7);
		expect(
			await runLocalProcess(
				process.execPath,
				["-e", "process.kill(process.pid, 'SIGINT')"],
				root,
			),
		).toBe(130);
		await expect(
			runLocalProcess("/nonexistent-tedix-bun", [], root),
		).rejects.toThrow();
	});
});
