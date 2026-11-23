import assert from "node:assert/strict";
import { test } from "node:test";
import { selectedHarnessCommand } from "./harness-target";
import {
	devinConnection,
	opencodeConnection,
	toolConnection,
} from "./tool-connection";

test("setup stays on the desktop executable when both installs are present", () => {
	assert.equal(
		selectedHarnessCommand(true, "/desktop/codex", "/standalone/codex"),
		"/desktop/codex",
	);
	assert.equal(
		selectedHarnessCommand(true, "/desktop/codex", undefined),
		"/desktop/codex",
	);
	assert.equal(
		selectedHarnessCommand(false, undefined, "/standalone/codex"),
		"/standalone/codex",
	);
	assert.equal(
		selectedHarnessCommand(true, undefined, "/standalone/codex"),
		undefined,
	);
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
