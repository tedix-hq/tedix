import { afterEach, describe, expect, mock, test } from "bun:test";
import type { WorkContext } from "./work";
import {
	GATE_SESSION_KEY,
	UUID_RE,
	WORK_EXIT_FAIL,
	assertUnambiguousSession,
	cachedAttemptId,
	executorIdentityHint,
	identityBoundCallable,
	isDetectedExternalHarness,
	isUuid,
	missingAttemptResult,
	mutationCallable,
	oauthHarnessGuard,
	ownerActionHint,
	resolveAgentSession,
	tediNamespace,
	withSession,
	workAttemptKey,
} from "./work-identity";
import { setProcessTableReader } from "./host-ancestry";
import { writeExternalAgentProfile } from "./external-agent-store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ColorMode } from "./terminal";

const ENV_KEYS = [
	"TEDIX_AGENT_SESSION",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDECODE",
	"DEVIN_SESSION_ID",
	"CODEX_SESSION_ID",
	"CODEX_THREAD_ID",
	"CODEX_SANDBOX",
	"CODEX_HOME",
	"CURSOR_TRACE_ID",
	"CURSOR_AGENT",
	"TEDIX_CONFIG_DIR",
] as const;
const savedEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
const originalPpid = process.ppid;
const WORK_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
	setProcessTableReader(() => []);
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	Object.defineProperty(process, "ppid", {
		configurable: true,
		value: originalPpid,
	});
});

function clearIdentityEnv(): void {
	for (const key of ENV_KEYS) delete process.env[key];
}

function context(overrides: Partial<WorkContext> = {}): WorkContext {
	return {
		client: {} as WorkContext["client"],
		color: { enabled: false } satisfies ColorMode,
		json: false,
		workspace: "connect",
		attemptStore: {
			get: mock(() => "attempt-1"),
			set: mock(() => undefined),
			remove: mock(() => true),
		},
		work: {},
		...overrides,
	};
}

