/** Parent DO state is not the canonical transcript. Native Pi projection lives
 * only in pi-agent.ts and cognitive facets; parent history uses child RPC or D1.
 * This scan rejects accidental parent this.messages reads after harness changes. */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sourceRoot = import.meta.dirname;
const modules = readdirSync(sourceRoot, { recursive: true })
	.map(String)
	.filter(
		(file) =>
			file.endsWith(".ts") &&
			!file.endsWith(".test.ts") &&
			!file.endsWith("-facet.ts") &&
			file !== "pi-agent.ts",
	);

// A real `this.messages` PROPERTY access: `this.messages` NOT immediately
// followed by an identifier char, so the distinct `this.messagesForSession(...)`
// method (a per-session working set with its own review surface) is excluded.
const READ_RE = /this\.messages(?![A-Za-z0-9_])/;

// The sole sanctioned read: last-user-message correlation id for the turn.
const SANCTIONED: RegExp[] = [];

const offenders: Array<{ file: string; line: number; text: string }> = [];
let sanctionedCount = 0;
for (const file of modules) {
	const source = readFileSync(join(sourceRoot, file), "utf8");
	sanctionedCount += source
		.split("\n")
		.filter((l) => /lastUserMessageId\(this\.messages\)/.test(l)).length;
	source.split("\n").forEach((raw, index) => {
		const trimmed = raw.trim();
		// Skip comment/doc lines — prose mentions of `this.messages` are not reads.
		if (
			trimmed.startsWith("*") ||
			trimmed.startsWith("//") ||
			trimmed.startsWith("/*")
		) {
			return;
		}
		// Drop any trailing line comment so an inline `// ... this.messages ...` note
		// is not counted as code.
		const code = raw.split("//")[0] ?? "";
		if (!READ_RE.test(code)) return;
		if (SANCTIONED.some((re) => re.test(code))) return;
		offenders.push({ file, line: index + 1, text: trimmed });
	});
}

assert.equal(
	offenders.length,
	0,
	"Unsanctioned this.messages read(s) in the tedi runtime — the tedi " +
		"runtime is truth-in-D1; this.messages (Pi DO-SQLite) is a turn-scoped " +
		"working set, NOT the canonical transcript. Route transcript reads through " +
		"the D1 event ledger, or (turn-scoped only) match the sanctioned " +
		"lastUserMessageId(this.messages) pattern. Offenders:\n" +
		offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join("\n"),
);

// Assert the parent was scanned and still delegates cognitive execution. A
// disappearing read is valid, but an empty scan or wrong runtime is not.
assert.ok(modules.includes("do.ts"));
const parent = readFileSync(join(sourceRoot, "do.ts"), "utf8");
assert.match(parent, /class AgentTediDO extends Agent/);
assert.ok(
	parent.includes("runConversationFacetTurn"),
	"parent must delegate facet execution",
);
console.log(
	"Canonical transcript guard: native parent scanned, zero working-set reads",
);
