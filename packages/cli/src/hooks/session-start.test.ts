import { describe, expect, test } from "bun:test";
import type { JsonObject } from "./hook-io";
import { runSessionStart } from "./session-start";

/** Behavior checks for the bounded, read-only session brief. */
const WORK_ID = "ac651d65-a993-4e57-aa05-d4c45c78cfda";
const AUTH = {
	wouldUse: "stored-login",
	workspace: "tedix",
	mcpUrl: "https://tedix-unified.mcp.tedix.dev/mcp",
	storedLogin: { org: "org_tedix", grantedScopes: ["mcp:work.read"] },
};

async function run(
	reads: unknown[],
	env: Record<string, string> = {},
	event: unknown = {},
): Promise<{ output: string; calls: string[][] }> {
	const calls: string[][] = [];
	const lines: string[] = [];
	await runSessionStart({
		env: { ...env },
		stdin: typeof event === "string" ? event : JSON.stringify(event),
		cwd: process.cwd(),
		write: (line) => lines.push(line),
		read: async (args) => {
			calls.push(args);
			if (!reads.length) throw new Error("unexpected read");
			const next = reads.shift();
			if (next instanceof Error) throw next;
			return next as JsonObject;
		},
	});
	return { output: lines.join("\n"), calls };
}

function context(output: string): string {
	return JSON.parse(output).hookSpecificOutput.additionalContext;
}

async function brief(
	outcome: string,
	attempts: unknown[] = [],
	source = "startup",
): Promise<string> {
	const item = {
		title: "Selected task",
		disposition: "accepted",
		acceptanceContract: { doneLooksLike: outcome },
	};
	const { output } = await run(
		[AUTH, item, { data: attempts }],
		{
			TEDIX_PLUGIN_PREFLIGHT: "1",
			TEDIX_WORKSPACE: "tedix",
			TEDIX_WORK_ITEM_ID: WORK_ID,
		},
		{ source },
	);
	return context(output);
}

async function automaticBrief(
	binding: JsonObject,
	{
		project = "project-id",
		env = {},
		event = { source: "resume" },
	}: { project?: string; env?: Record<string, string>; event?: unknown } = {},
) {
	const bound =
		binding.status === "bound"
			? { org: "org_tedix", mcpUrl: AUTH.mcpUrl, ...binding }
			: binding;
	const item = {
		title: "Bound task",
		projectId: project,
		disposition: "completed",
		acceptanceContract: { doneLooksLike: "Deliver the result" },
	};
	return run([bound, AUTH, item, { data: [] }], env, event);
}

