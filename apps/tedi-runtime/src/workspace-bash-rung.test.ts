/**
 * Structural certification for the Cloudflare Computer agent runtime.
 *
 * One shared tool composer owns Computer shell execution, native Git, and
 * snapshots; every turn host consumes it, so
 * files, Git, and shell commands cannot drift onto parallel substrates.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
	chatTurnProbe,
	constructedTediDo,
	MCP_FACET_TURN_INPUT,
	mcpFacetTurnProbe,
	nativeToolMarkers,
	tediDo,
} from "../test/tedi-do";
import { facetContext } from "../test/facet";
import * as runtimeWorker from "./index";
import { workspaceToolGuidance } from "./runtime-tool-guidance";

// Bun's module mock, without depending on bun:test's type declarations.
const { mock } = createRequire(import.meta.url)("bun:test") as {
	mock: { module(name: string, factory: () => Record<string, unknown>): void };
};

// Computer's worker-shell backend needs a real Worker Loader; record how the
// runtime registers it instead.
const shellBackends: Array<Record<string, unknown>> = [];
mock.module("@cloudflare/computer/backends/worker-shell", () => ({
	WorkerShellBackend: class {
		constructor(options: Record<string, unknown>) {
			shellBackends.push(options);
		}
	},
}));
const {
	COMPUTER_ISOLATE_BACKEND_ID,
	createTediComputerTools,
	createTediWorkspaceVfs,
} = await import("./workspace-fs");
const { TediComputerWorkspaceDO } = await import("./computer-workspace-do");
const { ScopedComputerWorkspace } = await import("./computer-workspace-scope");

// --- the durable Workspace registers one default-deny isolate backend ---
{
	const ctx = facetContext();
	const events: Record<string, unknown>[] = [];
	const originalLog = console.log;
	const stub = {
		getEntrypoint() {
			throw new Error("not executed");
		},
	};
	let called = 0;
	const callback = () => {
		called++;
		return {
			compatibilityDate: "2026-06-17",
			mainModule: "fixture.js",
			modules: {},
		};
	};
	const loader = {
		get(name: string, getCode: unknown) {
			assert.equal(this, loader);
			assert.equal(name, "fictional-stable-shell");
			assert.equal(getCode, callback);
			return stub;
		},
	};
	const execution = {
		ctx: ctx as never,
		loader,
		workspace: { binding: "TEDI_COMPUTER_WORKSPACE", id: "ws-1" },
	};
	shellBackends.length = 0;
	console.log = (value: unknown) => events.push(JSON.parse(String(value)));
	try {
		createTediWorkspaceVfs(ctx.storage as never, { execution });
		assert.equal(shellBackends.length, 1);
		const options = shellBackends[0]!;
		const { loader: passedLoader, ...rest } = options;
		assert.deepEqual(rest, {
			ctx: execution.ctx,
			workspace: execution.workspace,
			egress: { mode: "none" },
			id: COMPUTER_ISOLATE_BACKEND_ID,
		});
		assert.equal(options.ctx, execution.ctx);
		assert.equal(options.workspace, execution.workspace);
		assert.notEqual(passedLoader, loader);
		assert.equal(events.length, 0);
		assert.equal(
			(passedLoader as typeof loader).get("fictional-stable-shell", callback),
			stub,
		);
		assert.equal(called, 0, "native named get retains lazy callback");
		assert.equal("load" in (passedLoader as object), false);
		assert.deepEqual(
			events,
			["attempted", "returned"].map((phase) => ({
				event: "tedix.dynamic_worker.loader_call",
				version: 1,
				surface: "tedi_workspace_shell",
				reason: "tedi_workspace_shell_invocation",
				method: "get",
				identity: "named",
				phase,
			})),
		);
		for (const event of events)
			assert.deepEqual(Object.keys(event).sort(), [
				"event",
				"identity",
				"method",
				"phase",
				"reason",
				"surface",
				"version",
			]);
		assert.equal(
			JSON.stringify(events).includes("fictional-stable-shell"),
			false,
		);
	} finally {
		console.log = originalLog;
	}
	shellBackends.length = 0;
	createTediWorkspaceVfs(ctx.storage as never);
	assert.deepEqual(shellBackends, [], "no execution, no shell backend");
}

// --- Computer's native exec routes to that registered backend by default ---
{
	const execs: unknown[][] = [];
	const tools = createTediComputerTools({
		fs: new Proxy({}, { get: () => async () => "" }),
		runtime: {
			exec: async (...args: unknown[]) => {
				execs.push(args);
				throw new Error("recorded");
			},
		},
	} as never);
	await (tools.exec as { execute: Function })
		.execute({ command: "ls /workspace" }, { toolCallId: "c", messages: [] })
		.catch(() => undefined);
	assert.equal(execs.length, 1);
	assert.match(
		JSON.stringify(execs[0]),
		new RegExp(`"${COMPUTER_ISOLATE_BACKEND_ID}"`),
	);
}

// --- scoped Computer tools act on the captured workspace capability ---
{
	const reads: unknown[] = [];
	const namespace = {
		idFromName: (name: string) => ({ toString: () => name }),
		get: () => ({}),
	};
	const scope = new ScopedComputerWorkspace(
		namespace as never,
		{ kind: "delegated-run", key: "run-1" },
		"owner-1",
		async () => "tedi-1",
	);
	// Every file operation the tools make lands on this scope's surface.
	for (const name of Object.keys(scope.surface.fs) as Array<
		keyof typeof scope.surface.fs
	>)
		scope.surface.fs[name] = (async (...args: unknown[]) => {
			reads.push([name, ...args]);
			return name === "stat" || name === "lstat"
				? { type: "file", size: 8, mtime: new Date() }
				: "contents";
		}) as never;
	const result = await (scope.tools().read as { execute: Function }).execute(
		{ path: "/workspace/notes.md" },
		{ toolCallId: "c", messages: [] },
	);
	void result;
	assert.deepEqual(reads[0], ["stat", "/workspace/notes.md"]);
}

// --- the scoped Computer DO exposes its Workspace stub only once initialized ---
{
	const host = new (TediComputerWorkspaceDO as unknown as new (
		ctx: unknown,
		env: unknown,
	) => Record<string, any>)(facetContext(), {});
	await assert.rejects(
		host.__getWorkspaceStub(),
		/Computer workspace is not initialized/,
	);
	await host.initialize({
		ownerId: "owner-1",
		tediId: "tedi-1",
		scope: "run:1",
	});
	const stub = { workspace: "stub" };
	let ready = false;
	host.workspace = {
		ready: async () => void (ready = true),
		stub: () => stub,
	};
	assert.equal(await host.__getWorkspaceStub(), stub);
	assert.equal(ready, true);
}

for (const repositoryMode of [undefined, "checkout"] as const) {
	const guidance = workspaceToolGuidance({ supervised: true, repositoryMode });
	assert.match(
		guidance,
		/absolute paths/i,
		"Computer guidance retains the absolute-path contract",
	);
	assert.match(guidance, /\/workspace/, "scratch workspace remains explicit");
	assert.match(
		guidance,
		/returned cwd/,
		"opened Computer guidance selects its actual working directory",
	);
	assert.match(
		guidance,
		/identity snapshot is read-only/,
		"identity remains canonical and read-only",
	);
	assert.doesNotMatch(
		guidance,
		/The \.r2\/ prefix/,
		"Computer guidance must not teach relative identity paths",
	);
}

// Every turn host composes files, Git and snapshots from the ONE scoped
// composer, with its own scope and Work context.
{
	const composed: Array<[string, unknown, unknown]> = [];
	const composer = (host: string) => (scope: unknown, context: unknown) => {
		composed.push([host, scope, context]);
		return {};
	};
	const binding = {
		runId: "run-1",
		conversationId: "c",
		platform: { setEpisodeTrace() {} },
	};
	const native = tediDo({
		env: {},
		state: {},
		activeTurnBinding: null,
		...nativeToolMarkers(),
		workspaceAiTools: composer("native"),
	});
	native.getTools({ kind: "conversation", key: "main" }, binding);
	const setup = mcpFacetTurnProbe({
		fields: { workspaceAiTools: composer("mcp") },
	});
	await setup.prepareMcpFacetTurn({
		...MCP_FACET_TURN_INPUT,
		workItemId: "w-1",
		homeRunId: "h-1",
	});
	const sse = chatTurnProbe({
		async facetTurn() {
			return { assistantText: "ok" };
		},
		fields: { workspaceAiTools: composer("sse") },
	});
	await sse.run({ text: "hello", sessionKey: "session-sse" });
	const email = tediDo({
		env: {},
		state: { tediId: "tedi-1", slug: "acme" },
		mcpRuntime: null,
		async getMcpRuntime() {
			return null;
		},
		async getPlatformClient() {
			return null;
		},
		...nativeToolMarkers(),
		workspaceAiTools: composer("email"),
		effectiveStepCeiling: () => 8,
		async runConversationFacetTurn() {
			return { assistantText: "ok", turnError: null };
		},
	});
	await email.completeEmailTurn({
		system: "SYSTEM",
		sessionKey: "email:thread-1",
		runId: "run-1",
		inboundEmail: {},
		payload: { from: "a@example.com", subject: "Hi", threadId: "thread-1" },
		guardedUserText: "hello",
		userTs: 1,
	});
	const computerEnvironment = tediDo({
		workspaceAiTools: composer("environment"),
		computerEnvironment: () => ({}),
	});
	computerEnvironment.workstationAiTool(
		{ kind: "operator", key: "direct-control" },
		null,
	);

	const hosts = composed.map(([host]) => host);
	assert.deepEqual(hosts, ["native", "mcp", "sse", "email", "environment"]);
	for (const [host, scope] of composed)
		assert.ok(
			scope && typeof (scope as { key?: unknown }).key === "string",
			`${host} composes a scoped workspace`,
		);
	assert.equal(
		composed[0]?.[2],
		binding,
		"native tools carry the turn's Work context",
	);
	assert.equal(
		(composed[1]?.[1] as { kind?: string }).kind,
		"delegated-run",
		"a delegated facet turn composes its delegated-run scope",
	);
	assert.equal((composed[2]?.[1] as { key?: string }).key, "session-sse");

	// The shared composer includes files, native Git, commit and artifact tools.
	const tools = tediDo({
		computerWorkspace: () => ({ tools: () => ({ read: {} }), workspace: {} }),
		computerEnvironment: () => ({}),
	}).workspaceAiTools({ kind: "conversation", key: "main" }, null);
	for (const name of [
		"read",
		"clone_repo",
		"run_git",
		"repo_commit",
		"artifact_list_files",
		"workspace_snapshot",
	])
		assert.ok(name in tools, `the composer provides ${name}`);

	assert.equal(
		"workspaceBash" in constructedTediDo(),
		false,
		"the Agent parent must not expose a second shell runtime",
	);
	assert.equal(typeof runtimeWorker.WorkspaceServiceProxy, "function");
}

console.log(
	"workspace-bash-rung OK (Computer WorkerShellBackend is canonical)",
);
