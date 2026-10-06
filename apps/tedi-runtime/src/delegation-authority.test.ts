import assert from "node:assert/strict";
import { createAITools } from "@cloudflare/computer/tools";
import type { DelegationAuthorityEnvelope } from "@tedix/api-contract/schemas/kernel-runtime";
import type { ToolSet } from "ai";
import {
	COMPUTER_TOOL_CAPABILITIES,
	delegatedTurnAuthority,
	evaluateDelegatedFacetTool,
	parseDelegationAuthorityEnvelope,
	parseDelegationAuthorityMode,
	restrictDelegatedToolSet,
	supervisedDelegationToolSet,
	computerToolsForDelegatedTurn,
} from "./delegation-authority";

const envelope: DelegationAuthorityEnvelope = {
	version: "earned-delegation.v1",
	grantId: "grant-invoice-read",
	grantRevision: 3,
	decisionId: "decision-invoice-read",
	activityId: "invoice-read",
	activityVersion: 2,
	taskFamily: "acme.invoices.list",
	riskLevel: "medium",
	environment: "production",
	allowedToolIds: ["repo_load", "acme_tedix.list_invoices"],
	expiresAt: null,
};

assert.deepEqual(parseDelegationAuthorityEnvelope(envelope), envelope);

/** Test-local view of the proxy decision: the verdict reduced to allow/deny. */
function authorizeDelegatedFacetTool(
	input: Parameters<typeof evaluateDelegatedFacetTool>[0],
): { allowed: boolean } {
	return { allowed: evaluateDelegatedFacetTool(input).allowed };
}

const definition = { execute: async () => ({ ok: true }) };
const unrestricted = {
	repo_load: definition,
	bash: definition,
	list_work_approval_inbox: definition,
	decide_work_approval: definition,
	tedix_mcp_call_tool: definition,
	tedix_mcp_code: definition,
} as unknown as ToolSet;
const restricted = restrictDelegatedToolSet(unrestricted, envelope, "enforce");
assert.deepEqual(Object.keys(restricted).sort(), [
	"decide_work_approval",
	"list_work_approval_inbox",
	"repo_load",
	"tedix_mcp_call_tool",
]);

assert.equal(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "enforce",
		tool: "tedix_mcp_call_tool",
		args: { callable: "acme_tedix.list_invoices", args: { limit: 5 } },
	}).allowed,
	true,
	"the exact planned namespaced callable is executable",
);

for (const tool of ["list_work_approval_inbox", "decide_work_approval"]) {
	assert.deepEqual(
		authorizeDelegatedFacetTool({ envelope, mode: "enforce", tool, args: {} }),
		{ allowed: true },
		`${tool} remains identity-bound and callable inside a valid Home delegation`,
	);
}

for (const denied of [
	{
		tool: "tedix_mcp_call_tool",
		args: { callable: "acme_tedix.create_invoice", args: {} },
	},
	{ tool: "bash", args: { command: "echo escape" } },
	{ tool: "tedix_mcp_code", args: { code: "async () => 1" } },
]) {
	const decision = authorizeDelegatedFacetTool({
		envelope,
		mode: "enforce",
		...denied,
	});
	assert.equal(decision.allowed, false);
}

assert.deepEqual(
	authorizeDelegatedFacetTool({
		envelope,
		mode: "enforce",
		tool: "repo_load",
		args: { path: "README.md" },
	}),
	{ allowed: true },
	"an exact local tool key is executable",
);

// --- Which delegated turns carry per-tool authority at all -----------------
// A Home delegation without an earned envelope was authorized by the dispatch
// decision (operator-forced / approved / autonomous) and runs on the supervised
// ceiling; nothing is evaluated per tool and no verdict is recorded. In enforce
// mode such a run is refused at dispatch and at runtime ingress (403) before
// any tool call, so there is no enforcement for a shadow verdict to mirror.
assert.equal(
	delegatedTurnAuthority({ delegated: true, mode: "shadow" }),
	null,
	"a delegated turn without an envelope has no per-tool authority to evaluate",
);
assert.equal(
	delegatedTurnAuthority({ delegated: true, mode: "enforce" }),
	null,
	"enforce without an envelope is rejected before the turn; the proxy never sees it",
);
assert.equal(
	delegatedTurnAuthority({ delegated: false, envelope, mode: "enforce" }),
	null,
	"an ordinary operator conversation is never evaluated against a grant",
);
assert.deepEqual(
	delegatedTurnAuthority({ delegated: true, envelope }),
	{ envelope, mode: "shadow" },
	"a delegated turn carrying a grant is evaluated, defaulting to shadow",
);
assert.deepEqual(
	delegatedTurnAuthority({ delegated: true, envelope, mode: "enforce" }),
	{ envelope, mode: "enforce" },
	"a delegated turn carrying a grant is evaluated in the dispatched mode",
);

