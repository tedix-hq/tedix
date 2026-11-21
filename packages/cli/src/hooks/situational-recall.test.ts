import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CACHE_TTLS_MS } from "./context-cache";
import {
	lookOnlyCommand,
	recallForSituation,
	runSituationalRecall,
} from "./situational-recall";
import type { HookDeps } from "./hook-io";
const org = "11111111-1111-4111-8111-111111111111";
describe("pre-tool recall", () => {
	it("shares brief catalog reads, omits expired failed reads and uploads no command", async () => {
		const dir = mkdtempSync(join(tmpdir(), "recall-test-"));
		const calls: string[][] = [];
		const output: string[] = [];
		let offline = false;
		let lessonText = "Apply the companion edit.";
		let now = new Date("2026-10-27T00:00:00Z");
		const deps: HookDeps = {
			now: () => now,
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
			expect(calls.filter((a) => a.includes("code"))).toHaveLength(1);
			expect(JSON.stringify(calls)).not.toContain("apps/example");
			now = new Date(+now + CACHE_TTLS_MS.recall + 1);
			offline = true;
			await runSituationalRecall(deps);
			expect(output).toHaveLength(3);
			offline = false;
			lessonText = "Updated companion edit.";
			await runSituationalRecall(deps);
			expect(calls.filter((a) => a.includes("code"))).toHaveLength(3);
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

it("isolates recall catalogs by owner, organization, gateway, repository and harness", async () => {
	const dir = mkdtempSync(join(tmpdir(), "recall-scopes-"));
	let loginId = "owner-one";
	let origin = "https://github.com/example/one";
	let gateway = "https://one.invalid/mcp";
	let organization = "one";
	let credentialOrganizationId = org;
	let responseOrg = org;
	let requests = 0;
	const deps: HookDeps = {
		cwd: dir,
		env: { TEDIX_CONFIG_DIR: dir },
		stdin: "{}",
		write: () => {},
		read: async (args) => {
			if (args[0] === "setup")
				return {
					status: "bound",
					root: dir,
					workspace: "example",
					org: organization,
					mcpUrl: gateway,
					origin,
					credentialOrganizationId,
				};
			if (args.includes("auth"))
				return {
					workspace: "example",
					wouldUse: "stored-login",
					mcpUrl: gateway,
					storedLogin: { org: organization, loginId },
				};
			requests++;
			return {
				organizationId: responseOrg,
				matched: 0,
				truncated: false,
				lessons: [],
			};
		},
	};
	try {
		const recall = (harness = "codex") =>
			recallForSituation(deps, {}, { harness });
		await Promise.all(Array.from({ length: 4 }, () => recall()));
		expect(requests).toBe(1);
		loginId = "owner-two";
		await recall();
		expect(requests).toBe(2);
		organization = "two";
		await recall();
		expect(requests).toBe(3);
		gateway = "https://two.invalid/mcp";
		await recall();
		expect(requests).toBe(4);
		origin = "https://github.com/example/two";
		await recall();
		expect(requests).toBe(5);
		await recall("claude-code");
		expect(requests).toBe(6);
		credentialOrganizationId = "22222222-2222-4222-8222-222222222222";
		await expect(recall()).rejects.toThrow("organization differs");
		responseOrg = credentialOrganizationId;
		await recall();
		expect(requests).toBe(8);
		// A mismatched response was not cached; a later correct read recovers.
		await recall();
		expect(requests).toBe(8);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("reads the catalog live only for real actions outside the gateway cooldown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "recall-load-"));
	let now = new Date("2026-11-21T12:00:00Z");
	const calls: string[][] = [];
	const output: string[] = [];
	const deps: HookDeps = {
		now: () => now,
		cwd: dir,
		env: { TEDIX_CONFIG_DIR: dir },
		stdin: "",
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
			return {
				organizationId: org,
				matched: 1,
				truncated: false,
				lessons: [
					{
						id: "push-check",
						shortId: "push",
						text: "Run the pre-push check first.",
						scope: { repo: "general", harness: "general", topic: "general" },
						updatedAt: null,
						triggers: { commands: ["git push", "git status"] },
					},
				],
			};
		},
	};
	const bash = (command: string) => {
		deps.stdin = JSON.stringify({
			session_id: "00000000-0000-4000-8000-000000000001",
			tool_name: "Bash",
			tool_input: { command },
		});
		return runSituationalRecall(deps);
	};
	const live = () => calls.filter((a) => a.includes("code")).length;
	try {
		expect(lookOnlyCommand("git status && ls src | head")).toBe(true);
		expect(lookOnlyCommand("git push")).toBe(false);
		expect(lookOnlyCommand("cat $(pass-cli item view x)")).toBe(false);
		// A look-only command with no cached catalog never reads live.
		await bash("git status");
		expect(live()).toBe(0);
		expect(output).toHaveLength(0);
		// While the gateway is cooling down, a real action skips the live read too.
		const cooldown = join(
			dir,
			`gateway-cooldown-${createHash("sha256").update("https://example.invalid").digest("hex")}.json`,
		);
		writeFileSync(cooldown, JSON.stringify({ until: +now + 60_000 }));
		await bash("git push");
		expect(live()).toBe(0);
		now = new Date(+now + 60_001);
		await bash("git push");
		expect(live()).toBe(1);
		expect(output.at(-1)).toContain("pre-push check");
		// Repeating the same situation reuses the answer without any CLI read.
		const before = calls.length;
		await bash("git  push");
		expect(calls.length).toBe(before);
		expect(output).toHaveLength(2);
		// The look-only command now gets its lesson from the shared copy.
		await bash("git status");
		expect(live()).toBe(1);
		expect(output.at(-1)).toContain("pre-push check");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
