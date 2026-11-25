/// <reference types="bun-types" />
import { test } from "bun:test";
import assert from "node:assert/strict";
import { isNewer, newerTool, sameRelease } from "./version";

test("an app update that brings a newer command-line tool offers it", () => {
	// The copy in use and the copy inside the app name their build commit.
	const have = "0.37.13+263afcfa8";
	const inside = "0.37.14+912a3423c";
	assert.equal(isNewer("0.37.14", have), true);
	assert.equal(newerTool(have, inside, "0.37.14"), inside);
	assert.equal(newerTool(have, inside, ""), inside);
	assert.equal(newerTool(have, inside, "0.37.15"), "0.37.15");
	assert.equal(newerTool(inside, inside, "0.37.14"), undefined);
	assert.equal(newerTool("0.37.14+aaaaaaa", inside, "0.37.14"), undefined);
	assert.equal(sameRelease("0.37.14", inside), true);
	assert.equal(sameRelease("0.37.13", inside), false);
});
