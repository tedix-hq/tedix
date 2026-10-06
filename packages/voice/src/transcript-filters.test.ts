/**
 * Unit tests for the transcript filler and punctuation filters.
 *
 * Same style as self-healing.test.ts: node:assert, run as a plain bun script.
 *   bun run src/transcript-filters.test.ts
 */

import assert from "node:assert/strict";
import { isFillerOnly, isPunctuationOnly } from "./runtime";

for (const token of [
	"um",
	"uh",
	"hmm",
	"hm",
	"mm",
	"mhm",
	"mmhm",
	"huh",
	"ah",
	"oh",
]) {
	assert.equal(isFillerOnly(token), true, `filler '${token}'`);
}
assert.equal(isFillerOnly("um."), true, "filler with trailing punctuation");
assert.equal(isFillerOnly("hmm…"), true, "filler with trailing ellipsis");
assert.equal(isFillerOnly("UM"), true, "filler is case-insensitive");
assert.equal(isFillerOnly("hello"), false, "real word");
assert.equal(isFillerOnly("um yeah"), false, "multi-word");
assert.equal(isFillerOnly(""), false, "empty string is not filler");

for (const token of ["...", "?", "!!", ",.;:"]) {
	assert.equal(isPunctuationOnly(token), true, `punctuation '${token}'`);
}
assert.equal(
	isPunctuationOnly(""),
	true,
	"empty string has no letters or digits",
);
assert.equal(isPunctuationOnly("a"), false, "letter");
assert.equal(isPunctuationOnly("1"), false, "digit");
assert.equal(isPunctuationOnly("hello"), false, "word");
assert.equal(
	isPunctuationOnly("...hello"),
	false,
	"punctuation followed by letters",
);

console.log("transcript-filters.test.ts: all assertions passed");
