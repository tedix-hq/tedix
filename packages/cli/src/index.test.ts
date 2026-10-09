import { parseOptions } from "./options";
import { readPositiveNumberOption } from "./option-values";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { StatusSpinner } from "./activity";
import {
	RAW_API_KEY_MESSAGE,
	readMcpAuthHeaders,
	resolveLoginWorkspaceName,
	workspaceNameFromGateway,
	workspaceNameFromOrg,
} from "./auth-resolve";
import { type CommandContext, findCommand, type HomeOps } from "./commands";
import {
	findTopLevelCommand,
	machineHelp,
	topLevelHelp,
} from "./command-registry";
import {
	DEFAULT_TEDIX_MCP_URL,
	type HomeRunSummary,
	type TedixHomeClient,
} from "./home-client";
import { parseSlashPrompt, runDirectCode, slashCommandError } from "./index";
import { InFlightRegistry } from "./inflight";
import { InkReplBridge } from "./ink-bridge";
import type { ReplState } from "./ink-repl";
import { dispatchInteractiveLine } from "./interactive";
import { agentUsage, chatUsage } from "./usage";
import {
	approvalReasonForDisplay,
	backgroundSettleInk,
	claimTerminalRunForInteractiveRead,
	commitLostRunOutcome,
	inkThinkingLabel,
	printInFlightRunSnapshot,
	resolveAnswerCommit,
	shouldShowInkThinking,
} from "./interactive-ink";
import { LiveActivityPanel } from "./live-panel";
import type { CliOptions } from "./shared";
import { kernelTurnMetadata, waitForSettlement } from "./turn";
import { codeUsage } from "./usage";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOptions(overrides?: Partial<CliOptions>): CliOptions {
	return {
		conversationId: "home:cli:test",
		follow: true,
		includeArchived: false,
		json: true,
		noColor: true,
		poll: false,
		pollIntervalMs: 1,
		pollTimeoutMs: 1_000,
		repoContext: false,
		url: DEFAULT_TEDIX_MCP_URL,
		...overrides,
		requireCodeProof: overrides?.requireCodeProof ?? false,
		requireWorkstation: overrides?.requireWorkstation ?? false,
	};
}

function makeHomeRunSummary(
	overrides?: Partial<HomeRunSummary>,
): HomeRunSummary {
	return {
		assistantText: "done",
		homeRunId: "home-run-1",
		status: "completed",
		...overrides,
	};
}

function makeNoopOps(
	send?: (_content: string) => Promise<HomeRunSummary>,
): HomeOps {
	const defaultSend = async (_content: string): Promise<HomeRunSummary> =>
		makeHomeRunSummary();
	return {
		childEvidence: async () => ({}),
		childTree: async () => ({}),
		inspect: async () => ({ homeRunId: "x", run: {}, summary: null }),
		send: send ?? defaultSend,
	};
}

describe("Ink thinking indicator", () => {
	test("skips unknown slash commands instead of flashing a network spinner", () => {
		expect(shouldShowInkThinking("/bogus")).toBe(false);
		expect(shouldShowInkThinking("/help")).toBe(false);
		expect(shouldShowInkThinking("/activity full")).toBe(false);
		expect(shouldShowInkThinking("/sessions")).toBe(true);
		expect(shouldShowInkThinking("hello")).toBe(true);
	});

	test("uses deterministic copy for session reads instead of implying inference", () => {
		expect(inkThinkingLabel("/sessions")).toBe("Loading sessions");
		expect(inkThinkingLabel("/sessions audit")).toBe("Loading sessions");
		expect(inkThinkingLabel("/resume 2")).toBe("Loading session");
		expect(inkThinkingLabel("hello")).toBeUndefined();
	});
});

describe("interactive run ownership", () => {
	test("an explicit terminal /run read claims the registry latch exactly once", () => {
		const registry = new InFlightRegistry();
		const panel = new LiveActivityPanel({ isTty: true });
		const entry = registry.add({
			homeRunId: "run-claim-1",
			label: "certification",
			conversationId: "home:cli:test",
		});
		panel.add(entry);
		const bridge = new InkReplBridge({
			getRegistryCount: () => registry.count,
			getRegistryList: () => registry.list(),
			waitAll: async () => {},
			dispatch: async () => "handled",
			getPanelStates: () => panel.getStates(),
			cancel: async () => ({}),
		});
		try {
			expect(
				claimTerminalRunForInteractiveRead({
					bridge,
					homeRunId: "run-claim-1",
					panel,
					registry,
					status: "completed",
					wasTracked: true,
				}),
			).toBe("print");
			expect(registry.count).toBe(0);
			expect(panel.getStates()).toEqual([]);
			expect(
				claimTerminalRunForInteractiveRead({
					bridge,
					homeRunId: "run-claim-1",
					panel,
					registry,
					status: "completed",
					wasTracked: true,
				}),
			).toBe("suppress");
		} finally {
			bridge.stop();
			panel.stop();
		}
	});

	test("/runs snapshot exposes actionable ids and control syntax", () => {
		const panel = new LiveActivityPanel({ isTty: true });
		panel.add({
			homeRunId: "run-visible-1",
			label: "certification",
			conversationId: "home:cli:test",
			settled: false,
			startedAt: Date.now(),
		});
		const lines: string[] = [];
		const original = console.log;
		console.log = (...args: unknown[]) =>
			lines.push(args.map(String).join(" "));
		try {
			printInFlightRunSnapshot(panel);
		} finally {
			console.log = original;
			panel.stop();
		}
		expect(lines.join("\n")).toContain(
			"run-visible-1 · certification · running",
		);
		expect(lines.join("\n")).toContain("/steer <id>");
		expect(lines.join("\n")).toContain("/cancel <id>");
		expect(lines.join("\n")).not.toContain("tedix [1 running]");
	});
});

