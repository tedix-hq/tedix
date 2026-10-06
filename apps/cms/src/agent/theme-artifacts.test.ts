import type {
	NativeProcess as NativeProcess,
	NativeProcessStatus as ProcessStatus,
} from "@tedix/container-runtime/sandbox";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, vi } from "vite-plus/test";
import type { CmsJobClient } from "../sandbox";

function fixture(
	options: {
		state?: "running" | "exited" | "error";
		code?: number;
		timedOut?: boolean;
		signal?: number;
		stdout?: string;
		stderr?: string;
		missing?: boolean;
		truncated?: boolean;
	} = {},
) {
	const base = {
		id: "native-123",
		pid: 123,
		command: ["bun", "run", "build"] as const,
		startedAt: new Date(Date.now() - 1000).toISOString(),
	};
	let state: ProcessStatus =
		options.state === "error"
			? {
					...base,
					state: "error",
					error: { code: "SPAWN", message: "failed" },
					endedAt: new Date().toISOString(),
				}
			: options.state === "exited"
				? {
						...base,
						state: "exited",
						exit: {
							code: options.code ?? 0,
							timedOut: options.timedOut ?? false,
							signal: options.signal,
						},
						endedAt: new Date().toISOString(),
					}
				: { ...base, state: "running" };
	const kill = vi.fn(async () => {
		state = {
			...base,
			state: "exited",
			exit: { code: 143, signal: 15, timedOut: false },
			endedAt: new Date().toISOString(),
		};
	});
	const logSnapshot = vi.fn(async () => ({
		stdout: options.stdout ?? "",
		stderr: options.stderr ?? "",
		truncated: options.truncated ?? false,
	}));
	const waitForPort = vi.fn(async () => {});
	const process = {
		id: base.id,
		pid: 123,
		status: async () => state,
		logSnapshot,
		kill,
		waitForPort,
		waitForExit: async () => ({ code: 143, signal: 15, timedOut: false }),
	} as unknown as NativeProcess;
	let mapped = !options.missing;
	const launchCmsJob = vi.fn(async (..._args: unknown[]) => {
		mapped = true;
		return process.id;
	});
	const sandbox = {
		getCmsJobId: async () => (mapped ? process.id : null),
		getProcess: async () => process,
		launchCmsJob,
	} satisfies CmsJobClient;
	return { sandbox, process, kill, logSnapshot, waitForPort, launchCmsJob };
}
import {
	startThemeArtifactRepoSeed,
	startThemeArtifactRepoCommit,
	readThemeArtifactRepoSeedStatus,
	cancelThemeArtifactRepoSeed,
	type ThemeArtifactSeedContext,
} from "./theme-artifacts";
function context(f: ReturnType<typeof fixture>) {
	const writeFile = vi.fn(async () => undefined);
	return {
		ctx: {
			orgSlug: "acme",
			sandbox: { ...f.sandbox, writeFile },
		} as unknown as ThemeArtifactSeedContext,
		writeFile,
	};
}
describe("CMS native artifact seed", () => {
	it("keeps tokens and remote credentials out of argv", async () => {
		const f = fixture();
		const { ctx, writeFile } = context(f);
		const result = await startThemeArtifactRepoSeed(ctx, {
			jobId: "seed",
			branch: "main",
			forceSeed: false,
			token: "secret-token",
			remote: "https://private.example/repo",
		});
		expect(result.processId).toBe("native-123");
		expect(result).not.toHaveProperty("sessionId");
		expect(writeFile).toHaveBeenCalledTimes(3);
		expect(JSON.stringify(f.launchCmsJob.mock.calls)).not.toContain(
			"secret-token",
		);
		expect(JSON.stringify(f.launchCmsJob.mock.calls)).not.toContain(
			"private.example",
		);
		expect(JSON.stringify(writeFile.mock.calls)).toContain(
			"--exclude 'node_modules'",
		);
	});
	it("requires both native success and seed JSON", async () => {
		const f = fixture({ state: "exited", stdout: '{"commit":"abc"}' });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.status,
		).toBe("complete");
		const bad = fixture({ state: "exited", stdout: "not json" });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(bad).ctx.sandbox, "seed"))
				.status,
		).toBe("failed");
	});
	it("honors native lifetime timeout", async () => {
		const f = fixture({ state: "exited", code: 124, timedOut: true });
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.status,
		).toBe("timeout");
	});
	it("does not kill slow running seeds based on a read clock", async () => {
		const f = fixture();
		expect(
			(await readThemeArtifactRepoSeedStatus(context(f).ctx.sandbox, "seed"))
				.running,
		).toBe(true);
		expect(f.kill).not.toHaveBeenCalled();
	});
	it("cancels explicitly", async () => {
		const f = fixture();
		expect(
			(await cancelThemeArtifactRepoSeed(context(f).ctx.sandbox, "seed"))
				.cancelled,
		).toBe(true);
	});
});

