import { describe, expect, it, vi } from "vite-plus/test";
import { CmsUnknownProcessOutcomeError } from "./cms-restore-permit";
import {
	clearDeployAttemptBuildOutput,
	createDeployAttemptWorkspace,
	removeDeployAttemptWorkspace,
} from "./deploy-attempt-workspace";

function sandboxFixture(
	exitCode = 0,
	timedOut = false,
	signal?: string,
	truncated = false,
) {
	const commands: string[] = [];
	const sandbox = {
		async exec(argv: [string, ...string[]]) {
			commands.push(argv[2] ?? "");
			return {
				async output() {
					return {
						exitCode,
						timedOut,
						signal,
						stdout: "",
						stderr: exitCode ? "copy failed" : "",
						truncated,
					};
				},
			};
		},
	};
	return { sandbox, commands };
}

describe("CMS deploy attempt workspaces", () => {
	it("copies complete build inputs into a distinct directory per retry", async () => {
		const f = sandboxFixture();
		const uuid = vi.spyOn(crypto, "randomUUID");
		uuid
			.mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
			.mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
		try {
			const first = await createDeployAttemptWorkspace(
				f.sandbox as never,
				"cms-deploy-example-v67",
			);
			const retry = await createDeployAttemptWorkspace(
				f.sandbox as never,
				"cms-deploy-example-v67",
			);
			expect(first.path).not.toBe(retry.path);
			expect(first.stagingAttemptId).not.toBe(retry.stagingAttemptId);
			expect(first.stagingAttemptId).toContain("cms-deploy-example-v67-a");
			expect(f.commands[0]).toContain("cp -a --");
			expect(f.commands[0]).toContain("node_modules|dist|.astro|.wrangler");
			expect(f.commands[0]).toContain(first.path);
			expect(f.commands[1]).toContain(retry.path);
			await clearDeployAttemptBuildOutput(f.sandbox as never, first.path);
			expect(f.commands[2]).toContain(`${first.path}/dist`);
			expect(f.commands[2]).not.toContain("/workspace/dist");
			await removeDeployAttemptWorkspace(f.sandbox as never, first.path);
			expect(f.commands[3]).toBe(`rm -rf -- '${first.path}'`);
		} finally {
			uuid.mockRestore();
		}
	});

	it("fails closed when the private copy cannot complete", async () => {
		const f = sandboxFixture(1);
		await expect(
			createDeployAttemptWorkspace(f.sandbox as never, "cms-deploy-failed"),
		).rejects.toThrow("workspace copy failed");
	});

	it.each([
		[
			"copy",
			(sandbox: never) =>
				createDeployAttemptWorkspace(sandbox, "cms-deploy-failed"),
		],
		[
			"cache cleanup",
			(sandbox: never) =>
				clearDeployAttemptBuildOutput(
					sandbox,
					"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111",
				),
		],
		[
			"workspace cleanup",
			(sandbox: never) =>
				removeDeployAttemptWorkspace(
					sandbox,
					"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111",
				),
		],
	] as const)(
		"marks timed-out %s as an unknown process outcome",
		async (_name, run) => {
			const f = sandboxFixture(1, true);
			await expect(run(f.sandbox as never)).rejects.toBeInstanceOf(
				CmsUnknownProcessOutcomeError,
			);
		},
	);

	it.each([
		[
			"copy",
			(sandbox: never) =>
				createDeployAttemptWorkspace(sandbox, "cms-deploy-failed"),
		],
		[
			"cache cleanup",
			(sandbox: never) =>
				clearDeployAttemptBuildOutput(
					sandbox,
					"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111",
				),
		],
		[
			"workspace cleanup",
			(sandbox: never) =>
				removeDeployAttemptWorkspace(
					sandbox,
					"/tmp/tedix-cms-deploy-11111111-1111-4111-8111-111111111111",
				),
		],
	] as const)("keeps a terminal %s failure ordinary", async (_name, run) => {
		const f = sandboxFixture(1);
		await expect(run(f.sandbox as never)).rejects.not.toBeInstanceOf(
			CmsUnknownProcessOutcomeError,
		);
	});

	it.each([
		["signal", () => sandboxFixture(0, false, "SIGTERM")],
		["truncated output", () => sandboxFixture(0, false, undefined, true)],
	] as const)("keeps %s failure ordinary", async (_name, createFixture) => {
		const f = createFixture();
		await expect(
			createDeployAttemptWorkspace(f.sandbox as never, "cms-deploy-failed"),
		).rejects.not.toBeInstanceOf(CmsUnknownProcessOutcomeError);
	});

	it("uses the immutable starter when a commit supplies all editable source", async () => {
		const f = sandboxFixture();
		await createDeployAttemptWorkspace(
			f.sandbox as never,
			"cms-deploy-example-v67",
			"/workspace-templates/marketing",
		);
		expect(f.commands[0]).toContain("cd '/workspace-templates/marketing'");
		expect(f.commands[0]).not.toContain("rm -rf /workspace");
	});

	it("refuses to remove anything outside a minted attempt directory", async () => {
		const f = sandboxFixture();
		await expect(
			removeDeployAttemptWorkspace(f.sandbox as never, "/workspace"),
		).rejects.toThrow("Invalid CMS deploy attempt workspace");
		await expect(
			clearDeployAttemptBuildOutput(f.sandbox as never, "/workspace"),
		).rejects.toThrow("Invalid CMS deploy attempt workspace");
		expect(f.commands).toHaveLength(0);
	});
});