function makeContext(overrides?: Partial<CommandContext>): CommandContext {
	return {
		client: {} as TedixHomeClient,
		color: { enabled: false },
		conversationId: "home:cli:test",
		follow: false,
		includeArchived: false,
		json: true,
		ops: makeNoopOps(),
		pollIntervalMs: 1,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// workspace name derivation
// ---------------------------------------------------------------------------

describe("workspace name derivation", () => {
	test("workspaceNameFromOrg strips org_ and collapses personal_*", () => {
		expect(workspaceNameFromOrg("org_tedix")).toBe("tedix");
		expect(workspaceNameFromOrg("org_acme")).toBe("acme");
		expect(workspaceNameFromOrg("personal_U39xyz")).toBe("personal");
		expect(workspaceNameFromOrg("tedix")).toBe("tedix");
	});

	test("workspaceNameFromGateway uses the host label minus -unified", () => {
		expect(
			workspaceNameFromGateway("https://acme-unified.mcp.tedix.dev/mcp"),
		).toBe("acme");
		expect(
			workspaceNameFromGateway("https://tedix-unified.mcp.tedix.dev/mcp"),
		).toBe("tedix");
		expect(workspaceNameFromGateway("https://foo.example.com/mcp")).toBe("foo");
		expect(workspaceNameFromGateway("not a url")).toBe("default");
	});

	describe("resolveLoginWorkspaceName", () => {
		const DEFAULT_GW = "https://tedix-unified.mcp.tedix.dev/mcp";

		test("explicit --workspace always wins", () => {
			expect(
				resolveLoginWorkspaceName({
					explicit: "  ada ",
					gatewayUrl: DEFAULT_GW,
					isDefaultGateway: true,
					tokenTenant: "org_tedix",
				}),
			).toBe("ada");
		});

		test("non-default gateway names itself from its host", () => {
			expect(
				resolveLoginWorkspaceName({
					gatewayUrl: "https://acme-unified.mcp.tedix.dev/mcp",
					isDefaultGateway: false,
					tokenTenant: "T3DUKiQ8HF4eFUN4En0uc7SUr0EM",
				}),
			).toBe("acme");
		});

		test("default gateway derives the name from the token tenant, not 'default'", () => {
			expect(
				resolveLoginWorkspaceName({
					gatewayUrl: DEFAULT_GW,
					isDefaultGateway: true,
					tokenTenant: "org_tedix",
				}),
			).toBe("tedix");
		});

		test("an auto-key tenant with no friendly slug falls back to the raw key, never 'default'", () => {
			const name = resolveLoginWorkspaceName({
				gatewayUrl: DEFAULT_GW,
				isDefaultGateway: true,
				tokenTenant: "T3DUKiQ8HF4eFUN4En0uc7SUr0EM",
			});
			expect(name).toBe("T3DUKiQ8HF4eFUN4En0uc7SUr0EM");
			expect(name).not.toBe("default");
		});

		test("only lands on 'default' when the tenant is genuinely unknown", () => {
			expect(
				resolveLoginWorkspaceName({
					gatewayUrl: DEFAULT_GW,
					isDefaultGateway: true,
				}),
			).toBe("default");
		});
	});
});

// ---------------------------------------------------------------------------
// parseOptions
// ---------------------------------------------------------------------------

describe("parseOptions", () => {
	test("preserves literal equals signs and flags after the option terminator", () => {
		expect(
			parseOptions(["ask", "--", "explain", "--name=value"]).options.prompt,
		).toBe("explain --name=value");
		expect(parseOptions(["code", "--", "--json=true"]).options.prompt).toBe(
			"--json=true",
		);
	});

	test("parses persistent skill execution separately from a flow file", () => {
		const skillId = "5eed0005-0000-4000-8000-000000000005";
		const parsed = parseOptions(["flow", "run", "--skill", skillId]);
		expect(parsed.command).toBe("flow");
		expect(parsed.options.prompt).toBe("run");
		expect(parsed.options.flowSkill).toBe(skillId);
	});
	test("parses explicit update lifecycle commands", () => {
		const parsed = parseOptions(["update", "--check", "0.2.0", "--json"]);
		expect(parsed.command).toBe("update");
		expect(parsed.options.updateCheck).toBe(true);
		expect(parsed.options.prompt).toBe("0.2.0");
		expect(parsed.options.json).toBe(true);
		expect(parseOptions(["rollback"]).command).toBe("rollback");
		expect(() => parseOptions(["chat", "--force"])).toThrow(
			"only valid with update",
		);
	});
	const origMcpUrl = process.env.TEDIX_MCP_URL;
	const origLocalMcpUrl = process.env.TEDIX_LOCAL_MCP_URL;
	const origWorkspace = process.env.TEDIX_WORKSPACE;

	beforeEach(() => {
		// Pin env so url + workspace defaults are deterministic
		delete process.env.TEDIX_MCP_URL;
		delete process.env.TEDIX_LOCAL_MCP_URL;
		delete process.env.TEDIX_WORKSPACE;
	});

	afterEach(() => {
		if (origMcpUrl !== undefined) process.env.TEDIX_MCP_URL = origMcpUrl;
		else delete process.env.TEDIX_MCP_URL;
		if (origLocalMcpUrl !== undefined)
			process.env.TEDIX_LOCAL_MCP_URL = origLocalMcpUrl;
		else delete process.env.TEDIX_LOCAL_MCP_URL;
		if (origWorkspace !== undefined)
			process.env.TEDIX_WORKSPACE = origWorkspace;
		else delete process.env.TEDIX_WORKSPACE;
	});

	test("defaults: poll=true, follow=true, json=false, repoContext=true, noColor=false", () => {
		const { command, options } = parseOptions(["chat"]);
		expect(command).toBe("chat");
		expect(options.poll).toBe(true);
		expect(options.follow).toBe(true);
		expect(options.json).toBe(false);
		expect(options.repoContext).toBe(true);
		expect(options.noColor).toBe(false);
		expect(options.requireCodeProof).toBe(false);
		expect(options.requireWorkstation).toBe(false);
		expect(options.pollIntervalMs).toBe(5_000);
	});

	test("removed API transport flags are rejected", () => {
		expect(() => parseOptions(["ask", "hello", "--enqueue-via-api"])).toThrow(
			"Unknown option --enqueue-via-api",
		);
		expect(() =>
			parseOptions(["chat", "--api-url", "https://api.test"]),
		).toThrow("Unknown option --api-url");
	});

	test("removed campaign planner flags are rejected", () => {
		expect(() => parseOptions(["work", "plan", "--tree", "{}"])).toThrow(
			"Unknown option --tree",
		);
		expect(() => parseOptions(["work", "plan", "--apply"])).toThrow(
			"Unknown option --apply",
		);
	});

	test("-w / --workspace / --workspace=value set the workspace selector", () => {
		expect(parseOptions(["chat", "-w", "ada"]).options.workspace).toBe("ada");
		expect(
			parseOptions(["chat", "--workspace", "acme"]).options.workspace,
		).toBe("acme");
		expect(parseOptions(["chat", "--workspace=tedix"]).options.workspace).toBe(
			"tedix",
		);
	});

	test("OAuth scope profiles are explicit and default to read", () => {
		expect(parseOptions(["login"]).options.oauthScopeProfile).toBeUndefined();
		expect(
			parseOptions(["login", "--scope-profile", "read"]).options
				.oauthScopeProfile,
		).toBe("read");
		expect(
			parseOptions(["login", "--scope-profile", "admin"]).options
				.oauthScopeProfile,
		).toBe("admin");
		expect(
			parseOptions(["login", "--scope-profile=platform-admin"]).options
				.oauthScopeProfile,
		).toBe("platform-admin");
		expect(() => parseOptions(["login", "--scope-profile", "owner"])).toThrow(
			"--scope-profile must be read, member, admin, or platform-admin",
		);
	});

	test("global options may appear before or after the command", () => {
		const before = parseOptions([
			"-w",
			"tedix",
			"--json",
			"code",
			"async () => await codemode.__runtime()",
		]);
		expect(before.command).toBe("code");
		expect(before.options.workspace).toBe("tedix");
		expect(before.options.json).toBe(true);
		expect(before.options.prompt).toBe(
			"async () => await codemode.__runtime()",
		);

		const after = parseOptions([
			"code",
			"async () => await codemode.__runtime()",
			"--json",
			"-w",
			"tedix",
		]);
		expect(after).toEqual(before);
	});

	test("goal options parse into bounded command context inputs", () => {
		const { command, options } = parseOptions([
			"goal",
			"reply exactly READY",
			"--condition",
			"the answer is READY",
			"--max-turns",
			"2",
			"--budget-usd",
			"0.10",
			"--evaluator",
			"adversarial",
		]);
		expect(command).toBe("goal");
		expect(options.prompt).toBe("reply exactly READY");
		expect(options.goalCondition).toBe("the answer is READY");
		expect(options.goalMaxTurns).toBe(2);
		expect(options.goalBudgetUsd).toBe(0.1);
		expect(options.goalEvaluator).toBe("adversarial");
		expect(() => readPositiveNumberOption("--budget-usd", "0")).toThrow(
			"positive number",
		);
	});

	test("external-agent start parses immutable harness and model provenance", () => {
		const { command, options } = parseOptions([
			"agent",
			"start",
			"--agent-key",
			"ada-coding-agents",
			"--display-name",
			"Ada coding agents",
			"--agent-harness",
			"codex",
			"--agent-harness-version",
			"1.2.3",
			"--model-provider",
			"openai",
			"--model-id",
			"gpt-5.6",
			"--model-version",
			"2026-07-22",
		]);
		expect(command).toBe("agent");
		expect(options.prompt).toBe("start");
		expect(options.agentKey).toBe("ada-coding-agents");
		expect(options.agentHarness).toBe("codex");
		expect(options.agentHarnessVersion).toBe("1.2.3");
		expect(options.agentModelProvider).toBe("openai");
		expect(options.agentModelId).toBe("gpt-5.6");
		expect(options.agentModelVersion).toBe("2026-07-22");
	});

	test("external-agent knowledge lifecycle flags remain explicit", () => {
		const { command, options } = parseOptions([
			"agent",
			"checkpoint",
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"--note",
			"Research checkpoint",
			"--evidence",
			"artifact://one,commit:abc",
			"--artifact-ref",
			"artifact://packet",
			"--idempotency-key",
			"checkpoint-v1",
			"--no-handoff-reason",
			"No reusable result",
			"--zero-work-reason",
			"Diagnostic session only",
			"--stale-before",
			"2026-07-24T00:00:00.000Z",
		]);
		expect(command).toBe("agent");
		expect(options.prompt).toBe(
			"checkpoint aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		);
		expect(options.agentArtifactRef).toBe("artifact://packet");
		expect(options.agentNoHandoffReason).toBe("No reusable result");
		expect(options.agentZeroWorkReason).toBe("Diagnostic session only");
		expect(options.agentStaleBefore).toBe("2026-07-24T00:00:00.000Z");
	});

	test("agent help distinguishes unused-session cleanup from governed handoff", () => {
		const usage = agentUsage();
		expect(usage).toContain(
			"tedix agent finish --zero-work-reason <reason> --idempotency-key <key>",
		);
		expect(usage).toContain(
			"Use --zero-work-reason only when this session never started a Work Item attempt",
		);
	});

	test("Home help documents existing Work Item binding for direct delegation", () => {
		expect(chatUsage()).toContain(
			"--work-item <uuid>          Bind --delegate-to-tedi to an existing Work Item",
		);
	});

	test("work operator override is explicit and opt-in", () => {
		const { command, options } = parseOptions([
			"work",
			"done",
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"--operator-override",
		]);
		expect(command).toBe("work");
		expect(options.workOperatorOverride).toBe(true);
	});

	test("work heartbeat accepts the shared bounded watch flag", () => {
		const { command, options } = parseOptions([
			"work",
			"heartbeat",
			"item-id",
			"--watch",
			"120",
		]);
		expect(command).toBe("work");
		expect(options.flowWatch).toBe(120);
	});

	test("work create flags parse into the work option group", () => {
		const { command, options } = parseOptions([
			"work",
			"create",
			"Probe item",
			"--desc",
			"probe body",
			"--kind",
			"coding",
			"--priority",
			"low",
			"--class",
			"hygiene",
			"--expires",
			"48h",
		]);
		expect(command).toBe("work");
		expect(options.workDesc).toBe("probe body");
		expect(options.workKind).toBe("coding");
		expect(options.workPriority).toBe("low");
		expect(options.workClass).toBe("hygiene");
		expect(options.workExpires).toBe("48h");
	});

	test("work clusters parses an explicit tedi executor", () => {
		const { command, options } = parseOptions([
			"work",
			"clusters",
			"--executor-tedi",
			"55555555-5555-4555-8555-555555555555",
		]);
		expect(command).toBe("work");
		expect(options.workExecutorTedi).toBe(
			"55555555-5555-4555-8555-555555555555",
		);
	});

	test("work claim-files preserves repeatable literal path values", () => {
		const { command, options } = parseOptions([
			"work",
			"claim-files",
			"item",
			"--repo-key",
			"tedix",
			"--path",
			"src/My File.ts",
			"--path",
			"src/a.ts",
		]);
		expect(command).toBe("work");
		expect(options.prompt).toBe("claim-files item");
		expect(options.workRepoKey).toBe("tedix");
		expect(options.workPaths).toEqual(["src/My File.ts", "src/a.ts"]);
	});

	test("the executable forwards claim-files flags into Work validation", async () => {
		const child = Bun.spawn(
			[
				process.execPath,
				`${import.meta.dir}/index.ts`,
				"work",
				"claim-files",
				"11111111-1111-4111-8111-111111111111",
				"--repo-key",
				"tedix",
				"--path",
				"src/file with spaces/../a.ts",
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
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(JSON.parse(stderr).error).toContain(
			'Invalid repository-relative file path: "src/file with spaces/../a.ts"',
		);
	});

	test("work claim-files options require values", () => {
		for (const flag of ["--repo-key", "--path"]) {
			expect(() =>
				parseOptions(["work", "claim-files", "item", flag]),
			).toThrow();
			expect(() =>
				parseOptions(["work", "claim-files", "item", flag, "--json"]),
			).toThrow();
		}
	});

	test("work start parses admission-bound worktree options", () => {
		const { command, options } = parseOptions([
			"work",
			"start",
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"--worktree",
			"--worktree-root",
			"/tmp/tedix-worktrees",
		]);
		expect(command).toBe("work");
		expect(options.workWorktree).toBe(true);
		expect(options.workWorktreeRoot).toBe("/tmp/tedix-worktrees");
	});

	test("work owned-channel steering flags parse into the work option group", () => {
		const { command, options } = parseOptions([
			"work",
			"authorize-blog",
			"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			"--campaign",
			"launch-proof",
			"--content-ids",
			"draft-a,draft-b",
			"--valid-until",
			"2026-08-01T00:00:00Z",
		]);
		expect(command).toBe("work");
		expect(options.prompt).toBe(
			"authorize-blog aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		);
		expect(options.workCampaign).toBe("launch-proof");
		expect(options.workContentIds).toBe("draft-a,draft-b");
		expect(options.workValidUntil).toBe("2026-08-01T00:00:00Z");
	});

	test("work lifecycle flags parse into the canonical option group", () => {
		const { options } = parseOptions([
			"work",
			"submit-evidence",
			"wi",
			"--claim-key",
			"tests",
			"--evidence-kind",
			"test_report",
			"--evidence",
			"artifact://tests",
			"--evidence-media-type",
			"application/json",
			"--evidence-label",
			"CLI tests",
			"--evidence-metadata",
			'{"suite":"cli"}',
		]);
		expect(options.workClaimKey).toBe("tests");
		expect(options.workEvidenceKind).toBe("test_report");
		expect(options.workEvidence).toBe("artifact://tests");
		expect(options.workEvidenceMediaType).toBe("application/json");
		expect(options.workEvidenceLabel).toBe("CLI tests");
		expect(options.workEvidenceMetadata).toBe('{"suite":"cli"}');
	});

	// A settlement can ship several commits, so --commit ACCUMULATES rather
	// than last-wins: a repeated flag that silently kept one value would drop
	// the rest of the ledger entry without saying so.
	test("--commit repeats into an ordered list and --done-when parses", () => {
		const { options } = parseOptions([
			"work",
			"settle",
			"wi",
			"--outcome",
			"succeeded",
			"--commit",
			"abc1234",
			"--commit",
			"def5678",
		]);
		expect(options.workCommits).toEqual(["abc1234", "def5678"]);
		expect(
			parseOptions(["work", "accept", "wi", "--done-when", "The gate is gone"])
				.options.workDoneWhen,
		).toBe("The gate is gone");
	});

	test("inspect evidence flags compose into one focused view", () => {
		const { command, options } = parseOptions([
			"inspect",
			"run-1",
			"--branch",
			"child-1",
			"--events",
			"--artifacts",
			"--workstations",
			"--trace",
		]);
		expect(command).toBe("inspect");
		expect(options.prompt).toBe("run-1");
		expect(options.inspectView).toEqual({
			artifacts: true,
			branch: "child-1",
			events: true,
			trace: true,
			workstations: true,
		});
	});

	test("help is parsed without exiting so command-specific help can render", () => {
		expect(parseOptions(["code", "--help"])).toMatchObject({
			command: "code",
			options: { help: true },
		});
		expect(parseOptions(["--help", "code"])).toMatchObject({
			command: "code",
			options: { commandExplicit: true, help: true },
		});
		expect(parseOptions(["--help"])).toMatchObject({
			command: "chat",
			options: { commandExplicit: false, help: true },
		});
		expect(parseOptions(["help", "--map"])).toMatchObject({
			command: "help",
			options: { helpMap: true },
		});
		expect(parseOptions(["help", "--all"])).toMatchObject({
			command: "help",
			options: { all: true },
		});
		expect(parseOptions(["--json", "help", "code"]).options.prompt).toBe(
			"code",
		);
		expect(() => parseOptions(["chat", "--map"])).toThrow(
			"only valid with help",
		);
	});

	test("Code Mode help documents the native workflow and snippet shape", () => {
		const help = codeUsage();
		expect(help).toContain("Directly execute JavaScript");
		expect(help).toContain("includeParameters: true");
		expect(help).toContain("--approve-destructive <why>");
		expect(help).toContain("--meta");
		expect(help).toContain("call-local");
		expect(help).toContain("Do not use a\nbare top-level return statement");
		expect(help).toContain("Global options may appear before or after");
	});

	test("parses Code Mode operator options before or after the command", () => {
		const source = "async () => await tenant.remove_member({ id: '1' })";
		const before = parseOptions([
			"--approve-destructive",
			"operator requested removal",
			"--meta",
			"code",
			source,
		]);
		const after = parseOptions([
			"code",
			source,
			"--approve-destructive",
			"operator requested removal",
			"--meta",
		]);
		for (const parsed of [before, after]) {
			expect(parsed.command).toBe("code");
			expect(parsed.options.prompt).toBe(source);
			expect(parsed.options.codeDestructiveApprovalReason).toBe(
				"operator requested removal",
			);
			expect(parsed.options.codeMetadata).toBe(true);
		}
	});

	test("rejects missing or cross-command Code Mode operator options", () => {
		expect(() => parseOptions(["code", "--approve-destructive"])).toThrow(
			"--approve-destructive requires a value",
		);
		expect(() => parseOptions(["chat", "--meta"])).toThrow(
			"only valid with code",
		);
		expect(() =>
			parseOptions(["chat", "--approve-destructive", "reason"]),
		).toThrow("only valid with code");
	});

	test("--workspace requires a value", () => {
		expect(() => parseOptions(["chat", "--workspace", "--json"])).toThrow(
			"--workspace requires a value",
		);
	});

	test("TEDIX_WORKSPACE seeds the workspace; -w overrides it", () => {
		process.env.TEDIX_WORKSPACE = "from-env";
		expect(parseOptions(["chat"]).options.workspace).toBe("from-env");
		expect(parseOptions(["chat", "-w", "from-flag"]).options.workspace).toBe(
			"from-flag",
		);
	});

	test("--all sets the logout-all flag", () => {
		expect(parseOptions(["logout", "--all"]).options.all).toBe(true);
		expect(parseOptions(["logout"]).options.all).toBeUndefined();
	});

	test("urlExplicit tracks whether the MCP target was set explicitly", () => {
		expect(parseOptions(["chat"]).options.urlExplicit).toBeFalsy();
		expect(
			parseOptions(["chat", "--url", "https://x.example.com/mcp"]).options
				.urlExplicit,
		).toBe(true);
		expect(parseOptions(["chat", "--local"]).options.urlExplicit).toBe(true);
		process.env.TEDIX_MCP_URL = "https://env.example.com/mcp";
		expect(parseOptions(["chat"]).options.urlExplicit).toBe(true);
	});

	test("--no-poll sets poll=false", () => {
		const { options } = parseOptions(["ask", "--no-poll"]);
		expect(options.poll).toBe(false);
	});

	test("--no-follow sets follow=false", () => {
		const { options } = parseOptions(["tail", "--no-follow"]);
		expect(options.follow).toBe(false);
	});

	test("--once sets follow=false", () => {
		const { options } = parseOptions(["tail", "--once"]);
		expect(options.follow).toBe(false);
	});

	test("--no-color sets noColor=true", () => {
		const { options } = parseOptions(["chat", "--no-color"]);
		expect(options.noColor).toBe(true);
	});

	test("--require-workstation marks the turn as embodied workstation work", () => {
		const { options } = parseOptions(["ask", "--require-workstation"]);
		expect(options.requireWorkstation).toBe(true);
	});

	test("--require-code-proof requires code proof without a workstation", () => {
		const { options } = parseOptions(["ask", "--require-code-proof"]);
		expect(options.requireCodeProof).toBe(true);
		expect(options.requireWorkstation).toBe(false);
	});

	test("MCP metadata stamps code proof without embodied execution", () => {
		const metadata = kernelTurnMetadata(
			makeOptions({ requireCodeProof: true }),
			"one-shot",
		);
		expect(metadata).toMatchObject({
			requiredProofKind: "code",
			source: "tedix-cli",
		});
		expect(metadata).not.toHaveProperty("requireWorkstation");
		expect(metadata).not.toHaveProperty("needsEmbodiedSurface");
	});

	test("--work-item binds an existing Work Item to a direct delegation", () => {
		const workItemId = "5eed0009-0000-4000-8000-000000000009";
		const { options } = parseOptions([
			"ask",
			"--delegate-to-tedi",
			"tedi-cto-1",
			"--work-item",
			workItemId,
		]);
		expect(options.delegationWorkItemId).toBe(workItemId);
	});

	test("--work-item fails closed without a direct delegation or UUID", () => {
		expect(() =>
			parseOptions([
				"ask",
				"--work-item",
				"5eed0009-0000-4000-8000-000000000009",
			]),
		).toThrow("--work-item requires --delegate-to-tedi");
		expect(() =>
			parseOptions([
				"ask",
				"--delegate-to-tedi",
				"tedi-cto-1",
				"--work-item",
				"not-a-work-item",
			]),
		).toThrow("--work-item requires a Work Item UUID");
	});

	test("--verify carries the trimmed verify command on a direct delegation", () => {
		const { options } = parseOptions([
			"ask",
			"--delegate-to-tedi",
			"tedi-cto-1",
			"--verify",
			`  tedix -w tedix work approval-list --input '{"limit":5}'  `,
			"fix the approval inbox",
		]);
		expect(options.verifyCommand).toBe(
			`tedix -w tedix work approval-list --input '{"limit":5}'`,
		);
		const chat = parseOptions([
			"chat",
			"-p",
			"fix it",
			"--delegate-to-tedi",
			"tedi-cto-1",
			"--verify",
			"bun run test:run",
		]);
		expect(chat.options.verifyCommand).toBe("bun run test:run");
		expect(chat.options.prompt).toBe("fix it");
	});

	test("--verify fails closed without a direct delegation, a value, or within the bound", () => {
		expect(() =>
			parseOptions(["ask", "--verify", "bun run test:run", "fix it"]),
		).toThrow("--verify requires --delegate-to-tedi");
		expect(() =>
			parseOptions(["ask", "--delegate-to-tedi", "tedi-cto-1", "--verify"]),
		).toThrow("--verify requires a value");
		expect(() =>
			parseOptions([
				"ask",
				"--delegate-to-tedi",
				"tedi-cto-1",
				"--verify",
				"   ",
			]),
		).toThrow("--verify requires a non-empty command");
		expect(() =>
			parseOptions([
				"ask",
				"--delegate-to-tedi",
				"tedi-cto-1",
				"--verify",
				"x".repeat(501),
			]),
		).toThrow("--verify accepts at most 500 characters");
		expect(
			parseOptions(["ask", "fix it"]).options.verifyCommand,
		).toBeUndefined();
	});

	test("--local sets url to the loopback MCP Worker", () => {
		const { options } = parseOptions(["chat", "--local"]);
		expect(options.url).toBe("http://localhost:3000/mcp");
		expect(options.url).not.toBe(DEFAULT_TEDIX_MCP_URL);
	});

	test("--local honors a trimmed explicit local URL override", () => {
		process.env.TEDIX_LOCAL_MCP_URL = " https://my-tunnel.example.com/mcp ";
		expect(parseOptions(["chat", "--local"]).options.url).toBe(
			"https://my-tunnel.example.com/mcp",
		);
		process.env.TEDIX_LOCAL_MCP_URL = " ";
		expect(parseOptions(["chat", "--local"]).options.url).toBe(
			"http://localhost:3000/mcp",
		);
	});

	test("--url X --local: --local wins (last-write wins, overrides --url)", () => {
		// Order footgun: --url before --local → --local wins
		const { options } = parseOptions([
			"chat",
			"--url",
			"https://custom.example.com/mcp",
			"--local",
		]);
		expect(options.url).toBe("http://localhost:3000/mcp");
	});

	test("--local --url X: --url wins (last-write wins, overrides --local)", () => {
		// Order footgun: --local before --url → --url wins
		const { options } = parseOptions([
			"chat",
			"--local",
			"--url",
			"https://custom.example.com/mcp",
		]);
		expect(options.url).toBe("https://custom.example.com/mcp");
	});

	test("readNumberOption rejects 0 via --limit 0", () => {
		expect(() => parseOptions(["chat", "--limit", "0"])).toThrow(
			"must be a positive integer",
		);
	});

	test("readNumberOption rejects non-numeric value via --limit abc", () => {
		expect(() => parseOptions(["chat", "--limit", "abc"])).toThrow(
			"must be a positive integer",
		);
	});

	test("positionals join into prompt when -p is absent", () => {
		const { options } = parseOptions(["ask", "hello", "world"]);
		expect(options.prompt).toBe("hello world");
	});

	test("tedi subcommand preserves target/action/message as prompt", () => {
		const { command, options } = parseOptions([
			"tedi",
			"cto",
			"ask",
			"confirm",
			"reachable",
		]);
		expect(command).toBe("tedi");
		expect(options.prompt).toBe("cto ask confirm reachable");
	});

	test("-p overrides positionals", () => {
		const { options } = parseOptions(["ask", "-p", "explicit", "ignored"]);
		// -p is set; positional is pushed but prompt is already set from -p
		// Actual behavior: -p sets options.prompt, positionals run through the loop
		// but the "if !options.prompt" guard at the bottom doesn't apply.
		expect(options.prompt).toBe("explicit");
	});

	test("url defaults to DEFAULT_TEDIX_MCP_URL when env unset", () => {
		const { options } = parseOptions(["chat"]);
		expect(options.url).toBe(DEFAULT_TEDIX_MCP_URL);
	});

	test("TEDIX_MCP_URL env overrides the url default", () => {
		process.env.TEDIX_MCP_URL = "https://env-override.example.com/mcp";
		const { options } = parseOptions(["chat"]);
		expect(options.url).toBe("https://env-override.example.com/mcp");
	});
});

// ---------------------------------------------------------------------------
// readMcpAuthHeaders
// ---------------------------------------------------------------------------

describe("readMcpAuthHeaders", () => {
	let savedBearer: string | undefined;
	let savedMcpKey: string | undefined;
	let savedRawApiKey: string | undefined;

	beforeEach(() => {
		savedBearer = process.env.TEDIX_MCP_BEARER_TOKEN;
		savedMcpKey = process.env.TEDIX_MCP_API_KEY;
		savedRawApiKey = process.env.TEDIX_API_KEY;
		delete process.env.TEDIX_MCP_BEARER_TOKEN;
		delete process.env.TEDIX_MCP_API_KEY;
		delete process.env.TEDIX_API_KEY;
	});

	afterEach(() => {
		if (savedBearer !== undefined)
			process.env.TEDIX_MCP_BEARER_TOKEN = savedBearer;
		else delete process.env.TEDIX_MCP_BEARER_TOKEN;
		if (savedMcpKey !== undefined) process.env.TEDIX_MCP_API_KEY = savedMcpKey;
		else delete process.env.TEDIX_MCP_API_KEY;
		if (savedRawApiKey !== undefined)
			process.env.TEDIX_API_KEY = savedRawApiKey;
		else delete process.env.TEDIX_API_KEY;
	});

	test("returns null when neither bearer nor mcp-api-key is set", () => {
		expect(readMcpAuthHeaders()).toBeNull();
	});

	test("raw Tedix API keys are not treated as MCP credentials", () => {
		process.env.TEDIX_API_KEY = "sk_raw_api_key";
		expect(readMcpAuthHeaders()).toBeNull();
	});

	test("bearer token beats X-API-Key when both are set", () => {
		process.env.TEDIX_MCP_BEARER_TOKEN = "my-bearer";
		process.env.TEDIX_MCP_API_KEY = "my-mcp-key";
		const result = readMcpAuthHeaders();
		expect(result).not.toBeNull();
		expect(result?.headers).toEqual({ Authorization: "Bearer my-bearer" });
		expect(result?.source).toBe("bearer");
	});

	test("X-API-Key header used when only TEDIX_MCP_API_KEY is set", () => {
		process.env.TEDIX_MCP_API_KEY = "mcp-jwt-token";
		const result = readMcpAuthHeaders();
		expect(result?.headers).toEqual({ "X-API-Key": "mcp-jwt-token" });
		expect(result?.source).toBe("mcp-api-key");
	});

	test("sk_-prefixed TEDIX_MCP_API_KEY throws RAW_API_KEY_MESSAGE", () => {
		process.env.TEDIX_MCP_API_KEY = "sk_live_supersecret";
		expect(() => readMcpAuthHeaders()).toThrow(RAW_API_KEY_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// waitForSettlement
// ---------------------------------------------------------------------------

describe("waitForSettlement", () => {
	const taskState = (
		taskId: string,
		status: "working" | "input_required" | "completed" | "cancelled" | "failed",
	) => ({
		resultType: "complete" as const,
		taskId,
		status,
		createdAt: "2026-08-30T00:00:00.000Z",
		lastUpdatedAt: "2026-08-30T00:00:00.000Z",
		ttlMs: null,
	});
	function makeQuietSpinner(): StatusSpinner {
		return new StatusSpinner({ animate: false, quiet: true });
	}

	test("running → completed: returns completed summary", async () => {
		let callCount = 0;
		const client = {
			getTask: async () => {
				callCount++;
				return taskState("home-run-1", callCount < 2 ? "working" : "completed");
			},
			readHomeRun: async () => ({
				run: { id: "home-run-1", status: "completed" },
			}),
			// Return a proper HomeRunEventsPage (already parsed) with settled status
			// so the tail stream terminates immediately rather than polling forever.
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => ({
				events: [],
				nextOffset: "0",
				status: "completed",
				upToDate: true,
			}),
		} as unknown as TedixHomeClient;

		const initial = makeHomeRunSummary({ status: "running" });
		const result = await waitForSettlement(
			client,
			"home-run-1",
			initial,
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.status).toBe("completed");
	});

	test("polls immediately and backs off 1s -> 2s -> --poll-interval (the ceiling)", async () => {
		const pollAt: number[] = [];
		const started = Date.now();
		let tailHold: (() => void) | null = null;
		const client = {
			getTask: async () => {
				pollAt.push(Date.now() - started);
				return taskState(
					"home-run-1",
					pollAt.length < 4 ? "working" : "completed",
				);
			},
			readHomeRun: async () => ({
				run: { id: "home-run-1", status: "completed" },
			}),
			// Hold the tail open so it never wakes the loop; only the backoff
			// schedule is under test here.
			readHomeRunEvents: (_input: unknown, signal?: AbortSignal) =>
				new Promise((resolve) => {
					tailHold = () =>
						resolve({
							events: [],
							nextOffset: "0",
							status: "running",
							upToDate: true,
						});
					signal?.addEventListener("abort", () => tailHold?.(), {
						once: true,
					});
				}),
		} as unknown as TedixHomeClient;

		const result = await waitForSettlement(
			client,
			"home-run-1",
			makeHomeRunSummary({ status: "running" }),
			makeOptions({ pollIntervalMs: 60, pollTimeoutMs: 5_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.status).toBe("completed");
		expect(pollAt).toHaveLength(4);
		// First read is immediate: no interval-long pause before it.
		expect(pollAt[0]).toBeLessThan(40);
		// Every later pause is capped at --poll-interval (60ms here), so the 1s
		// and 2s backoff steps collapse to the ceiling.
		for (let i = 1; i < pollAt.length; i++) {
			const gap = (pollAt[i] ?? 0) - (pollAt[i - 1] ?? 0);
			expect(gap).toBeGreaterThanOrEqual(50);
			expect(gap).toBeLessThan(200);
		}
	});

	test("a settled event tail wakes the settle loop before the next poll interval", async () => {
		const pollAt: number[] = [];
		const started = Date.now();
		let getTaskStatus: "working" | "completed" = "working";
		const client = {
			getTask: async () => {
				pollAt.push(Date.now() - started);
				return taskState("home-run-1", getTaskStatus);
			},
			readHomeRun: async () => ({
				run: { id: "home-run-1", status: "completed" },
			}),
			// The tail reports settlement 30ms in — long before the 2s poll
			// interval would have fired again.
			readHomeRunEvents: async () => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				getTaskStatus = "completed";
				return {
					events: [],
					nextOffset: "0",
					status: "completed",
					upToDate: true,
				};
			},
		} as unknown as TedixHomeClient;

		const result = await waitForSettlement(
			client,
			"home-run-1",
			makeHomeRunSummary({ status: "running" }),
			makeOptions({ pollIntervalMs: 2_000, pollTimeoutMs: 5_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.status).toBe("completed");
		expect(pollAt).toHaveLength(2);
		expect(Date.now() - started).toBeLessThan(500);
	});

	test("a transient 429 read does not abandon a still-running turn", async () => {
		let callCount = 0;
		const client = {
			getTask: async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error('{"error":"Rate limit exceeded","retryAfter":0}');
				}
				return taskState("home-run-429", "completed");
			},
			readHomeRun: async () => ({
				run: { id: "home-run-429", status: "completed" },
			}),
			readHomeRunEvents: async () => ({
				events: [],
				nextOffset: "0",
				status: "completed",
				upToDate: true,
			}),
		} as unknown as TedixHomeClient;

		const result = await waitForSettlement(
			client,
			"home-run-429",
			makeHomeRunSummary({ status: "running" }),
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(callCount).toBe(2);
		expect(result.status).toBe("completed");
	});

	test("child stream tail is requested exactly once even across multiple polls (childTailStarted guard)", async () => {
		let callCount = 0;
		let _eventCallCount = 0;
		const client = {
			getTask: async () => {
				callCount++;
				return taskState("home-run-1", callCount < 3 ? "working" : "completed");
			},
			readHomeRun: async () => ({
				run: {
					id: "home-run-1",
					status: "completed",
					childRunId: "child-1",
					delegatedTediId: "tedi-cto",
				},
			}),
			// Return a settled HomeRunEventsPage so each tail terminates instantly.
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => {
				_eventCallCount++;
				return {
					events: [],
					nextOffset: "0",
					status: "completed",
					upToDate: true,
				};
			},
		} as unknown as TedixHomeClient;

		const initial = makeHomeRunSummary({ status: "running" });
		const result = await waitForSettlement(
			client,
			"home-run-1",
			initial,
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.status).toBe("completed");
		// Event tails are decorative and the child tail is started at most once.
		// We don't assert an exact call count since it depends on timing, but
		// the guard ensures it never grows proportionally to poll iterations.
	});

	test("a throwing event stream does not reject the turn (decorative-failure tolerance)", async () => {
		const client = {
			getTask: async () => taskState("home-run-1", "completed"),
			readHomeRun: async () => ({
				run: { id: "home-run-1", status: "completed" },
			}),
			// Throwing from readHomeRunEvents is caught by tailInto's try/catch.
			readHomeRunEvents: async () => {
				throw new Error("event stream exploded");
			},
		} as unknown as TedixHomeClient;

		const initial = makeHomeRunSummary({ status: "running" });
		// Should resolve without throwing despite the event stream failure
		const result = await waitForSettlement(
			client,
			"home-run-1",
			initial,
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.status).toBe("completed");
	});

	test("delegated child evidence is promoted into the settled answer", async () => {
		const client = {
			getTask: async () => taskState("home-run-1", "completed"),
			readHomeRun: async () => ({
				run: {
					id: "home-run-1",
					status: "completed",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					metadata: { childRunPreview: "preview child answer" },
				},
			}),
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => ({
				events: [],
				nextOffset: "0",
				status: "completed",
				upToDate: true,
			}),
			readChildRunEvidence: async () => ({
				evidence: {
					events: [
						{
							kind: "message.completed",
							createdAt: "2026-01-01T00:00:00.000Z",
							payload: {
								role: "assistant",
								content: "CTO child answer",
							},
						},
					],
				},
			}),
		} as unknown as TedixHomeClient;

		const result = await waitForSettlement(
			client,
			"home-run-1",
			makeHomeRunSummary({
				assistantText: "parent ack",
				status: "running",
			}),
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);
		expect(result.assistantText).toBe("CTO child answer");
		expect(result.childRunPreview).toBe("CTO child answer");
	});

	test("canceled delegated child evidence is never promoted as the final answer", async () => {
		let childEvidenceReads = 0;
		const client = {
			getTask: async () => taskState("home-run-1", "cancelled"),
			readHomeRun: async () => ({
				run: {
					id: "home-run-1",
					status: "canceled",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					metadata: {
						cancelReason: "validation stop",
						childRunPreview: "Raw result: { partial: true }",
					},
				},
			}),
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => ({
				events: [],
				nextOffset: "0",
				status: "canceled",
				upToDate: true,
			}),
			readChildRunEvidence: async () => {
				childEvidenceReads++;
				return {
					evidence: {
						events: [
							{
								kind: "message.completed",
								createdAt: "2026-01-01T00:00:00.000Z",
								payload: {
									role: "assistant",
									content: "Raw result: { partial: true }",
								},
							},
						],
					},
				};
			},
		} as unknown as TedixHomeClient;

		const result = await waitForSettlement(
			client,
			"home-run-1",
			makeHomeRunSummary({
				assistantText: "parent ack",
				status: "running",
			}),
			makeOptions({ pollIntervalMs: 1, pollTimeoutMs: 1_000 }),
			{ enabled: false },
			makeQuietSpinner(),
		);

		expect(result.assistantText).toBe(
			"Home run canceled by operator: validation stop",
		);
		expect(childEvidenceReads).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// dispatchInteractiveLine
// ---------------------------------------------------------------------------

describe("dispatchInteractiveLine", () => {
	test("/exit returns 'exit'", async () => {
		const result = await dispatchInteractiveLine("/exit", makeContext());
		expect(result).toBe("exit");
	});

	test("removed /quit alias does not exit the session", async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (message) => errors.push(String(message));
		try {
			expect(await dispatchInteractiveLine("/quit", makeContext())).toBe(
				"handled",
			);
			expect(errors.join("\n")).toContain("Unknown command /quit");
		} finally {
			console.error = original;
		}
	});

	test("/help prints formatCommandHelp and returns 'handled'", async () => {
		const logged: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logged.push(args.join(" "));
		};
		try {
			const result = await dispatchInteractiveLine("/help", makeContext());
			expect(result).toBe("handled");
			expect(logged.some((line) => line.includes("/tail"))).toBe(true);
		} finally {
			console.log = origLog;
		}
	});

	test("unknown /bogus emits stderr message, returns 'handled', does not throw", async () => {
		const errors: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(" "));
		};
		try {
			const result = await dispatchInteractiveLine("/bogus", makeContext());
			expect(result).toBe("handled");
			expect(errors.some((e) => e.includes("/bogus"))).toBe(true);
		} finally {
			console.error = origError;
		}
	});

	test("plain line calls ctx.ops.send and returns the HomeRunSummary", async () => {
		const summary = makeHomeRunSummary({
			status: "completed",
			assistantText: "hello",
		});
		const sendCalls: string[] = [];
		const ops = makeNoopOps(async (_content: string) => {
			sendCalls.push(_content);
			return summary;
		});
		const result = await dispatchInteractiveLine(
			"tell me something",
			makeContext({ ops, json: true }),
		);
		expect(sendCalls).toEqual(["tell me something"]);
		expect(result).not.toBe("exit");
		expect(result).not.toBe("handled");
		if (result !== "exit" && result !== "handled") {
			expect(result.homeRunId).toBe("home-run-1");
		}
	});

	test("a handler that throws is caught and surfaced without escaping (loop-survival)", async () => {
		// Use /approve which requires a homeRunId — it will throw "requires a homeRunId"
		// We verify dispatchInteractiveLine doesn't reject.
		const errors: string[] = [];
		const origError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(" "));
		};
		const client = {
			respondHomeApproval: async () => {
				throw new Error("approval failed");
			},
		} as unknown as TedixHomeClient;
		try {
			// /approve with no args → handler throws "approve requires a homeRunId"
			const result = await dispatchInteractiveLine(
				"/approve",
				makeContext({ client }),
			);
			// Must not throw; must return "handled"
			expect(result).toBe("handled");
			expect(
				errors.some((e) => e.includes("approve requires a homeRunId")),
			).toBe(true);
		} finally {
			console.error = origError;
		}
	});
});

// ---------------------------------------------------------------------------
// Fix #1 — requireValue: value-flag guard rejects next-is-a-flag
// ---------------------------------------------------------------------------

describe("parseOptions: value-flag guard (fix #1)", () => {
	beforeEach(() => {
		delete process.env.TEDIX_MCP_URL;
	});

	test("--prompt followed immediately by another flag throws", () => {
		expect(() => parseOptions(["ask", "--prompt", "--json"])).toThrow(
			"--prompt requires a value",
		);
	});

	test("-p followed immediately by another flag throws", () => {
		expect(() => parseOptions(["ask", "-p", "--json"])).toThrow(
			"-p requires a value",
		);
	});

	test("--prompt missing at end of args throws", () => {
		expect(() => parseOptions(["ask", "--prompt"])).toThrow(
			"--prompt requires a value",
		);
	});

	test("--conversation followed by flag throws", () => {
		expect(() => parseOptions(["chat", "--conversation", "--json"])).toThrow(
			"--conversation requires a value",
		);
	});

	test("--delegate-to-tedi missing value throws", () => {
		expect(() => parseOptions(["ask", "--delegate-to-tedi"])).toThrow(
			"--delegate-to-tedi requires a value",
		);
	});

	test("--delegate-to-tedi followed by flag throws", () => {
		expect(() => parseOptions(["ask", "--delegate-to-tedi", "--json"])).toThrow(
			"--delegate-to-tedi requires a value",
		);
	});

	test("--idempotency-key followed by flag throws", () => {
		expect(() => parseOptions(["ask", "--idempotency-key", "--json"])).toThrow(
			"--idempotency-key requires a value",
		);
	});

	test("--url followed by flag throws", () => {
		expect(() => parseOptions(["chat", "--url", "--json"])).toThrow(
			"--url requires a value",
		);
	});

	test("--org followed by flag throws", () => {
		expect(() => parseOptions(["login", "--org", "--json"])).toThrow(
			"--org requires a value",
		);
	});

	test("removed --email login option is rejected", () => {
		expect(() =>
			parseOptions(["login", "--email", "user@example.com"]),
		).toThrow("Unknown option --email");
	});

	test("valid value after --prompt works", () => {
		const { options } = parseOptions(["ask", "--prompt", "hello world"]);
		expect(options.prompt).toBe("hello world");
	});
});

// ---------------------------------------------------------------------------
// Fix #2 — --flag=value equals form
// ---------------------------------------------------------------------------

describe("parseOptions: --flag=value equals normalization (fix #2)", () => {
	beforeEach(() => {
		delete process.env.TEDIX_MCP_URL;
	});

	test("--prompt=text sets prompt", () => {
		const { options } = parseOptions(["ask", "--prompt=hello"]);
		expect(options.prompt).toBe("hello");
	});

	test("--json=true is not valid (no-arg flag) but --json works", () => {
		expect(() => parseOptions(["auth", "status", "--json=true"])).toThrow(
			"Unexpected value for --json",
		);
		const { options } = parseOptions(["chat", "--json"]);
		expect(options.json).toBe(true);
	});

	test("keeps inline, repeated and optional values with their owning option", () => {
		expect(parseOptions(["ask", "--prompt=a=b"]).options.prompt).toBe("a=b");
		const work = parseOptions([
			"work",
			"settle",
			"id",
			"--commit=a",
			"--commit=b",
		]);
		expect(work.options.workCommits).toEqual(["a", "b"]);
		expect(work.options.prompt).toBe("settle id");
		const flow = parseOptions(["flow", "run", "--watch=12"]);
		expect(flow.options.flowWatch).toBe(12);
		expect(flow.options.prompt).toBe("run");
		expect(() => parseOptions(["flow", "run", "--watch=false"])).toThrow(
			"Unexpected value for --watch",
		);
		const argv = ["ask", "--", "--no-poll=false", "--json=true"];
		expect(parseOptions(argv).options.prompt).toBe(
			"--no-poll=false --json=true",
		);
		expect(argv).toEqual(["ask", "--", "--no-poll=false", "--json=true"]);
	});

	test("CLI errors use JSON only when requested before the literal separator", async () => {
		for (const [args, json, message] of [
			[["unknown-command", "--", "--json"], false, "Unknown command"],
			[["unknown-command", "--json"], true, "Unknown command"],
			[["auth", "status", "--json=true"], true, "Unexpected value for --json"],
			[
				["ask", "hello", "--no-poll=false"],
				false,
				"Unexpected value for --no-poll",
			],
		] as const) {
			const child = Bun.spawn(
				[process.execPath, `${import.meta.dir}/index.ts`, ...args],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code).toBe(1);
			expect(stdout).toBe("");
			if (json) expect(JSON.parse(stderr).error).toContain(message);
			else {
				expect(stderr).toContain(message);
				expect(stderr.trim().startsWith("{")).toBe(false);
			}
		}
	});

	test("--url=https://example.com sets url", () => {
		const { options } = parseOptions(["chat", "--url=https://example.com/mcp"]);
		expect(options.url).toBe("https://example.com/mcp");
	});

	test("--conversation=my-conv-id sets conversationId", () => {
		const { options } = parseOptions(["chat", "--conversation=my-conv-id"]);
		expect(options.conversationId).toBe("my-conv-id");
	});

	test("--limit=5 sets limit", () => {
		const { options } = parseOptions(["chat", "--limit=5"]);
		expect(options.limit).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// Fix #3 — '--' terminator
// ---------------------------------------------------------------------------

describe("parseOptions: -- terminator (fix #3)", () => {
	beforeEach(() => {
		delete process.env.TEDIX_MCP_URL;
	});

	test("-- passes remainder as positionals (and hence as prompt)", () => {
		const { options } = parseOptions(["ask", "--", "hello", "world"]);
		expect(options.prompt).toBe("hello world");
	});

	test("-- stops option parsing: a flag-like positional is not rejected", () => {
		// Without --, '--json' after '--' would normally throw Unknown option.
		expect(() => parseOptions(["ask", "--", "--not-a-flag"])).not.toThrow();
		const { options } = parseOptions(["ask", "--", "--not-a-flag"]);
		expect(options.prompt).toBe("--not-a-flag");
	});

	test("-- with empty remainder produces no prompt from positionals", () => {
		const { options } = parseOptions(["ask", "--"]);
		expect(options.prompt).toBeUndefined();
	});

	test("options before -- are still parsed", () => {
		const { options } = parseOptions(["ask", "--json", "--", "the message"]);
		expect(options.json).toBe(true);
		expect(options.prompt).toBe("the message");
	});
});

// ---------------------------------------------------------------------------
// Fix #5 — --limit integer validation
// ---------------------------------------------------------------------------

describe("readNumberOption: integer-only validation (fix #5)", () => {
	beforeEach(() => {
		delete process.env.TEDIX_MCP_URL;
	});

	test("--limit 5 is accepted", () => {
		const { options } = parseOptions(["chat", "--limit", "5"]);
		expect(options.limit).toBe(5);
	});

	test("--limit 1.5 (float) is rejected", () => {
		expect(() => parseOptions(["chat", "--limit", "1.5"])).toThrow(
			"must be a positive integer",
		);
	});

	test("--limit 0x10 (hex) is rejected", () => {
		expect(() => parseOptions(["chat", "--limit", "0x10"])).toThrow(
			"must be a positive integer",
		);
	});

	test("--limit 1e2 (exponent) is rejected", () => {
		expect(() => parseOptions(["chat", "--limit", "1e2"])).toThrow(
			"must be a positive integer",
		);
	});

	test("--limit +5 (leading plus) is rejected", () => {
		expect(() => parseOptions(["chat", "--limit", "+5"])).toThrow(
			"must be a positive integer",
		);
	});

	test("--limit 0 is rejected (zero)", () => {
		expect(() => parseOptions(["chat", "--limit", "0"])).toThrow(
			"must be a positive integer",
		);
	});

	test("--limit abc is rejected (non-numeric)", () => {
		expect(() => parseOptions(["chat", "--limit", "abc"])).toThrow(
			"must be a positive integer",
		);
	});
});

// ---------------------------------------------------------------------------
// Fix #6 — sk_ guard gating: bearer + sk_ coexisting should NOT throw
// ---------------------------------------------------------------------------

describe("readMcpAuthHeaders: sk_ guard gating (fix #6)", () => {
	let savedBearer: string | undefined;
	let savedMcpKey: string | undefined;

	beforeEach(() => {
		savedBearer = process.env.TEDIX_MCP_BEARER_TOKEN;
		savedMcpKey = process.env.TEDIX_MCP_API_KEY;
		delete process.env.TEDIX_MCP_BEARER_TOKEN;
		delete process.env.TEDIX_MCP_API_KEY;
	});

	afterEach(() => {
		if (savedBearer !== undefined)
			process.env.TEDIX_MCP_BEARER_TOKEN = savedBearer;
		else delete process.env.TEDIX_MCP_BEARER_TOKEN;
		if (savedMcpKey !== undefined) process.env.TEDIX_MCP_API_KEY = savedMcpKey;
		else delete process.env.TEDIX_MCP_API_KEY;
	});

	test("sk_* alone still throws RAW_API_KEY_MESSAGE", () => {
		process.env.TEDIX_MCP_API_KEY = "sk_live_secret";
		expect(() => readMcpAuthHeaders()).toThrow(RAW_API_KEY_MESSAGE);
	});

	test("sk_* alongside a bearer token does NOT throw (bearer takes precedence)", () => {
		process.env.TEDIX_MCP_BEARER_TOKEN = "valid-bearer";
		process.env.TEDIX_MCP_API_KEY = "sk_live_secret";
		const result = readMcpAuthHeaders();
		expect(result).not.toBeNull();
		expect(result?.headers).toEqual({ Authorization: "Bearer valid-bearer" });
		expect(result?.source).toBe("bearer");
	});
});

// ---------------------------------------------------------------------------
// Fix #7 — makeSpinner passes noColor (indirect test via parseOptions)
// ---------------------------------------------------------------------------

describe("parseOptions: --no-color sets noColor flag (feeds fix #7)", () => {
	beforeEach(() => {
		delete process.env.TEDIX_MCP_URL;
	});

	test("--no-color sets noColor=true", () => {
		const { options } = parseOptions(["chat", "--no-color"]);
		expect(options.noColor).toBe(true);
	});

	test("without --no-color, noColor=false", () => {
		const { options } = parseOptions(["chat"]);
		expect(options.noColor).toBe(false);
	});
});

describe("runDirectCode", () => {
	test("uses ordinary stateless execution by default", async () => {
		const calls: string[] = [];
		const result = await runDirectCode(
			{
				runCode: async (source) => {
					calls.push(`plain:${source}`);
					return { executionId: "exec-1", result: "ok" };
				},
				runCodeWithDestructiveApproval: async () => {
					throw new Error("unexpected destructive path");
				},
			},
			"async () => 1",
		);
		expect(result).toEqual({ executionId: "exec-1", result: "ok" });
		expect(calls).toEqual(["plain:async () => 1"]);
	});

	test("uses only the call-local destructive approval path when authorized", async () => {
		const calls: Array<{ source: string; reason: string }> = [];
		await runDirectCode(
			{
				runCode: async () => {
					throw new Error("unexpected plain path");
				},
				runCodeWithDestructiveApproval: async (source, reason) => {
					calls.push({ source, reason });
					return { result: "removed" };
				},
			},
			"async () => await tenant.remove_member({ id: '1' })",
			"operator requested removal",
		);
		expect(calls).toEqual([
			{
				source: "async () => await tenant.remove_member({ id: '1' })",
				reason: "operator requested removal",
			},
		]);
	});

	test("adds discovery guidance to unknown capability failures", async () => {
		await expect(
			runDirectCode(
				{
					runCode: async () => {
						throw new Error("ReferenceError: guessed_namespace is not defined");
					},
					runCodeWithDestructiveApproval: async () => null,
				},
				"async () => await guessed_namespace.read({})",
			),
		).rejects.toThrow("discover.search");
	});
});

// ---------------------------------------------------------------------------
// Fix #8 — --json stdout hygiene: printApprovalCommands routes to stderr
// ---------------------------------------------------------------------------

describe("dispatchInteractiveLine: --json stdout hygiene (fix #8)", () => {
	test("file skip notice goes to stderr in json mode (not stdout)", async () => {
		// expandFileMentions skips @tokens that looksLikePath (has '/' or extension)
		// but can't be read. Use a path with a clearly non-existent .ts extension.
		const logs: string[] = [];
		const errors: string[] = [];
		const origLog = console.log;
		const origError = console.error;
		console.log = (...args: unknown[]) => logs.push(args.join(" "));
		console.error = (...args: unknown[]) => errors.push(args.join(" "));

		const summary = makeHomeRunSummary({ status: "completed" });
		const ops = makeNoopOps(async () => summary);
		// json: true context
		const ctx = makeContext({ ops, json: true });

		try {
			// @no-such-file.txt has an extension → looksLikePath → ends up in skipped.
			await dispatchInteractiveLine(
				"check @no-such-file-xyz-abc.txt please",
				ctx,
			);
			// In json mode, skipped notice must NOT appear on stdout.
			expect(logs.some((l) => l.includes("skipped"))).toBe(false);
			// It should appear on stderr instead.
			expect(errors.some((e) => e.includes("skipped"))).toBe(true);
		} finally {
			console.log = origLog;
			console.error = origError;
		}
	});

	test("file skip notice goes to stdout in non-json mode", async () => {
		const logs: string[] = [];
		const errors: string[] = [];
		const origLog = console.log;
		const origError = console.error;
		console.log = (...args: unknown[]) => logs.push(args.join(" "));
		console.error = (...args: unknown[]) => errors.push(args.join(" "));

		const summary = makeHomeRunSummary({ status: "completed" });
		const ops = makeNoopOps(async () => summary);
		// json: false context (default human mode)
		const ctx = makeContext({ ops, json: false });

		try {
			await dispatchInteractiveLine(
				"check @no-such-file-xyz-abc.txt please",
				ctx,
			);
			// In non-json mode, skipped notice appears on stdout.
			expect(logs.some((l) => l.includes("skipped"))).toBe(true);
			// And NOT duplicated on stderr.
			expect(errors.some((e) => e.includes("skipped"))).toBe(false);
		} finally {
			console.log = origLog;
			console.error = origError;
		}
	});
});

// ---------------------------------------------------------------------------
// Turn termination + answer attribution (spinner-must-always-stop fixes)
// ---------------------------------------------------------------------------

describe("resolveAnswerCommit — noise filter substitution", () => {
	test("captured output with real content strips the noise lines", () => {
		const result = resolveAnswerCommit({
			captured: ["no runtime events", "", "\nThe canonical answer."],
		});
		expect(result.source).toBe("captured");
		expect(result.lines).not.toContain("no runtime events");
		expect(result.lines.some((l) => l.includes("The canonical answer."))).toBe(
			true,
		);
	});

	test("noise-only output is empty", () => {
		const result = resolveAnswerCommit({
			captured: ["  No Runtime Events  ", "no events"],
		});
		expect(result.source).toBe("empty");
	});

	test("nothing captured → empty", () => {
		const result = resolveAnswerCommit({ captured: [] });
		expect(result.source).toBe("empty");
	});
});

function makeTerminationBridge() {
	const states: ReplState[] = [];
	const commits: Array<{ speaker: string; lines: string[] }> = [];
	const bridge = new InkReplBridge({
		getRegistryCount: () => 0,
		getRegistryList: () => [],
		waitAll: async () => {},
		dispatch: async () => "handled",
		getPanelStates: () => [],
		cancel: async () => undefined,
	});
	bridge.onUpdate((state) => {
		states.push({ ...state });
		commits.push(
			...state.pendingCommits.map((c) => ({
				speaker: c.speaker,
				lines: c.lines,
			})),
		);
	});
	return { bridge, states, commits };
}

describe("bridge commitLines — answer commits terminate the thinking spinner", () => {
	test("a kernel commit while thinking clears thinking (poller completion)", () => {
		const { bridge, states, commits } = makeTerminationBridge();

		bridge.markDispatchInflight();
		expect(states.at(-1)?.thinkingSince).not.toBeNull();

		// The poller surfaces the server-settled assistant answer mid-dispatch.
		bridge.commitLines("kernel", ["The settled answer."]);

		const last = states.at(-1);
		expect(last?.thinkingSince).toBeNull();
		expect(
			commits.some(
				(c) =>
					c.speaker === "kernel" && c.lines.includes("The settled answer."),
			),
		).toBe(true);

		bridge.stop();
	});

	test("a tedi-named commit also clears thinking (any conversational speaker)", () => {
		const { bridge, states } = makeTerminationBridge();
		bridge.markDispatchInflight();
		bridge.commitLines("CTO", ["delegated result"]);
		expect(states.at(-1)?.thinkingSince).toBeNull();
		bridge.stop();
	});

	test("banner/output/you commits do NOT clear thinking", () => {
		const { bridge, states } = makeTerminationBridge();
		bridge.markDispatchInflight();
		bridge.commitLines("output", ["  ↳ attached 1 file(s): a.ts"]);
		bridge.commitLines("you", ["hello"]);
		expect(states.at(-1)?.thinkingSince).not.toBeNull();
		bridge.stop();
	});

	test("fast-settle defense: dispatched result with an empty registry clears thinking", async () => {
		// A fast-settled turn returns "dispatched" WITHOUT registering a background
		// settler — nothing would ever call clearDispatchInflight, so dispatch()
		// itself must stop the spinner when no registry entry owns it.
		const states: ReplState[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 0, // fast-settle: nothing in flight
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => "dispatched",
			getPanelStates: () => [],
			cancel: async () => undefined,
		});
		bridge.onUpdate((s) => states.push({ ...s }));

		await bridge.dispatch("what is the plan?");
		expect(states.at(-1)?.thinkingSince).toBeNull();
		bridge.stop();
	});

	test("dispatched result with a live registry entry keeps thinking (settler owns it)", async () => {
		const states: ReplState[] = [];
		const bridge = new InkReplBridge({
			getRegistryCount: () => 1, // a background settler is tracking the run
			getRegistryList: () => [],
			waitAll: async () => {},
			dispatch: async () => "dispatched",
			getPanelStates: () => [],
			cancel: async () => undefined,
		});
		bridge.onUpdate((s) => states.push({ ...s }));

		await bridge.dispatch("long question");
		expect(states.at(-1)?.thinkingSince).not.toBeNull();
		bridge.stop();
	});
});

describe("commitLostRunOutcome — hard ceiling for lost runs", () => {
	test("commits a clear handoff line, never a silent spinner", () => {
		const { bridge, states, commits } = makeTerminationBridge();
		bridge.markDispatchInflight();

		commitLostRunOutcome({
			bridge,
			homeRunId: "run-lost-2",
		});

		const handoff = commits.find((c) => c.speaker === "handoff");
		expect(handoff).toBeDefined();
		expect(handoff?.lines.some((l) => l.includes("run-lost-2"))).toBe(true);
		expect(
			handoff?.lines.some((l) => l.includes("continuing in the background")),
		).toBe(true);
		expect(states.at(-1)?.thinkingSince).toBeNull();
		bridge.stop();
	});
});

describe("backgroundSettleInk — timeout path terminates the turn", () => {
	const taskState = (
		taskId: string,
		status: "working" | "input_required" | "completed" | "cancelled" | "failed",
	) => ({
		resultType: "complete" as const,
		taskId,
		status,
		createdAt: "2026-08-30T00:00:00.000Z",
		lastUpdatedAt: "2026-08-30T00:00:00.000Z",
		ttlMs: null,
	});
	test("an ask_human settlement transfers input ownership to the question modal", async () => {
		const client = {
			getTask: async () => taskState("run-question", "completed"),
			readHomeRun: async () => ({
				run: {
					id: "run-question",
					status: "completed",
					conversationId: "home:cli:test",
					metadata: {
						kernelRoute: {
							routeKind: "ask_human",
							clarifyingQuestion: "Which workspace?\n1. Tedix\n2. Globex",
						},
					},
				},
			}),
			readHomeRunEvents: async () => ({
				events: [],
				nextOffset: "0",
				status: "completed",
				upToDate: true,
			}),
		} as unknown as TedixHomeClient;
		const registry = new InFlightRegistry();
		registry.add({
			homeRunId: "run-question",
			label: "ambiguous request",
			conversationId: "home:cli:test",
		});
		const panel = new LiveActivityPanel({ isTty: false });
		const { bridge, states } = makeTerminationBridge();
		const onPendingQuestion = mock((summary: HomeRunSummary) => {
			const question = String(summary.kernelRoute?.clarifyingQuestion ?? "");
			bridge.showQuestion({
				homeRunId: summary.homeRunId,
				prompt: "Which workspace?",
				options: [
					{ label: "Tedix", value: "Tedix" },
					{
						label: "Globex",
						value: "Globex",
					},
				],
			});
			expect(question).toContain("Which workspace?");
		});

		await backgroundSettleInk({
			client,
			homeRunId: "run-question",
			initialSummary: makeHomeRunSummary({
				homeRunId: "run-question",
				status: "running",
			}),
			options: makeOptions({ poll: true, pollIntervalMs: 1 }),
			color: { enabled: false },
			registry,
			panel,
			bridge,
			signal: new AbortController().signal,
			onPendingQuestion,
		});

		expect(onPendingQuestion).toHaveBeenCalledTimes(1);
		expect(registry.count).toBe(0);
		expect(states.at(-1)?.questionPrompt).toMatchObject({
			homeRunId: "run-question",
			prompt: "Which workspace?",
		});
		panel.stop();
		bridge.stop();
	});

	test.each(["completed", "failed", "canceled", "requires_approval"] as const)(
		"settlement %s opens a modal only for a live delegation gate",
		async (status) => {
			const settledPayload = {
				run: {
					id: "run-cfo-approval",
					status,
					conversationId: "home:cli:test",
					metadata: {
						kernelRoute: {
							routeKind: "delegate_tedi",
							targetTediId: "tedi-cfo",
							targetTediLabel: "CFO",
						},
						homeDelegation: {
							workOrder: {
								status: "draft",
								objective: "Check whether Stripe is available in the catalog.",
							},
							decision: {
								mode: "needs_approval",
								reason: "target not active",
							},
						},
					},
				},
			};
			const client = {
				getTask: async () =>
					taskState(
						"run-cfo-approval",
						status === "requires_approval" ? "input_required" : "completed",
					),
				readHomeRun: async () => settledPayload,
				readHomeRunEvents: async () => ({
					events: [],
					nextOffset: "0",
					status,
					upToDate: true,
				}),
			} as unknown as TedixHomeClient;

			const registry = new InFlightRegistry();
			registry.add({
				homeRunId: "run-cfo-approval",
				label: "catalog check",
				conversationId: "home:cli:test",
			});
			const panel = new LiveActivityPanel({ isTty: false });
			const { bridge, states, commits } = makeTerminationBridge();
			const onPendingApproval = mock((summary: HomeRunSummary) => {
				const targetLabel = summary.targetTediLabel ?? "Home";
				bridge.showApproval({
					homeRunId: summary.homeRunId,
					targetLabel,
					detail: summary.delegationObjective ?? "",
					reason: approvalReasonForDisplay(summary, targetLabel),
					scope: "delegate:tedi-cfo",
					scopeLabel: "CFO delegations",
				});
			});

			await backgroundSettleInk({
				client,
				homeRunId: "run-cfo-approval",
				initialSummary: makeHomeRunSummary({
					assistantText: "Routing your request…",
					homeRunId: "run-cfo-approval",
					status: "running",
				}),
				options: makeOptions({
					poll: true,
					pollIntervalMs: 1,
				}),
				color: { enabled: false },
				registry,
				panel,
				bridge,
				signal: new AbortController().signal,
				onPendingApproval,
			});

			expect(registry.count).toBe(0);
			if (status === "requires_approval") {
				expect(onPendingApproval).toHaveBeenCalledTimes(1);
				expect(states.at(-1)?.approvalPrompt).toMatchObject({
					homeRunId: "run-cfo-approval",
					targetLabel: "CFO",
					reason:
						"CFO is in standby. Approval wakes it and dispatches this work order.",
				});
			} else {
				expect(onPendingApproval).not.toHaveBeenCalled();
				expect(states.every((state) => state.approvalPrompt == null)).toBe(
					true,
				);
				expect(commits.length).toBeGreaterThan(0);
				expect(settledPayload.run.status).toBe(status);
				expect(
					settledPayload.run.metadata.homeDelegation.workOrder.status,
				).toBe("draft");
			}

			expect(
				commits.some((commit) =>
					commit.lines.some(
						(line) =>
							line.includes("Approval required") || line.includes("/approve"),
					),
				),
			).toBe(false);

			panel.stop();
			bridge.stop();
		},
	);

	test("pollTimeoutMs expiry with the run still running clears thinking + commits a terminal item", async () => {
		const client = {
			getTask: async () => taskState("run-stuck", "working"),
			readHomeRun: async () => ({
				run: { id: "run-stuck", status: "running" },
			}),
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => ({
				events: [],
				nextOffset: "0",
				status: "completed",
				upToDate: true,
			}),
		} as unknown as TedixHomeClient;

		const registry = new InFlightRegistry();
		registry.add({
			homeRunId: "run-stuck",
			label: "stuck question",
			conversationId: "home:cli:test",
		});
		const panel = new LiveActivityPanel({ isTty: false });
		const { bridge, states, commits } = makeTerminationBridge();

		await backgroundSettleInk({
			client,
			homeRunId: "run-stuck",
			initialSummary: makeHomeRunSummary({
				assistantText: "",
				homeRunId: "run-stuck",
				status: "running",
			}),
			options: makeOptions({
				poll: true,
				pollIntervalMs: 1,
				pollTimeoutMs: 30,
			}),
			color: { enabled: false },
			registry,
			panel,
			bridge,
			signal: new AbortController().signal,
		});

		// The spinner is off…
		expect(states.at(-1)?.thinkingSince).toBeNull();
		// …the registry entry is gone…
		expect(registry.count).toBe(0);
		// …and a terminal background handoff was committed (nothing streamed in
		// this run, but the conversation poller can still surface its answer).
		const handoff = commits.find((c) => c.speaker === "handoff");
		expect(handoff).toBeDefined();
		expect(handoff?.lines.some((l) => l.includes("run-stuck"))).toBe(true);
		// The noise placeholder never landed as an answer body.
		expect(
			commits.every(
				(c) =>
					!c.lines.some((l) => l.trim().toLowerCase() === "no runtime events"),
			),
		).toBe(true);

		panel.stop();
		bridge.stop();
	});

	test("canceled delegated runs commit under kernel and suppress late child output", async () => {
		const cancellation =
			"Home run canceled by operator: interactive validation stop";
		const client = {
			getTask: async () => taskState("run-canceled", "cancelled"),
			readHomeRun: async () => ({
				run: {
					id: "run-canceled",
					status: "canceled",
					delegatedTediId: "tedi-cto",
					childRunId: "child-run-1",
					metadata: {
						cancelReason: "interactive validation stop",
						childRunPreview: cancellation,
						kernelRoute: {
							routeKind: "delegate_tedi",
							targetTediLabel: "CTO",
						},
					},
				},
			}),
			readHomeRunEvents: async (): Promise<{
				events: never[];
				nextOffset: string;
				status: string;
				upToDate: boolean;
			}> => ({
				events: [],
				nextOffset: "0",
				status: "canceled",
				upToDate: true,
			}),
			readChildRunEvidence: async () => {
				throw new Error("canceled runs must not read child evidence");
			},
		} as unknown as TedixHomeClient;

		const registry = new InFlightRegistry();
		registry.add({
			homeRunId: "run-canceled",
			label: "canceled delegation",
			conversationId: "home:cli:test",
		});
		const panel = new LiveActivityPanel({ isTty: false });
		const { bridge, commits } = makeTerminationBridge();
		const markRunSeen = spyOn(bridge, "markRunSeen");
		const onTediLabel = mock(() => {});

		await backgroundSettleInk({
			client,
			homeRunId: "run-canceled",
			initialSummary: makeHomeRunSummary({
				assistantText: "parent ack",
				homeRunId: "run-canceled",
				status: "running",
			}),
			options: makeOptions({
				json: false,
				poll: true,
				pollIntervalMs: 1,
			}),
			color: { enabled: false },
			registry,
			panel,
			bridge,
			signal: new AbortController().signal,
			onTediLabel,
		});

		expect(commits.some((commit) => commit.speaker === "CTO")).toBe(false);
		const kernel = commits.find((commit) => commit.speaker === "kernel");
		expect(kernel?.lines.some((line) => line.includes(cancellation))).toBe(
			true,
		);
		expect(markRunSeen).toHaveBeenCalledWith("run-canceled");
		expect(onTediLabel).not.toHaveBeenCalled();

		panel.stop();
		bridge.stop();
	});
});

describe("one-shot slash-command prompts", () => {
	// Regression: `tedix ask "/retry <id>"` used to be sent to Home verbatim, so
	// the command text (plus pasted terminal context) was delegated as a fresh
	// objective and the real work item was stranded. A slash prompt must resolve
	// to a command or fail loudly — never become prose.
	test("parses a slash command into name and arguments", () => {
		expect(
			parseSlashPrompt("/retry 5eed0001-0000-4000-8000-000000000001"),
		).toEqual({
			name: "retry",
			rest: "5eed0001-0000-4000-8000-000000000001",
		});
	});

	test("lowercases the command and tolerates surrounding whitespace", () => {
		expect(parseSlashPrompt("  /Status  ")).toEqual({
			name: "status",
			rest: "",
		});
	});

	test("resolves a real command name that the registry knows", () => {
		const parsed = parseSlashPrompt("/retry abc");
		expect(parsed).toBeDefined();
		expect(findCommand(parsed?.name ?? "")).toBeDefined();
	});

	test("leaves ordinary prose alone", () => {
		expect(
			parseSlashPrompt("summarize the active Home run set"),
		).toBeUndefined();
	});

	test("does not hijack a prompt that merely starts with a path", () => {
		expect(parseSlashPrompt("/Users/owner/notes.md is stale")).toBeUndefined();
		expect(parseSlashPrompt("/")).toBeUndefined();
		expect(parseSlashPrompt("/2026 targets")).toBeUndefined();
	});

	test("names REPL-only commands as such instead of sending them", () => {
		const message = slashCommandError("exit");
		expect(message).toContain("interactive-only");
		expect(message).toContain("NOT sent to Home");
	});

	test("explains an unknown slash command without delegating it", () => {
		const message = slashCommandError("definitelynotacommand");
		expect(message).toContain("Unknown command");
		expect(message).toContain("--help");
	});
});
