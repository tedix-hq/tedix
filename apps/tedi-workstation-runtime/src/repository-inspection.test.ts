import { describe, expect, it, vi } from "vite-plus/test";
import type { NativeProcess } from "@tedix/container-runtime/sandbox";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	inspectRepositoryNative,
	parseUnifiedDiff,
} from "./repository-inspection";

const BASELINE = "a".repeat(40);

function processWith(envelope: unknown, exitCode = 0): NativeProcess {
	return {
		id: "inspect",
		status: vi.fn(),
		output: vi.fn(async () => ({
			exitCode,
			stdout: JSON.stringify(envelope),
			stderr: "",
			truncated: false,
			timedOut: false,
		})),
		logSnapshot: vi.fn(async () => ({
			stdout: "",
			stderr: "",
			truncated: false,
		})),
		kill: vi.fn(async () => undefined),
		waitForExit: vi.fn(),
		waitForPort: vi.fn(),
	};
}

function processOutput(
	stdout: string,
	stderr: string,
	exitCode: number,
): NativeProcess {
	const process = processWith({}, exitCode);
	vi.mocked(process.output).mockResolvedValue({
		exitCode,
		stdout,
		stderr,
		truncated: false,
		timedOut: false,
	});
	return process;
}

describe("repository inspection", () => {
	it("returns the bounded native helper envelope", async () => {
		const expected = {
			kind: "git" as const,
			currentSha: "b".repeat(40),
			dataBase64: "",
			stderrBase64: "",
			exitCode: 0,
			timedOut: false,
			truncated: false,
			truncationReasons: [],
			files: [],
		};
		const execute = vi.fn(async () => processWith(expected));
		await expect(
			inspectRepositoryNative(execute, {
				operation: "status",
				repositoryPath: "owner/repo",
				baselineSha: BASELINE,
			}),
		).resolves.toEqual(expected);
		expect(execute).toHaveBeenCalledOnce();
	});

	it("parses bounded unified hunks with immutable line identities", () => {
		expect(
			parseUnifiedDiff(
				"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,2 +2,3 @@\n same\n-old\n+new\n+extra\n\\ No newline at end of file\n",
			),
		).toEqual({
			hunks: [
				{
					header: "@@ -2,2 +2,3 @@",
					oldStart: 2,
					oldLines: 2,
					newStart: 2,
					newLines: 3,
					lines: [
						{ kind: "context", content: "same", oldLine: 2, newLine: 2 },
						{ kind: "deletion", content: "old", oldLine: 3, newLine: null },
						{ kind: "addition", content: "new", oldLine: null, newLine: 3 },
						{ kind: "addition", content: "extra", oldLine: null, newLine: 4 },
						{
							kind: "meta",
							content: "\\ No newline at end of file",
							oldLine: null,
							newLine: null,
						},
					],
				},
			],
			truncationReasons: [],
		});
	});

	it("returns typed files and current commit from the isolated native helper", async () => {
		const root = mkdtempSync(join(tmpdir(), "tedix-inspection-"));
		const repository = join(root, "owner", "repo");
		mkdirSync(repository, { recursive: true });
		try {
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
			execFileSync("git", ["config", "user.email", "test@tedix.dev"], {
				cwd: repository,
			});
			execFileSync("git", ["config", "user.name", "Tedix Test"], {
				cwd: repository,
			});
			writeFileSync(join(repository, "tracked.txt"), "before\n");
			execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
			execFileSync("git", ["commit", "-q", "-m", "baseline"], {
				cwd: repository,
			});
			const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repository,
				encoding: "utf8",
			}).trim();
			writeFileSync(join(repository, "tracked.txt"), "after\n");
			writeFileSync(join(repository, "new.txt"), "new\n");
			const result = await inspectRepositoryNative(
				async (argv) => {
					const child = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
					return processOutput(child.stdout, child.stderr, child.status ?? 1);
				},
				{
					operation: "status",
					repositoryPath: "owner/repo",
					baselineSha: baseline,
				},
				root,
			);
			expect(result.currentSha).toBe(baseline);
			expect(result.files).toEqual([
				{
					path: "tracked.txt",
					status: "modified",
					rawStatus: "M",
					untracked: false,
				},
				{
					path: "new.txt",
					status: "untracked",
					rawStatus: "?",
					untracked: true,
				},
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a failed native helper without an envelope", async () => {
		const execute = vi.fn(async () => processWith("", 1));
		await expect(
			inspectRepositoryNative(execute, {
				operation: "read",
				repositoryPath: "owner/repo",
				baselineSha: BASELINE,
				path: "secret",
			}),
		).rejects.toThrow("failed");
	});

	it("rejects truncated native output", async () => {
		const process = processWith({});
		vi.mocked(process.output).mockResolvedValue({
			exitCode: 0,
			stdout: "{}",
			stderr: "",
			truncated: true,
			timedOut: false,
		});
		await expect(
			inspectRepositoryNative(async () => process, {
				operation: "diff",
				repositoryPath: "owner/repo",
				baselineSha: BASELINE,
			}),
		).rejects.toThrow("truncated");
	});
});