describe("tedix hooks session-start", () => {
	test("connect routes the selected org and rejects cross-org Work", async () => {
		const binding = {
			status: "bound",
			workspace: "connect",
			org: "org_target",
			organization: "org_target",
			mcpUrl: "https://connect.mcp.tedix.dev/mcp",
			projectId: "project-id",
			workItemId: WORK_ID,
		};
		const auth = {
			wouldUse: "stored-login",
			workspace: "connect",
			mcpUrl: binding.mcpUrl,
			storedLogin: {
				org: "incidental",
				accessToken: { selectedOrganizations: ["org_target"] },
			},
		};
		const org = "11111111-1111-4111-8111-111111111111";
		for (const actual of [org, WORK_ID]) {
			const item = {
				title: "Scoped task",
				projectId: "project-id",
				orgId: actual,
				disposition: "accepted",
				acceptanceContract: { doneLooksLike: "Finish" },
			};
			const { output, calls } = await run([
				binding,
				auth,
				{ organizationId: org },
				item,
				{ data: [] },
			]);
			expect(calls[2]!.slice(2, 4)).toEqual(["--organization", "org_target"]);
			expect(calls[3]!.slice(2, 4)).toEqual(["--organization", "org_target"]);
			if (actual === org) expect(output).toContain("Scoped task");
			else {
				expect(output).not.toContain("Scoped task");
				expect(calls).toHaveLength(4);
			}
		}
		const { output, calls } = await run([
			binding,
			{
				...auth,
				storedLogin: { accessToken: { selectedOrganizations: ["other"] } },
			},
		]);
		expect(output).toContain("no longer selected");
		expect(calls).toHaveLength(2);
	});

	test("all lifecycle sources preserve the ordinary outcome", async () => {
		const outcome =
			"Verify the installed plugin in a fresh session and report its Work state. ".repeat(
				5,
			);
		for (const source of ["startup", "resume", "clear", "compact", "fork"]) {
			const text = await brief(outcome, [], source);
			expect(text).toContain(outcome);
			expect(text).toContain("outcomeComplete=true");
			expect(text).toContain(`source=${source}; observed=`);
		}
	});

	test("an oversized outcome is explicitly incomplete", async () => {
		const text = await brief("x".repeat(1000));
		expect(text).toContain("outcomeComplete=false");
		expect(text).toContain("Outcome missing or truncated");
		expect(text).not.toContain("x".repeat(801));
	});

	test("a missing outcome cannot be treated as complete", async () => {
		expect(await brief("")).toContain("outcomeComplete=false");
	});

	test("an observed Attempt identifies its owner without inheriting authority", async () => {
		const text = await brief("Finish the task", [
			{
				id: "attempt-id",
				attemptNumber: 2,
				runtimeState: "running",
				executorType: "external_agent",
				executorId: "executor-id",
				externalSessionKey: "codex:other-session",
				expiresAt: "1970-01-01T00:00:00Z",
			},
		]);
		expect(text).toContain("Observed Attempt attempt-id");
		expect(text).toContain("executor=external_agent:executor-id");
		expect(text).toContain("codex:other-session");
		expect(text).toContain("does not inherit its authority");
		expect(text).toContain("Verify current identity and fence before write");
		expect(text).toContain("lease=expired");
		expect(text).toContain("requires fresh admission");
	});

	test("an unknown event is not a claim of fresh startup", async () => {
		expect(await brief("Finish", [], "invented")).toContain("source=unknown");
	});

	test("a disabled hook is silent and performs no read", async () => {
		const { output, calls } = await run([], { TEDIX_PLUGIN_PREFLIGHT: "0" });
		expect(calls).toEqual([]);
		expect(output).toBe("");
	});

	test("a bound wrong org, gateway or explicit token never reads Work", async () => {
		const binding = {
			status: "bound",
			workspace: "tedix",
			org: "org_tedix",
			mcpUrl: AUTH.mcpUrl,
			projectId: "project-id",
			workItemId: WORK_ID,
		};
		for (const auth of [
			{ ...AUTH, mcpUrl: "https://wrong.invalid/mcp" },
			{ ...AUTH, storedLogin: { org: "org_other" } },
			{ ...AUTH, wouldUse: "direct-token" },
			{
				...AUTH,
				wouldUse: "external-agent:key",
				externalAgent: {
					configured: true,
					mcpUrl: "https://wrong.invalid/mcp",
					organizationId: WORK_ID,
				},
			},
		]) {
			const { output, calls } = await run([binding, auth]);
			expect(output).toContain("no Work was read");
			expect(calls).toHaveLength(2);
		}
	});

	test("explicit Work cannot override the current chat selection", async () => {
		const other = "11111111-1111-4111-8111-111111111111";
		const { output, calls } = await automaticBrief(
			{
				status: "bound",
				workspace: "tedix",
				projectId: "project-id",
				workItemId: other,
				contextSessionId: WORK_ID,
			},
			{
				env: { TEDIX_PLUGIN_PREFLIGHT: "1", TEDIX_WORK_ITEM_ID: WORK_ID },
				event: { session_id: WORK_ID },
			},
		);
		expect(output).toContain("conflicts");
		expect(calls).toHaveLength(1);
	});

	test("the host session is passed to the local resolver", async () => {
		const { output, calls } = await automaticBrief(
			{
				status: "bound",
				workspace: "tedix",
				projectId: "project-id",
				workItemId: WORK_ID,
				contextSessionId: WORK_ID,
			},
			{ event: { source: "resume", session_id: WORK_ID } },
		);
		expect(calls[0]!.slice(-2)).toEqual(["--session", WORK_ID]);
		expect(output).toContain("Work Item is terminal");
	});

	test("a conflicting host identity performs no reads", async () => {
		const { output, calls } = await automaticBrief(
			{},
			{
				env: { CODEX_THREAD_ID: "11111111-1111-4111-8111-111111111111" },
				event: { session_id: WORK_ID },
			},
		);
		expect(output).toContain("conflicting");
		expect(calls).toEqual([]);
	});

	test("a resolved wrong chat cannot read Work even with opt-in", async () => {
		const { output, calls } = await automaticBrief(
			{ contextSessionId: WORK_ID },
			{
				env: { TEDIX_PLUGIN_PREFLIGHT: "1" },
				event: { session_id: "11111111-1111-4111-8111-111111111111" },
			},
		);
		expect(output).toContain("unavailable");
		expect(calls).toHaveLength(1);
	});

	test("an unconfigured session performs only local resolution", async () => {
		const { output, calls } = await automaticBrief({ status: "unbound" });
		expect(output).toBe("");
		expect(calls).toEqual([["setup", "agents", "context", "show", "--json"]]);
	});

	test("the binding recovers terminal Work without environment", async () => {
		const { output, calls } = await automaticBrief({
			status: "bound",
			workspace: "tedix",
			projectId: "project-id",
			workItemId: WORK_ID,
			contextSource: "worktree",
		});
		expect(output).toContain(WORK_ID);
		expect(output).toContain("Work Item is terminal; no running Attempt");
		expect(output).toContain("source=resume");
		expect(
			calls.slice(1).every((call) => call[0] === "-w" && call[1] === "tedix"),
		).toBe(true);
	});

	test("no selected Work guides an authorized task without hook mutations", async () => {
		const { output, calls } = await automaticBrief({
			status: "bound",
			workspace: "tedix",
			projectId: "project-id",
		});
		const text = context(output);
		expect(text).toContain("activation alone does not authorize creating Work");
		expect(text).toContain("user-authorized repo task");
		expect(text).toContain("bookkeeping/admission under repo policy");
		expect(text).toContain("do not re-ask permission for that task");
		expect(text).toContain("ambiguous target or reserved decision");
		expect(calls).toEqual([
			["setup", "agents", "context", "show", "--json"],
			["-w", "tedix", "auth", "status", "--json"],
		]);
	});

	test("a bound project mismatch hides the item and skips attempts", async () => {
		const { output, calls } = await automaticBrief({
			status: "bound",
			workspace: "tedix",
			projectId: "expected",
			workItemId: WORK_ID,
		});
		expect(output).toContain("does not match the bound project");
		expect(output).not.toContain("Bound task");
		expect(calls).toHaveLength(3);
	});

	test("an explicit other profile does not use bound Work", async () => {
		const { output, calls } = await automaticBrief(
			{
				status: "bound",
				workspace: "tedix",
				projectId: "project-id",
				workItemId: WORK_ID,
			},
			{ env: { TEDIX_WORKSPACE: "other" } },
		);
		expect(output).toBe("");
		expect(calls).toHaveLength(1);
	});

	test("an invalid binding reports the local fix without gateway reads", async () => {
		const { output, calls } = await automaticBrief({ status: "invalid" });
		expect(output).toContain("local binding is invalid");
		expect(calls).toHaveLength(1);
	});
});
