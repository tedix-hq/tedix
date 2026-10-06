import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tediDo } from "../test/tedi-do";
import { ScopedComputerWorkspace } from "./computer-workspace-scope";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const appDirectory = join(sourceDirectory, "..");
const packageJson = JSON.parse(
	readFileSync(join(appDirectory, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };
const rootPackageJson = JSON.parse(
	readFileSync(join(appDirectory, "..", "..", "package.json"), "utf8"),
) as { catalog?: Record<string, string> };

// Exact version, never a range: Computer owns the isolate workspace contract,
// so its filesystem, Git and tool behavior must change in one reviewed bump.
// The separately governed workstation pins Sandbox and its donor image under
// its own runtime contract.
assert.equal(
	packageJson.dependencies?.["@cloudflare/computer"],
	"catalog:",
	"the runtime must resolve Computer through the root catalog",
);
assert.match(
	rootPackageJson.catalog?.["@cloudflare/computer"] ?? "",
	/^\d+\.\d+\.\d+(-[\w.]+)?$/,
	"the root catalog must pin one exact published Computer version",
);
assert.equal(
	packageJson.dependencies?.["@cloudflare/workspace"],
	undefined,
	"the retired Workspace package must not return",
);

// Workspace access crosses Computer's observable RPC boundary: every call
// initializes the scoped DO, obtains its stub through getWorkspace, and
// disposes the client afterwards.
{
	const events: string[] = [];
	const workspaceStub = {
		fs: {
			async stat(path: string) {
				events.push(`stat:${path}`);
				return { type: "file" };
			},
		},
		git: {
			async cli() {
				events.push("git.cli");
				return { exitCode: 0, stdout: "clean", stderr: "" };
			},
		},
		[Symbol.dispose]() {
			events.push("dispose");
		},
	};
	const namespace = {
		idFromName: (name: string) => ({ toString: () => `id:${name}` }),
		get: () => ({
			async initialize() {
				events.push("initialize");
			},
			async __getWorkspaceStub() {
				events.push("getWorkspace");
				return workspaceStub;
			},
		}),
	};
	const computer = new ScopedComputerWorkspace(
		namespace as unknown as ConstructorParameters<
			typeof ScopedComputerWorkspace
		>[0],
		{ kind: "conversation", key: "main" },
		"owner",
		async () => "tedi-1",
	);
	assert.deepEqual(await computer.surface.fs.stat("/a"), { type: "file" });
	assert.deepEqual(events, [
		"initialize",
		"getWorkspace",
		"stat:/a",
		"dispose",
	]);

	// Git runs through the same captured Computer client, as the tedi.
	events.length = 0;
	const agent = tediDo({
		state: { slug: "acme", tediId: "tedi-1" },
		async ensureIdentity() {},
	});
	const result = (await agent.gitCliTool({ args: ["status"] }, computer)) as {
		ok: boolean;
	};
	assert.equal(result.ok, true);
	assert.deepEqual(events, [
		"initialize",
		"getWorkspace",
		"git.cli",
		"dispose",
	]);
}

// Runtime diagnostics identify the Computer workspace (not a generic
// Workspace or an R2 "spillover").
{
	const agent = tediDo({
		env: { TEDI_STORAGE: {} },
		state: { tediId: "tedi-1", slug: "acme" },
		async ensureIdentity() {},
		async listSchedules() {
			return [];
		},
		sessionRepo: { listTurns: () => [] },
		compiledDirectives: [],
		activeTurnBinding: null,
	});
	const response = await agent.onRequest(
		new Request("https://do.internal/__admin/agent-diag", {
			headers: { "X-Service-Binding": "true" },
		}),
	);
	const body = (await response.json()) as {
		primitives: Record<string, Record<string, unknown>>;
	};
	assert.equal(body.primitives.computerWorkspace?.configured, true);
	assert.equal(body.primitives.computerWorkspace?.r2IdentityMount, true);
	assert.equal(body.primitives.thinkWorkspace, undefined);
	assert.equal(
		JSON.stringify(body).includes("r2Spillover"),
		false,
		"the Computer R2 identity mount must not be described as legacy spillover",
	);
}

console.log("Cloudflare Computer adoption guard passed");