const supervisedTools = {
	read: definition,
	exec: definition,
	browser_scrape: definition,
	artifact_write_file: definition,
	clone_repo: definition,
	repo_commit: definition,
	run_git: definition,
	open_computer: definition,
	read_skill: definition,
	tedix_mcp_code: definition,
	tedix_mcp_search_tools: definition,
	tedix_mcp_call_tool: definition,
	mcp_read_result: definition,
	mcp_read_resource: definition,
	cron: definition,
	object_store_write_text: definition,
	deliverable_list: definition,
	deliverable_read_text: definition,
	deliverable_read_artifact: definition,
	record_artifact: definition,
	brain_search: definition,
	r2_sql_query: definition,
	run_durable_code: definition,
	list_work_approval_inbox: definition,
	decide_work_approval: definition,
	start_assigned_work: definition,
	heartbeat_assigned_work: definition,
	submit_assigned_work_evidence: definition,
	settle_assigned_work: definition,
} as unknown as ToolSet;
assert.deepEqual(
	Object.keys(supervisedDelegationToolSet(supervisedTools, true)).sort(),
	[
		"artifact_write_file",
		"list_work_approval_inbox",
		"decide_work_approval",
		"mcp_read_result",
		"browser_scrape",
		"clone_repo",
		"deliverable_list",
		"deliverable_read_artifact",
		"deliverable_read_text",
		"exec",
		"read",
		"read_skill",
		"record_artifact",
		"repo_commit",
		"run_git",
		"tedix_mcp_code",
		"open_computer",
	].sort(),
	"Home-supervised turns expose execution tools and one batched MCP primitive",
);
assert.equal(
	supervisedDelegationToolSet(supervisedTools, false),
	supervisedTools,
	"ordinary tedi conversations retain their full operator surface",
);
assert.equal(
	restrictDelegatedToolSet(
		supervisedDelegationToolSet(supervisedTools, true),
		envelope,
		"enforce",
	).mcp_read_result,
	undefined,
	"an earned delegation still requires an explicit grant to read retained MCP results",
);
for (const name of [
	"start_assigned_work",
	"heartbeat_assigned_work",
	"submit_assigned_work_evidence",
	"settle_assigned_work",
]) {
	assert.equal(
		supervisedDelegationToolSet(supervisedTools, true)[name],
		undefined,
		`${name} is owned by Home, not a supervised child`,
	);
	assert.equal(
		supervisedDelegationToolSet(supervisedTools, false)[name],
		definition,
		`${name} remains available to ordinary tedi conversations`,
	);
	for (const mode of ["shadow", "enforce"] as const) {
		assert.equal(
			restrictDelegatedToolSet(
				supervisedDelegationToolSet(supervisedTools, true),
				envelope,
				mode,
			)[name],
			undefined,
			`${name} cannot be restored by ${mode} authority filtering`,
		);
	}
}
assert.deepEqual(
	Object.keys(supervisedDelegationToolSet(supervisedTools, true, true)).sort(),
	[
		...Object.keys(supervisedDelegationToolSet(supervisedTools, true)),
		"tedix_mcp_call_tool",
	].sort(),
	"an enforced earned-delegation grant retains its exact-call transport",
);
assert.deepEqual(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "shadow",
		tool: "bash",
		args: { command: "echo observational-only" },
	}),
	{
		allowed: true,
		wouldHaveDenied: true,
		requestedSurface: "bash",
		reason: `Tool "bash" is outside delegated activity ${envelope.activityId}`,
	},
	"shadow mode reports the enforcement verdict against the real grant without narrowing authority",
);
assert.deepEqual(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "shadow",
		tool: "repo_load",
		args: {},
	}),
	{ allowed: true, wouldHaveDenied: false, requestedSurface: "repo_load" },
	"shadow mode also records when the requested surface fits the envelope",
);
assert.equal(
	evaluateDelegatedFacetTool({
		envelope,
		mode: "shadow",
		tool: "tedix_mcp_call_tool",
		args: { callable: "acme_tedix.create_invoice" },
	}).requestedSurface,
	"acme_tedix.create_invoice",
	"namespaced MCP calls name the requested callable rather than only the transport",
);
assert.equal(
	authorizeDelegatedFacetTool({
		envelope,
		mode: "shadow",
		tool: "bash",
		args: { command: "echo observational-only" },
	}).allowed,
	true,
	"shadow mode does not enforce an otherwise matching envelope",
);
assert.deepEqual(
	Object.keys(
		restrictDelegatedToolSet(unrestricted, envelope, "shadow"),
	).sort(),
	Object.keys(unrestricted).sort(),
	"shadow mode does not narrow descriptors after grants appear",
);

const workstationTools = {
	open_computer: definition,
	close_computer: definition,
	exec: definition,
	read_execution: definition,
	cancel_execution: definition,
	workstation_start_dev_server: definition,
} as unknown as ToolSet;
assert.deepEqual(
	Object.keys(computerToolsForDelegatedTurn(workstationTools, "native")).sort(),
	[
		"cancel_execution",
		"close_computer",
		"exec",
		"open_computer",
		"read_execution",
	],
	"native Agent delegation retains Computer tools without exposing separate workstation orchestration",
);
assert.equal(
	computerToolsForDelegatedTurn(workstationTools, "workstation"),
	workstationTools,
	"an explicitly workstation-capable turn retains the workstation surface",
);
assert.deepEqual(
	Object.keys(
		computerToolsForDelegatedTurn(workstationTools, "managed_job"),
	).sort(),
	[
		"cancel_execution",
		"close_computer",
		"exec",
		"open_computer",
		"read_execution",
	],
	"managed-job delegation exposes lifecycle and job tools but no interactive dev-server surface",
);
assert.equal(
	computerToolsForDelegatedTurn(workstationTools),
	workstationTools,
	"non-Home surfaces preserve their historical workstation surface",
);

