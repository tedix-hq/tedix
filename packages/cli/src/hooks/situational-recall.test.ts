import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSituationalRecall } from "./situational-recall";
import type { HookDeps } from "./hook-io";
const org = "11111111-1111-4111-8111-111111111111";
describe("pre-tool recall", () => {
	it("reads matched lessons live, omits failed reads and uploads no command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
		const calls: string[][] = [];
		const output: string[] = [];
		let offline = false;
		let lessonText = "Apply the companion edit.";
		const deps: HookDeps = {
			cwd: dir,
			env: { TEDIX_CONFIG_DIR: dir },
			stdin: JSON.stringify({
				tool_name: "Edit",
				tool_input: { file_path: join(dir, "apps/example/worker.jsonc") },
			}),
			write: (s) => output.push(s),
			read: async (args) => {
				calls.push(args);
				if (args[0] === "setup")
					return {
						status: "bound",
						root: dir,
						workspace: "example",
						org: "example",
						mcpUrl: "https://example.invalid/mcp",
						origin: "https://github.com/example/product",
					};
				if (args.includes("auth"))
					return {
						workspace: "example",
						wouldUse: "stored-login",
						mcpUrl: "https://example.invalid/mcp",
						storedLogin: { org: "example", loginId: "user" },
					};
				if (offline) throw new Error("offline");
				return {
					organizationId: org,
					matched: 2,
					truncated: false,
					lessons: [
						{
							id: "12345678-example",
							shortId: "12345678",
							text: lessonText,
							scope: { repo: "general", harness: "general", topic: "general" },
							updatedAt: null,
							triggers: { pathGlobs: ["apps/*/worker.jsonc"] },
						},
						{
							id: "other",
							shortId: "other",
							text: "Other rule",
							scope: { repo: "general", harness: "general", topic: "general" },
							updatedAt: null,
							triggers: { commands: ["tool login"] },
						},
					],
				};
			},
		};
		try {
			await runSituationalRecall(deps);
			await runSituationalRecall(deps);
			deps.stdin = JSON.stringify({
				tool_name: "apply_patch",
				tool_input: {
					command: `*** Begin Patch\n*** Update File: ${join(dir, "apps/example/worker.jsonc")}\n@@\n-a\n+b\n*** End Patch`,
				},
			});
			await runSituationalRecall(deps);
			expect(output).toHaveLength(3);
			const context = JSON.parse(output[0]!).hookSpecificOutput;
			expect(context.hookEventName).toBe("PreToolUse");
			expect(context.additionalContext).toContain("Apply the companion edit");
			expect(context.additionalContext).not.toContain("Other rule");
			expect(calls.filter((a) => a.includes("code"))).toHaveLength(3);
			expect(JSON.stringify(calls)).not.toContain("apps/example");
			offline = true;
			await runSituationalRecall(deps);
			expect(output).toHaveLength(3);
			offline = false;
			lessonText = "Updated companion edit.";
			await runSituationalRecall(deps);
			expect(calls.filter((a) => a.includes("code"))).toHaveLength(5);
			expect(
				JSON.parse(output.at(-1)!).hookSpecificOutput.additionalContext,
			).toContain(lessonText);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("never blocks on a failed catalog or malformed event", async () => {
		const output: string[] = [];
		await runSituationalRecall({
			cwd: "/",
			env: {},
			stdin: "bad",
			write: (s) => output.push(s),
			read: async () => {
				throw Error("offline");
			},
		});
		expect(output).toEqual([]);
	});
});