describe("work identity primitives", () => {
	test("exports the exit code and validates UUIDs", () => {
		expect(WORK_EXIT_FAIL).toBe(2);
		expect(UUID_RE.test(WORK_ID)).toBe(true);
		expect(isUuid(`  ${WORK_ID} `)).toBe(true);
		expect(isUuid("not-a-uuid")).toBe(false);
		expect(isUuid("11111111-1111-1111-1111-1111111111111")).toBe(false);
	});

	test("sanitizes tedi namespaces and chooses identity-bound callables", () => {
		expect(tediNamespace("  Team Alpha/acme  ")).toBe("Team_Alpha_acme");
		expect(identityBoundCallable(undefined, "work.list", "list_work")).toBe(
			"work.list",
		);
		expect(identityBoundCallable("Team Alpha", "work.list", "list_work")).toBe(
			"Team_Alpha.list_work",
		);
		expect(() =>
			identityBoundCallable(WORK_ID, "work.list", "list_work"),
		).toThrow("hydrated tedi slug");
		expect(mutationCallable(undefined, "work.start")).toBe("work.start");
		expect(() => mutationCallable("team", "work.start")).toThrow(
			"cannot authorize work mutations",
		);
	});

	test("builds attempt keys, reads cached attempts, and reports a stale attempt", () => {
		clearIdentityEnv();
		process.env.TEDIX_AGENT_SESSION = "codex:test-session";
		const ctx = context({ work: { as: "team" } });
		expect(workAttemptKey(ctx, WORK_ID)).toEqual({
			workspace: "connect",
			actor: "team",
			agentSession: "codex:test-session",
			workItemId: WORK_ID,
		});
		expect(workAttemptKey(ctx, WORK_ID, "opencode:explicit").agentSession).toBe(
			"opencode:explicit",
		);
		expect(cachedAttemptId(ctx, WORK_ID)).toBe("attempt-1");
		expect(missingAttemptResult(WORK_ID)).toEqual({
			value: undefined,
			error: {
				code: "STALE_ATTEMPT",
				status: 409,
				message: expect.stringContaining(WORK_ID),
			},
		});
	});

	describe("resolveAgentSession", () => {
		test("uses explicit, override, native, and derived fallback precedence", () => {
			clearIdentityEnv();
			process.env.CLAUDE_CODE_SESSION_ID = "claude-native";
			process.env.TEDIX_AGENT_SESSION = "codex:env-override";
			expect(resolveAgentSession("cursor:explicit")).toEqual({
				session: "cursor:explicit",
				harness: "cursor",
				derived: false,
			});
			expect(resolveAgentSession()).toEqual({
				session: "codex:env-override",
				harness: "codex",
				derived: false,
			});
			delete process.env.TEDIX_AGENT_SESSION;
			expect(resolveAgentSession()).toMatchObject({
				session: "claude-code:claude-native",
				harness: "claude-code",
				derived: false,
			});
			clearIdentityEnv();
			Object.defineProperty(process, "ppid", {
				configurable: true,
				value: 4242,
			});
			expect(resolveAgentSession()).toEqual({
				session: "cli:sh4242",
				harness: "cli",
				derived: true,
			});
		});

		test("keeps a Codex session id when launched from Claude", () => {
			clearIdentityEnv();
			process.env.CLAUDECODE = "1";
			process.env.CODEX_THREAD_ID = "codex-child";
			expect(resolveAgentSession()).toEqual({
				session: "codex:codex-child",
				harness: "codex",
				derived: false,
			});
		});

		test("selects the nearer host and marks unresolved native identities ambiguous", () => {
			clearIdentityEnv();
			process.env.CLAUDE_CODE_SESSION_ID = "claude-parent";
			process.env.CODEX_THREAD_ID = "codex-child";
			setProcessTableReader(() => [
				{ pid: process.pid, ppid: 801, command: "tedix" },
				{ pid: 801, ppid: 900, command: "codex" },
				{ pid: 900, ppid: 1, command: "claude" },
			]);
			expect(resolveAgentSession()).toMatchObject({
				session: "codex:codex-child",
				harness: "codex",
			});
			setProcessTableReader(() => [
				{ pid: process.pid, ppid: 1, command: "tedix" },
			]);
			const ambiguous = resolveAgentSession();
			expect(ambiguous?.ambiguousNative).toEqual([
				"claude-code:claude-parent",
				"codex:codex-child",
			]);
			expect(() => assertUnambiguousSession(ambiguous)).toThrow(
				/Set TEDIX_AGENT_SESSION=.*or use --session/,
			);
		});
	});

	test("recognizes external harnesses and validates the session-key boundary", () => {
		expect(isDetectedExternalHarness(undefined)).toBe(false);
		expect(
			isDetectedExternalHarness({
				session: "cli:x",
				harness: "cli",
				derived: true,
			}),
		).toBe(false);
		expect(
			isDetectedExternalHarness({
				session: "codex:x",
				harness: "codex",
				derived: false,
			}),
		).toBe(true);
		expect(GATE_SESSION_KEY.test("codex:session-1")).toBe(true);
		expect(GATE_SESSION_KEY.test("bad session")).toBe(false);
	});

	test("guards stored-login harnesses unless explicitly overridden", () => {
		clearIdentityEnv();
		process.env.CODEX_SESSION_ID = "external";
		const ctx = context({ authSource: "stored-login:connect" });
		expect(oauthHarnessGuard(ctx)).toMatchObject({
			code: "EXTERNAL_AGENT_IDENTITY_REQUIRED",
			status: 409,
		});
		ctx.work.operatorOverride = true;
		expect(oauthHarnessGuard(ctx)).toBeUndefined();
	});

	test("hints name the next owner or executor command", () => {
		const ownerCtx = context({ authSource: "external-agent:profile" });
		expect(
			ownerActionHint(ownerCtx, { code: "FORBIDDEN", message: "FORBIDDEN" }),
		).toContain("env -u TEDIX_EXTERNAL_AGENT");
		expect(
			ownerActionHint(ownerCtx, { code: "FORBIDDEN", message: "FORBIDDEN" }),
		).toContain("settled succeeded with --commit");
		expect(
			ownerActionHint(ownerCtx, { code: "NOT_FOUND", message: "missing" }),
		).toBe("");

		const configDir = mkdtempSync(join(tmpdir(), "tedix-work-identity-"));
		try {
			process.env.TEDIX_CONFIG_DIR = configDir;
			writeExternalAgentProfile("connect", {
				organizationId: WORK_ID,
				principalId: "22222222-2222-4222-8222-222222222222",
				key: "fictional-principal-key",
				displayName: "Test executor",
				apiKeyId: "33333333-3333-4333-8333-333333333333",
				rawApiKey: "fictional-secret",
				scopes: [],
				mcpUrl: "https://example.invalid/mcp",
				createdAt: "2026-01-01T00:00:00.000Z",
				sessions: {},
			});
			const hint = executorIdentityHint(
				context({ workspace: "connect" }),
				WORK_ID,
				{ message: "verified external-agent session required" },
			);
			expect(hint).toContain(`tedix work start ${WORK_ID}`);
			expect(hint).toContain("tedix agent start");
		} finally {
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	test("merges session provenance into existing metadata", () => {
		clearIdentityEnv();
		process.env.TEDIX_AGENT_SESSION = "opencode:test";
		const args = { metadata: { requestId: "request-1" }, value: 42 };
		expect(withSession(context(), args)).toEqual({
			...args,
			metadata: {
				requestId: "request-1",
				agentSession: "opencode:test",
				agentHarness: "opencode",
			},
		});
	});
});
