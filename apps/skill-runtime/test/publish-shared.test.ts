import assert from "node:assert/strict";
import {
	assertNoLineComments,
	buildUpsertSkillJs,
	replaceAnchor,
	stripTsNocheckPragma,
} from "../eval/publish-shared";

// --- replaceAnchor: exactly-one-occurrence anchored replacement -------------

assert.equal(
	replaceAnchor(
		"a\nconst GOLD = __GOLD__;\nb",
		"const GOLD = __GOLD__;",
		"const GOLD = [1];",
	),
	"a\nconst GOLD = [1];\nb",
);

// The bare token elsewhere (e.g. a doc comment mentioning __GOLD__) does not
// disturb an anchor on the full assignment.
assert.equal(
	replaceAnchor(
		"// __GOLD__ is injected\nconst GOLD = __GOLD__;",
		"const GOLD = __GOLD__;",
		"const GOLD = [];",
	),
	"// __GOLD__ is injected\nconst GOLD = [];",
);

assert.throws(
	() => replaceAnchor("nothing here", "const GOLD = __GOLD__;", "x"),
	/anchor not found/,
);

assert.throws(
	() => replaceAnchor("A;\nA;", "A;", "x"),
	/anchor occurs more than once/,
);

// Adjacent (overlap-free) double occurrence is still a double occurrence.
assert.throws(() => replaceAnchor("A;A;", "A;", "x"), /more than once/);

// --- stripTsNocheckPragma ----------------------------------------------------

assert.equal(
	stripTsNocheckPragma("// @ts-nocheck — repo only\ncode();\n", "t"),
	"code();\n",
);
// Only the pragma LINE goes; continuation comment lines stay (they ship fine —
// the workflow rides base64, newlines intact).
assert.equal(
	stripTsNocheckPragma("// @ts-nocheck x\n// more prose\ncode();\n", "t"),
	"// more prose\ncode();\n",
);
assert.throws(() => stripTsNocheckPragma("code();\n", "t"), /missing leading/);

// --- assertNoLineComments: the one-line-fold safety check --------------------

// Clean payloads pass.
assertNoLineComments(`async () => {\n  const a = 1;\n  return a;\n}`, "t");
// `//` inside string literals is content, not a comment.
assertNoLineComments(`const u = "https://example.com";`, "t");
assertNoLineComments(`const u = 'a // b';`, "t");
assertNoLineComments("const t = `a // b`;", "t");
// Escaped quote does not end the string early.
assertNoLineComments(`const s = "a\\" // still string";`, "t");
// Multi-line template literals keep protecting their content.
assertNoLineComments("const t = `line1 // x\nline2`;", "t");

// A real line comment throws, with the line number.
assert.throws(
	() => assertNoLineComments(`const a = 1;\n// swallow the rest\nrun();`, "t"),
	/line 2/,
);
// ...even at end of line after code.
assert.throws(
	() => assertNoLineComments(`const a = 1; // note`, "t"),
	/line comment/,
);
// A single-line quote left open by a newline does not mask a comment below.
assert.throws(
	() => assertNoLineComments(`const broken = "unterminated\n// comment`, "t"),
	/line 2/,
);
// Division does not false-positive.
assertNoLineComments(`const half = a / 2 / b;`, "t");

// --- buildUpsertSkillJs: one improve_skills call, fold-safe ------------------

const js = buildUpsertSkillJs({
	skillId: "5eed0037-0000-4000-8000-000000000037",
	skillMd: "---\nname: x\n---\n# X\n",
	workflowJs: "export default { async run() { return 1; } };\n",
	revisionReasoning: "test",
});
// The payload itself must survive its own one-line fold.
assertNoLineComments(js, "upsert payload");
// Upsert is by canonical id — never a title search, never a create fallback.
assert.match(
	js,
	/skills\.improve_skills\(\{ id: "5eed0037-0000-4000-8000-000000000037"/,
);
assert.doesNotMatch(js, /list_skills_by_org|record_skills/);
// Payloads ride base64 so quoting/tabs survive the shell.
assert.match(
	js,
	new RegExp(
		Buffer.from("---\nname: x\n---\n# X\n", "utf8").toString("base64"),
	),
);

console.log("publish-shared.test.ts: all assertions passed");
