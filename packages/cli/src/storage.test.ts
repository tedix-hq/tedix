import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStorageCommand } from "./storage";

const directories: string[] = [];
const saved = process.env.TEDIX_CONFIG_DIR;

afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
	if (saved === undefined) delete process.env.TEDIX_CONFIG_DIR;
	else process.env.TEDIX_CONFIG_DIR = saved;
});

function configDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tedix-storage-cmd-"));
	directories.push(dir);
	process.env.TEDIX_CONFIG_DIR = dir;
	return dir;
}

describe("tedix storage", () => {
	test("reports disk use by area as JSON", async () => {
		const dir = configDir();
		mkdirSync(join(dir, "dispatchers"));
		writeFileSync(join(dir, "dispatchers", "runner.log"), "x".repeat(2048));
		const lines: string[] = [];
		const original = console.log;
		console.log = (line?: unknown) => lines.push(String(line));
		try {
			expect(await runStorageCommand(["--json"])).toBe(0);
		} finally {
			console.log = original;
		}
		const report = JSON.parse(lines.join("\n"));
		expect(report.root).toBe(dir);
		expect(report.areas.map((area: { name: string }) => area.name)).toContain(
			"dispatchers",
		);
		expect(report.total.files).toBe(1);
		expect(report.total.bytes).toBeGreaterThan(0);
		expect(report.retention.logMaxBytes).toBe(10 * 1024 * 1024);
	});

	test("clean --dry-run reports without deleting", async () => {
		const dir = configDir();
		const runs = join(dir, "dispatchers", "runner", "runs");
		mkdirSync(runs, { recursive: true });
		const stale = join(runs, "stale-run.expired-1700000000000");
		mkdirSync(stale, { recursive: true });
		writeFileSync(join(stale, "junk"), "x".repeat(4096));
		const lines: string[] = [];
		const original = console.log;
		console.log = (line?: unknown) => lines.push(String(line));
		try {
			expect(await runStorageCommand(["clean", "--dry-run"])).toBe(0);
		} finally {
			console.log = original;
		}
		expect(lines.join("\n")).toContain("would reclaim");
		expect(lines.join("\n")).toContain("expired 1 run folder");
		// Dry run changed nothing.
		expect(existsSync(stale)).toBe(true);
	});
});
