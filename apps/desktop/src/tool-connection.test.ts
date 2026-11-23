import assert from "node:assert/strict";
import { test } from "node:test";
import {
	devinConnection,
	opencodeConnection,
	recentConnectionCheck,
	toolConnection,
} from "./tool-connection";

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
		devinConnection(`${origin}Connecting to MCP server 'tedix'`),
		undefined,
	);
});
