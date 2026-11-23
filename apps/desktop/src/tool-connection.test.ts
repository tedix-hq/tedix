import assert from "node:assert/strict";
import { test } from "node:test";
import { toolConnection } from "./tool-connection";

test("a current tool response wins over a remembered sign-in or earlier read", () => {
	assert.equal(toolConnection("signed-in", undefined, true), "signed-in");
	assert.equal(toolConnection("signed-in", false, true), "signed-out");
	assert.equal(toolConnection("signed-out", true, true), "signed-out");
	assert.equal(toolConnection("unknown", true, true), "unknown");
	assert.equal(toolConnection(undefined, false, true), "signed-out");
	assert.equal(toolConnection(undefined, undefined, true), "signed-in");
	assert.equal(toolConnection(undefined, undefined, false), "unknown");
});