describe("CMS artifact commit", () => {
	it("commits selected files with expected-head CAS and no credential in argv", async () => {
		const root = mkdtempSync(join(tmpdir(), "tedix-cms-artifact-test-"));
		try {
			const remote = join(root, "remote.git");
			const author = join(root, "author");
			execFileSync("git", ["init", "--bare", remote]);
			execFileSync("git", ["clone", remote, author]);
			execFileSync("git", ["-C", author, "config", "user.name", "Test"]);
			execFileSync("git", [
				"-C",
				author,
				"config",
				"user.email",
				"test@example.invalid",
			]);
			const initial = join(author, "src/components/PostCard.astro");
			mkdirSync(dirname(initial), { recursive: true });
			writeFileSync(initial, "old");
			execFileSync("git", ["-C", author, "add", "."]);
			execFileSync("git", ["-C", author, "commit", "-m", "Initial"]);
			execFileSync("git", ["-C", author, "branch", "-M", "main"]);
			execFileSync("git", ["-C", author, "push", "origin", "main"]);
			const expectedHead = execFileSync(
				"git",
				["-C", author, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim();
			const f = fixture();
			const written: string[] = [];
			const ctx = context(f).ctx;
			ctx.sandbox.writeFile = vi.fn(async (path: string, content: string) => {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content);
				written.push(path);
				return { success: true };
			}) as unknown as typeof ctx.sandbox.writeFile;
			const args = {
				branch: "main",
				expectedHead,
				remote,
				token: "secret-token",
				message: "Edit card",
				files: [{ path: "src/components/PostCard.astro", content: "new" }],
			};
			await startThemeArtifactRepoCommit(ctx, args);
			expect(JSON.stringify(f.launchCmsJob.mock.calls)).not.toContain(
				"secret-token",
			);
			const script = written.find((path) => path.endsWith(".sh"));
			expect(script).toBeDefined();
			expect(readFileSync(script!, "utf8")).not.toContain("--force");
			expect(readFileSync(script!, "utf8")).toContain(
				"pack.window=0 -c pack.depth=0 push",
			);
			const result = JSON.parse(
				execFileSync("sh", [script!], { encoding: "utf8" }).trim(),
			);
			expect(result.committed).toBe(true);
			expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
			expect(
				execFileSync("git", ["--git-dir", remote, "rev-parse", "main"], {
					encoding: "utf8",
				}).trim(),
			).toBe(result.commit);
			await startThemeArtifactRepoCommit(ctx, args);
			const staleScript = written
				.filter((path) => path.endsWith(".sh"))
				.at(-1)!;
			const stale = JSON.parse(
				execFileSync("sh", [staleScript], { encoding: "utf8" }).trim(),
			);
			expect(stale).toMatchObject({
				committed: false,
				conflict: true,
				remoteHead: result.commit,
			});
			execFileSync("git", [
				"-C",
				author,
				"pull",
				"--ff-only",
				"origin",
				"main",
			]);
			const outside = join(root, "outside");
			mkdirSync(outside);
			symlinkSync(outside, join(author, "src/components/escape"));
			execFileSync("git", ["-C", author, "add", "src/components/escape"]);
			execFileSync("git", ["-C", author, "commit", "-m", "Add symlink"]);
			execFileSync("git", ["-C", author, "push", "origin", "main"]);
			const symlinkHead = execFileSync(
				"git",
				["-C", author, "rev-parse", "HEAD"],
				{ encoding: "utf8" },
			).trim();
			await startThemeArtifactRepoCommit(ctx, {
				...args,
				expectedHead: symlinkHead,
				files: [{ path: "src/components/escape/owned.txt", content: "bad" }],
			});
			const symlinkScript = written
				.filter((path) => path.endsWith(".sh"))
				.at(-1)!;
			expect(() => execFileSync("sh", [symlinkScript])).toThrow();
			expect(existsSync(join(outside, "owned.txt"))).toBe(false);
			await expect(
				startThemeArtifactRepoCommit(ctx, {
					...args,
					files: [{ path: "src/components/.git/config", content: "bad" }],
				}),
			).rejects.toThrow("Invalid CMS theme artifact path");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

it("keeps terminal duration fixed when observed later", async () => {
	const f = fixture({ state: "exited", code: 0, stdout: '{"commit":"abc"}' });
	const state = await f.process.status();
	const now = vi
		.spyOn(Date, "now")
		.mockReturnValue(Date.parse(state.startedAt) + 600_000);
	try {
		const result = await readThemeArtifactRepoSeedStatus(
			context(f).ctx.sandbox,
			"one",
		);
		expect(result.durationMs).toBe(
			state.state === "running"
				? null
				: Date.parse(state.endedAt!) - Date.parse(state.startedAt),
		);
	} finally {
		now.mockRestore();
	}
});
