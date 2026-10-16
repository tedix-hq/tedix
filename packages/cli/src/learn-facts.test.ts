import { describe, expect, it } from "bun:test";
import {
	claudeFacts,
	codexFacts,
	foldSubagents,
	repositoryOf,
	repoWebUrl,
	trivial,
	type TranscriptFile,
} from "./learn-facts";

const file: TranscriptFile = {
	harness: "claude-code",
	path: "/home/dev/acme/session.jsonl",
	subagent: false,
	bytes: 0,
	mtimeMs: 0,
};
const user = (content: unknown, extra = {}) => ({
	type: "user",
	sessionId: "session-acme",
	cwd: "/home/dev/acme",
	timestamp: "2026-03-01T10:00:00Z",
	message: { content },
	...extra,
});
const use = (name: string, input: Record<string, unknown>, id = name) => ({
	type: "tool_use",
	name,
	input,
	id,
});
const assistant = (...content: unknown[]) => ({
	type: "assistant",
	message: { content },
});
const result = (content: string, is_error = false) =>
	user([{ type: "tool_result", tool_use_id: "Bash", content, is_error }]);

describe("Claude session facts", () => {
	it("keeps typed asks and collects tool evidence without counting injected text", async () => {
		const facts = await claudeFacts(file, [
			user(
				"Build Acme Planner <system-reminder>Injected instructions</system-reminder>",
			),
			user("Hidden metadata", { isMeta: true }),
			user("<system-reminder>More injected text</system-reminder>"),
			assistant(
				use("Bash", { command: 'git commit -m "feat: x"' }),
				use("Edit", { file_path: "/home/dev/acme/src/planner.ts" }),
				use("Write", { file_path: "/home/dev/acme/docs/plan.md" }),
				use("WebFetch", { url: "https://docs.example.test/planner" }),
				use("Skill", { skill: "acme-review" }),
				use("mcp__plugin_tedix_tedix__code", {
					code: "await work.list_work_items({})",
				}),
			),
			result("[main abc1234] feat: x"),
			result("Error: fictional failure", true),
		]);
		expect(facts?.kind).toBe("interactive");
		expect(facts?.asks.map((a) => a.text)).toEqual(["Build Acme Planner"]);
		expect(facts?.askCount).toBe(1);
		expect(facts?.commits).toEqual([{ sha: "abc1234", subject: "feat: x" }]);
		expect(facts?.filesWritten).toEqual(["src/planner.ts", "docs/plan.md"]);
		expect(facts?.urls).toEqual(["https://docs.example.test/planner"]);
		expect(facts?.skills).toEqual({ "acme-review": 1 });
		expect(facts?.mcp).toEqual({
			"tedix.code": 1,
			"tedix:work.list_work_items": 1,
		});
		expect(facts?.errorCount).toBe(1);
	});

	it("treats an SDK Work continuation as an assignment", async () => {
		const id = "11111111-2222-4333-8444-555555555555";
		const brief = `Continue Tedix Work Item ${id} in CLI workspace connect...`;
		const facts = await claudeFacts(file, [
			user(brief, { entrypoint: "sdk-cli" }),
		]);
		expect(facts).toMatchObject({ kind: "work-run", brief, asks: [] });
		expect(facts!.workItems[id]).toBeGreaterThan(0);
	});

	it("folds a subagent's commits, files and tools into its parent", async () => {
		const parent = (await claudeFacts(file, [user("Build Acme Planner")]))!;
		const child = (await claudeFacts(
			{
				...file,
				subagent: true,
				path: "/x/.claude/projects/dir/session-acme/subagents/agent-a1.jsonl",
			},
			[
				user("Implement the planner", { sessionId: "child-acme" }),
				assistant(
					use("Write", { file_path: "/home/dev/acme/src/task.ts" }),
					use("Bash", { command: 'git commit -m "feat: task"' }),
				),
				result("[main def5678] feat: task"),
			],
		))!;
		expect(child).toMatchObject({ kind: "subagent", parent: "session-acme" });
		const folded = foldSubagents([parent, child]);
		expect(folded).toHaveLength(1);
		expect(folded[0]).toMatchObject({
			subagents: 1,
			tools: { Write: 1, Bash: 1 },
			filesWritten: ["src/task.ts"],
			commits: [{ sha: "def5678", subject: "feat: task" }],
		});
	});
});

describe("Codex and repository facts", () => {
	it("reads the repository, inline commit command and stored goal", async () => {
		const facts = await codexFacts(
			{ ...file, harness: "codex" },
			[
				{
					type: "session_meta",
					payload: {
						id: "codex-acme",
						git: {
							repository_url: "git@code.example.test:acme/planner.git",
						},
					},
				},
				{
					type: "response_item",
					payload: {
						type: "custom_tool_call",
						name: "exec",
						input: `await tools.exec_command({cmd: "git commit -m 'fix: y'"})`,
					},
				},
			],
			new Map([["codex-acme", "Finish Acme Planner"]]),
			new Map(),
		);
		expect(facts).toMatchObject({
			repository: "planner",
			repoUrl: "https://code.example.test/acme/planner",
			title: "Finish Acme Planner",
			commits: [{ sha: "", subject: "fix: y" }],
		});
	});

	it("recognises a Codex subagent", async () => {
		const facts = await codexFacts(
			{ ...file, harness: "codex" },
			[
				{
					type: "session_meta",
					payload: { id: "child-acme", thread_source: "subagent" },
				},
			],
			new Map(),
			new Map(),
		);
		expect(facts?.kind).toBe("subagent");
	});

	it("skips a Reply OK probe but retains a session with a commit", async () => {
		const probe = (await claudeFacts(file, [user("Reply OK")]))!;
		expect(trivial(probe)).toBe(true);
		const committed = (await claudeFacts(file, [
			user("Reply OK"),
			result("[main abc1234] feat: x"),
		]))!;
		expect(trivial(committed)).toBe(false);
	});

	it("normalises SSH and HTTPS repository origins", () => {
		expect(repoWebUrl("git@code.example.test:acme/planner.git")).toBe(
			"https://code.example.test/acme/planner",
		);
		expect(repoWebUrl("https://code.example.test/acme/planner.git")).toBe(
			"https://code.example.test/acme/planner",
		);
	});

	it("finds repository names in worktree and GitHub checkout paths", () => {
		expect(
			repositoryOf("/home/dev/GitHub/planner/.claude/worktrees/topic/"),
		).toBe("planner");
		expect(repositoryOf("/home/dev/GitHub/planner/src")).toBe("planner");
	});
});
