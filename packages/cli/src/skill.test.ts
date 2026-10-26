import { describe, expect, it, spyOn } from "bun:test";
import type { SkillContext } from "./skill";
import { runSkillCommand, skillUsage } from "./skill";

const SKILL_ID = "5eed0005-0000-4000-8000-000000000005";

function harness(reply: unknown) {
	const calls: string[] = [];
	const approvals: string[] = [];
	const ctx: SkillContext = {
		client: {
			runCode: async (source: string) => {
				calls.push(source);
				return reply;
			},
			runCodeWithDestructiveApproval: async (
				source: string,
				reason: string,
			) => {
				calls.push(source);
				approvals.push(reason);
				return reply;
			},
		} as SkillContext["client"],
		color: { enabled: false },
		json: true,
		workspace: "tedix",
		limit: 3,
		flow: {},
	};
	return { calls, approvals, ctx };
}

describe("skill commands", () => {
	it("lists through the canonical org skill callable", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness({
			entries: [{ id: SKILL_ID, lifecycleState: "proven", slug: "demo" }],
		});
		ctx.json = false;
		expect(await runSkillCommand("list", ctx)).toBe(0);
		expect(calls[0]).toContain("skills.list_skills_by_org");
		expect(calls[0]).toContain('"summary":true');
		expect(stdout.mock.calls[0]?.[0]).toContain(SKILL_ID);
		stdout.mockRestore();
	});

	it("shows one persistent skill by UUID", async () => {
		const { calls, ctx } = harness({ id: SKILL_ID });
		expect(await runSkillCommand(`show ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls[0]).toContain("skills.get_skills");
		expect(calls[0]).toContain(`"id":"${SKILL_ID}"`);
	});

	it("runs through flow.run without creating a draft", async () => {
		const { calls, approvals, ctx } = harness({
			skillId: SKILL_ID,
			runId: "run-1",
		});
		expect(await runSkillCommand(`run ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls[0]).toContain("flow.run");
		expect(calls[0]).toContain(
			JSON.stringify(`"skillId":"${SKILL_ID}"`).slice(1, -1),
		);
		expect(calls[0]).not.toContain(JSON.stringify('"source"').slice(1, -1));
		expect(approvals).toHaveLength(1);
	});

	it.each(["/nonexistent/plan.ts", "", "   "])(
		"rejects a file source %j before any gateway call or approval",
		async (file) => {
			const stderr = spyOn(console, "error").mockImplementation(() => {});
			try {
				const { calls, approvals, ctx } = harness({
					skillId: SKILL_ID,
					runId: "run-1",
				});
				ctx.flow.file = file;
				expect(await runSkillCommand(`run ${SKILL_ID}`, ctx)).toBe(2);
				expect(stderr.mock.calls[0]?.[0]).toContain(
					"skill run does not accept --file; use tedix flow run --file <plan.ts>",
				);
				expect(calls).toHaveLength(0);
				expect(approvals).toHaveLength(0);
			} finally {
				stderr.mockRestore();
			}
		},
	);

	it("rejects --file through the executable before contacting the gateway", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				`${import.meta.dir}/index.ts`,
				"skill",
				"run",
				SKILL_ID,
				"--file",
				"/nonexistent/plan.ts",
				"--url",
				"http://127.0.0.1:1/mcp",
				"--json",
			],
			{
				env: { TEDIX_MCP_BEARER_TOKEN: "synthetic-local-validation-token" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(2);
		expect(stdout).toBe("");
		expect(stderr.trim()).toBe(
			"skill run does not accept --file; use tedix flow run --file <plan.ts>",
		);
	});

	it("shares flow status diagnostics without inspection, retries, delegation, or mutation", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, approvals, ctx } = harness({
			executionId: "exec-1",
			result: {
				status: "failed",
				output: { result: "nested" },
				error: { code: "GATEWAY_FAILED", message: "skill status diagnostic" },
			},
		});
		expect(await runSkillCommand("status run-1", ctx)).toBe(2);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
			runId: "run-1",
			status: "failed",
			result: { result: "nested" },
			error: { code: "GATEWAY_FAILED", message: "skill status diagnostic" },
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("flow.status");
		expect(calls[0]).not.toMatch(/flow\.(inspect|retry)|delegat|mutat/);
		expect(approvals).toHaveLength(0);
		stdout.mockRestore();
	});

	it("fails clearly on obsolete or ambiguous verbs", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { calls, ctx } = harness({});
		expect(await runSkillCommand("promote foo", ctx)).toBe(2);
		expect(stderr.mock.calls[0]?.[0]).toContain("unknown skill verb");
		expect(calls).toHaveLength(0);
		stderr.mockRestore();
	});

	it("documents the three distinct surfaces", () => {
		expect(skillUsage()).toContain("persistent, revisioned capabilities");
		expect(skillUsage()).toContain("tedix flow run --file");
		expect(skillUsage()).toContain("tedix workflow");
	});
});

it("fetches standing rules by canonical slug without creating or running a skill", async () => {
	const { calls, ctx } = harness({ entry: { id: SKILL_ID, revision: 2 } });
	expect(await runSkillCommand("show lane-rules", ctx)).toBe(0);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toContain(
		'skills.get_skills_for_mcp({"slug":"lane-rules"})',
	);
});