assert.equal(
	authorizeDelegatedFacetTool({
		envelope: { ...envelope, expiresAt: "2000-01-01T00:00:00.000Z" },
		mode: "enforce",
		tool: "repo_load",
		args: {},
	}).allowed,
	false,
	"an expired audited grant cannot authorize a child tool call",
);

// --- Shadow-default pin (deliberate) --------------------------------------
// Enforcement of an earned grant is opted into per organization policy
// (`resolveEarnedDelegationEnforcement` in apps/api); an absent or null mode
// on the dispatched metadata means shadow. Whoever flips the default must
// change this pin in the same deliberate commit.
assert.equal(
	parseDelegationAuthorityMode(undefined),
	"shadow",
	"an absent delegationAuthorityMode must default to shadow",
);
assert.equal(
	parseDelegationAuthorityMode(null),
	"shadow",
	"a null delegationAuthorityMode must default to shadow",
);

console.log("All delegated authority envelope tests passed.");

const composedApprovalTools = restrictDelegatedToolSet(
	supervisedDelegationToolSet(supervisedTools, true, true),
	envelope,
	"enforce",
);
for (const name of ["list_work_approval_inbox", "decide_work_approval"]) {
	assert.ok(
		composedApprovalTools[name],
		`${name} must survive both supervised and authority filters`,
	);
}
assert.equal(composedApprovalTools.cron, undefined);

// Discover the installed SDK's descriptors so newly added tools cannot silently
// disappear from supervision or acquire a classification without review.
const unused = () => {
	throw new Error("descriptor discovery must not execute workspace operations");
};
const computerWorkspace = {
	fs: {
		stat: unused,
		readFile: unused,
		writeFile: unused,
		mkdir: unused,
		rm: unused,
		find: unused,
		grep: unused,
		readdir: unused,
	},
	runtime: { exec: unused },
};
const computerTools = createAITools({
	workspace: computerWorkspace,
	shell: {
		defaultBackend: "isolate",
		backends: { isolate: { description: "Native workspace" } },
	},
});
assert.deepEqual(
	Object.keys(COMPUTER_TOOL_CAPABILITIES).sort(),
	[
		...Object.keys(computerTools),
		"open_computer",
		"close_computer",
		"read_execution",
		"cancel_execution",
		"code_search",
	].sort(),
	"every native Computer tool must have an explicit capability classification",
);
assert.deepEqual(
	Object.entries(COMPUTER_TOOL_CAPABILITIES)
		.filter(([, capability]) => capability === "read")
		.map(([name]) => name)
		.sort(),
	[
		...Object.keys(
			createAITools({ workspace: computerWorkspace, readonly: true }),
		),
		"read_execution",
		"code_search",
	].sort(),
	"read classification must match the SDK's read-only surface",
);
const supervisedComputerTools = supervisedDelegationToolSet(
	computerTools,
	true,
);
assert.deepEqual(
	Object.keys(supervisedComputerTools).sort(),
	Object.keys(computerTools).sort(),
	"supervision must preserve the complete Computer surface before authority narrowing",
);
const readGrant = {
	...envelope,
	allowedToolIds: ["read", "ls", "find", "grep"],
};
assert.deepEqual(
	Object.keys(
		restrictDelegatedToolSet(supervisedComputerTools, readGrant, "enforce"),
	).sort(),
	readGrant.allowedToolIds.slice().sort(),
	"read-only grants must not expose mutations or shell execution",
);
for (const name of Object.keys(computerTools)) {
	assert.equal(
		authorizeDelegatedFacetTool({
			envelope: readGrant,
			mode: "enforce",
			tool: name,
			args: {},
		}).allowed,
		readGrant.allowedToolIds.includes(name),
		`${name} must require its exact earned authority even when supervised`,
	);
	const exactGrant = { ...envelope, allowedToolIds: [name] };
	assert.deepEqual(
		Object.keys(
			restrictDelegatedToolSet(supervisedComputerTools, exactGrant, "enforce"),
		),
		[name],
		`${name} must survive both filters when explicitly granted`,
	);
	assert.equal(
		authorizeDelegatedFacetTool({
			envelope: exactGrant,
			mode: "enforce",
			tool: name,
			args: {},
		}).allowed,
		true,
	);
}
assert.deepEqual(
	restrictDelegatedToolSet(supervisedComputerTools, undefined, "enforce"),
	{},
	"enforce mode exposes no descriptors at all if the envelope is lost",
);
console.log("All native Computer delegation capability tests passed.");
