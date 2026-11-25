import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentConnectionProblem,
	agentGrant,
	checkedTedixAccount,
	duplicateClaudeConnection,
	devinConnection,
	opencodeConnection,
	recentConnectionCheck,
	tedixAccountSummary,
	toolConnection,
} from "./tool-connection";

test("a checked Tedix email is compared to the app without guessing opaque identities", () => {
	for (const host of ["devin", "opencode"]) {
		const account = checkedTedixAccount(
			`${host}: a Tedix profile read succeeded inside the tool, as other@example.com.\n`,
		);
		assert.equal(account, "other@example.com");
		assert.equal(
			tedixAccountSummary(account, "app@example.com").text,
			"Tedix account last checked: other@example.com (different from this app)",
		);
	}
	assert.equal(
		checkedTedixAccount("OpenCode confirmed the Tedix connection."),
		undefined,
	);
	assert.equal(
		tedixAccountSummary(undefined, "app@example.com").text,
		"Tedix account: not checked",
	);
	assert.equal(
		tedixAccountSummary("other@example.com", "app@example.com").mismatch,
		true,
	);
	assert.equal(
		tedixAccountSummary("APP@example.com", "app@example.com").mismatch,
		false,
	);
	assert.equal(
		tedixAccountSummary("user_123", "app@example.com").mismatch,
		false,
	);
	assert.equal(tedixAccountSummary("other@example.com", "").mismatch, false);
});

test("a saved read only applies to the account and executable that passed it", () => {
	const target = {
		command: "/Applications/Example.app/tool",
		version: "1.0",
		user: "user_a",
		org: "org_a",
	};
	const proof = JSON.parse(JSON.stringify({ ...target, at: 0 }));
	assert.equal(recentConnectionCheck(proof, target, 60_000), true);
	assert.equal(
		recentConnectionCheck(proof, { ...target, user: "user_b" }, 60_000),
		false,
	);
	assert.equal(
		recentConnectionCheck(proof, { ...target, org: "org_b" }, 60_000),
		false,
	);
	assert.equal(
		recentConnectionCheck(
			proof,
			{ ...target, command: "/usr/local/bin/tool" },
			60_000,
		),
		false,
	);
	assert.equal(
		recentConnectionCheck(proof, { ...target, version: "1.1" }, 60_000),
		false,
	);
	assert.equal(recentConnectionCheck(proof, undefined, 60_000), false);
	assert.equal(recentConnectionCheck(proof, target, 24 * 60 * 60_000), false);
});

test("a current sign-in rejection wins over an earlier read", () => {
	assert.equal(toolConnection("signed-in", false), "signed-in");
	assert.equal(toolConnection("signed-out", true), "signed-out");
	assert.equal(toolConnection("unknown", false), "unknown");
	assert.equal(toolConnection(undefined, true), "signed-in");
});

test("OpenCode's terminal and desktop status formats identify the Tedix connection", () => {
	assert.equal(
		opencodeConnection(
			"●  ✓ tedix \x1b[90mconnected (OAuth)\n│      https://connect.mcp.tedix.dev/mcp",
		),
		"signed-in",
	);
	assert.equal(
		opencodeConnection("✓ other  connected\n✓ tedix  connected"),
		"signed-in",
	);
	assert.equal(
		opencodeConnection("⚠ tedix  needs authentication"),
		"signed-out",
	);
	assert.equal(
		opencodeConnection("✗ tedix  failed: 401 Unauthorized"),
		"signed-out",
	);
	assert.equal(
		opencodeConnection("✗ tedix  failed: other server connected"),
		"unknown",
	);
	assert.equal(opencodeConnection("✓ other  connected"), "unknown");
});

test("Devin's Tedix connection has to finish successfully", () => {
	const origin = 'INFO toolbox::tools::mcp: output_channel="MCP: tedix" ';
	assert.equal(
		devinConnection(`${origin}MCP server 'tedix' connected successfully`),
		"signed-in",
	);
	assert.equal(
		devinConnection(
			`${origin}MCP server 'tedix' connection failed: Auth required`,
		),
		"signed-out",
	);
	assert.equal(
		devinConnection(
			`${origin}MCP server 'tedix' connection failed: network unavailable`,
		),
		"unknown",
	);
	assert.equal(
		devinConnection(
			`toolbox::tools::mcp::config: output_channel="MCP: tedix" server="tedix" Streamable HTTP returned 403 for 'tedix', falling back to SSE`,
		),
		"signed-out",
	);
	assert.equal(
		devinConnection(`${origin}Connecting to MCP server 'tedix'`),
		undefined,
	);
});

test("an expired or expiring grant wins over a recent successful call", () => {
	const now = Date.parse("2026-11-25T12:00:00Z");
	const grant = {
		status: "active" as const,
		providerStatus: "present" as const,
		expiresAt: new Date(now + 600_000).toISOString(),
		lastSuccessfulCallAt: new Date(now - 1000).toISOString(),
	};
	const input = {
		connection: "signed-in" as const,
		mismatch: false,
		grant,
		now,
	};
	assert.equal(agentConnectionProblem(input)?.action, "signin");
	assert.equal(
		agentConnectionProblem({ ...input, now: now + 600_000 })?.action,
		"signin",
	);
	assert.equal(
		agentConnectionProblem({ ...input, grant: { ...grant, expiresAt: null } }),
		undefined,
	);
	assert.equal(
		agentConnectionProblem({
			...input,
			grant: { ...grant, expiresAt: null, providerStatus: "unavailable" },
		})?.action,
		"check",
	);
	assert.equal(
		agentConnectionProblem({ ...input, mismatch: true })?.action,
		"account",
	);
	assert.equal(
		agentConnectionProblem({ ...input, duplicate: true })?.action,
		"remove",
	);
});

test("only an unambiguous agent grant is used and an unrelated connector is not a duplicate", () => {
	const grant = {
		mcpServerId: "connect",
		clientId: "client",
		clientName: "Claude Code",
		revision: "00000000-0000-4000-8000-000000000001",
		status: "active" as const,
		providerStatus: "present" as const,
		selectedTenantIds: ["example"],
		approvedScopes: [],
		updatedAt: "today",
	};
	assert.equal(agentGrant("claude", [grant]), grant);
	assert.equal(
		agentGrant("claude", [grant, { ...grant, clientId: "other" }]),
		undefined,
	);
	assert.equal(agentGrant("codex", [grant]), undefined);
	assert.equal(
		duplicateClaudeConnection(
			"claude.ai Tedix: https://connect.mcp.tedix.dev/mcp (HTTP) - Connected",
		),
		true,
	);
	assert.equal(
		duplicateClaudeConnection(
			"claude.ai Other: https://other.example/mcp - Connected",
		),
		false,
	);
	assert.equal(
		duplicateClaudeConnection(
			"plugin:tedix:tedix: https://connect.mcp.tedix.dev/mcp - Connected",
		),
		false,
	);
});
