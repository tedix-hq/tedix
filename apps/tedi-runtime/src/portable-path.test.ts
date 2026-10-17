import assert from "node:assert/strict";
import { normalizePortablePath } from "./portable-path";

assert.equal(normalizePortablePath("  ///docs/report.md  "), "docs/report.md");
assert.equal(normalizePortablePath("a".repeat(1024)), "a".repeat(1024));
for (const path of [
	undefined,
	null,
	1,
	"",
	" / ",
	"../x",
	"a/./b",
	"a//b",
	"a/",
	"a\0b",
	"a".repeat(1025),
]) {
	assert.equal(normalizePortablePath(path), null);
}
console.log("PASS: portable artifact paths");