describe("finding, scheduling, inspecting and editing skills", () => {
	it("finds by name with a projected, paged list", async () => {
		const { calls, ctx } = harness({ entries: [] });
		ctx.limit = 120;
		expect(await runSkillCommand("find ship health", ctx)).toBe(0);
		expect(calls[0]).toContain('"query":"ship health"');
		expect(calls[0]).toContain('"summary":true');
		// Only the listed fields leave the sandbox.
		expect(calls[0]).toContain('["id","slug","title","lifecycleState"]');
		expect(calls).toHaveLength(1);
	});

	it("reads a long list page by page", async () => {
		const pages = [50, 50, 7];
		const calls: string[] = [];
		const { ctx } = harness({});
		ctx.client.runCode = async (source: string) => {
			calls.push(source);
			const size = pages[calls.length - 1] ?? 0;
			return {
				entries: Array.from({ length: size }, (_, i) => ({
					id: `${calls.length}-${i}`,
				})),
			};
		};
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		ctx.limit = 200;
		expect(await runSkillCommand("list", ctx)).toBe(0);
		expect(calls.map((c) => /"offset":(\d+)/.exec(c)?.[1])).toEqual([
			"0",
			"50",
			"100",
		]);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).entries).toHaveLength(
			107,
		);
		stdout.mockRestore();
	});

	it("shows a skill's schedule by slug", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness({
			schedules: [
				{
					cron: "*/10 * * * *",
					enabled: true,
					nextFireAt: "2026-10-26T12:10:00.000Z",
				},
			],
		});
		ctx.json = false;
		expect(await runSkillCommand("schedule ship-health", ctx)).toBe(0);
		expect(calls[0]).toContain("skills.list_skill_workflow_schedules");
		expect(calls[0]).toContain('"slug":"ship-health"');
		expect(String(stdout.mock.calls[0]?.[0])).toContain(
			"next 2026-10-26T12:10:00.000Z",
		);
		stdout.mockRestore();
	});

	it("inspects a run without step output, failed steps first", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const { calls, ctx } = harness({
			steps: [
				{ name: "read", status: "succeeded" },
				{ name: "write", status: "failed", error: "denied" },
			],
		});
		expect(await runSkillCommand("inspect run-1", ctx)).toBe(0);
		expect(calls[0]).toContain("skills.list_skill_workflow_steps");
		expect(calls[0]).toContain('"includeContent":false');
		const printed = JSON.parse(String(stdout.mock.calls[0]?.[0]));
		expect(printed.steps.map((s: { name: string }) => s.name)).toEqual([
			"write",
			"read",
		]);
		stdout.mockRestore();
	});

	it("edits SKILL.md and a script, merging files inside the sandbox", async () => {
		const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const { tmpdir } = await import("node:os");
		const dir = mkdtempSync(join(tmpdir(), "tedix-skill-edit-"));
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "SKILL.md"), "# Ship health\n");
		writeFileSync(join(dir, "scripts", "workflow.ts"), "export {};\n");
		const { calls, ctx } = harness({ id: SKILL_ID, slug: "ship-health" });
		ctx.flow.files = [
			join(dir, "SKILL.md"),
			join(dir, "scripts", "workflow.ts"),
		];
		expect(await runSkillCommand(`edit ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("skills.get_skills");
		expect(calls[0]).toContain("skills.improve_skills");
		expect(calls[0]).toContain(JSON.stringify("# Ship health\n"));
		expect(calls[0]).toContain('"scripts/workflow.ts":"export {};\\n"');
		expect(calls[0]).toContain("...(entry?.files ?? {})");
	});

	it("refuses an edit without files or with a file outside the skill", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { calls, ctx } = harness({});
		expect(await runSkillCommand(`edit ${SKILL_ID}`, ctx)).toBe(2);
		ctx.flow.files = ["/tmp/x/SKILL.md", "/tmp/other.ts"];
		expect(await runSkillCommand(`edit ${SKILL_ID}`, ctx)).toBe(2);
		expect(calls).toHaveLength(0);
		stderr.mockRestore();
	});

	it("shows a bounded summary and reads one file in chunks", async () => {
		const stdout = spyOn(console, "log").mockImplementation(() => {});
		const big = "x".repeat(30_000);
		const calls: string[] = [];
		const { ctx } = harness({});
		ctx.client.runCode = async (source: string) => {
			calls.push(source);
			const offset = Number(/text\.slice\((\d+)/.exec(source)?.[1] ?? 0);
			return source.includes("chunk:")
				? { total: big.length, chunk: big.slice(offset, offset + 12_000) }
				: {
						id: SKILL_ID,
						files: [{ path: "scripts/workflow.ts", chars: 30_000 }],
					};
		};
		expect(await runSkillCommand(`show ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls[0]).toContain("contentPreview");
		expect(calls[0]).not.toContain("chunk:");

		ctx.flow.file = "scripts/workflow.ts";
		stdout.mockClear();
		expect(await runSkillCommand(`show ${SKILL_ID}`, ctx)).toBe(0);
		expect(calls.slice(1)).toHaveLength(3);
		expect(JSON.parse(String(stdout.mock.calls[0]?.[0])).content).toBe(big);
		stdout.mockRestore();
	});

	it("names the files when the requested one is missing", async () => {
		const stderr = spyOn(console, "error").mockImplementation(() => {});
		const { ctx } = harness({
			missingFile: "nope.ts",
			files: ["SKILL.md", "scripts/workflow.ts"],
		});
		ctx.flow.file = "nope.ts";
		expect(await runSkillCommand("show ship-health", ctx)).toBe(2);
		expect(String(stderr.mock.calls[0]?.[0])).toContain(
			"no file nope.ts; files: SKILL.md, scripts/workflow.ts",
		);
		stderr.mockRestore();
	});
});
