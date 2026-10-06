import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";
import {
	workflowEngineErrorMessage,
	workflowEngineErrorText,
} from "../src/workflow-engine-error";
import { fingerprintWorkflowError } from "../src/workflow-restart";

// A Cloudflare Workflow instance exposes only `{ name, message }` for a failed
// instance, so the thrown TYPE is the only signal separating a deliberate
// refusal (NonRetryableError) from a crash.
const refusal = {
	name: "NonRetryableError",
	message: "SKILL_INPUT_REJECTED: missing tenant scope",
};
const crash = { name: "TypeError", message: "x is not a function" };

// The persisted text carries the thrown name.
assert.equal(
	workflowEngineErrorText(refusal),
	"NonRetryableError: SKILL_INPUT_REJECTED: missing tenant scope",
);
assert.equal(workflowEngineErrorText(crash), "TypeError: x is not a function");

// The downstream API classifier (apps/api cognitive-skill-runs) reads the
// refusal class off that type token; it never sees the engine snapshot.
assert.equal(
	/\bNonRetryableError\b/.test(workflowEngineErrorText(refusal)!),
	true,
);
assert.equal(
	/\bNonRetryableError\b/.test(workflowEngineErrorText(crash)!),
	false,
);

// A string error still round-trips unchanged: there is no name to carry.
assert.equal(
	workflowEngineErrorText("WORKFLOW_TERMINATED"),
	"WORKFLOW_TERMINATED",
);
assert.equal(
	workflowEngineErrorMessage("WORKFLOW_TERMINATED"),
	"WORKFLOW_TERMINATED",
);

// No error, no text.
assert.equal(workflowEngineErrorText(null), null);
assert.equal(workflowEngineErrorText(undefined), null);
assert.equal(workflowEngineErrorMessage(null), null);

// A nameless snapshot keeps exactly the message; a blank name is not a name.
assert.equal(workflowEngineErrorText({ message: "boom" }), "boom");
assert.equal(workflowEngineErrorText({ name: "  ", message: "boom" }), "boom");

// A message that already leads with its own type name is not double-prefixed.
assert.equal(
	workflowEngineErrorText({
		name: "NonRetryableError",
		message: "NonRetryableError: already named",
	}),
	"NonRetryableError: already named",
);

// A snapshot with no message at all still degrades to the serialized engine
// value, exactly as both writers did before, and still carries the name.
assert.equal(
	workflowEngineErrorText({ name: "NonRetryableError" }),
	'NonRetryableError: {"name":"NonRetryableError"}',
);

// The fingerprint input is the RAW message, never the persisted text. The
// dispatcher fences a failed epoch with fingerprintWorkflowError(err.message)
// before the engine reports it (skill-workflow.ts), so the restart barrier
// only ever compares message against message.
assert.equal(workflowEngineErrorMessage(refusal), refusal.message);
assert.equal(
	await fingerprintWorkflowError(workflowEngineErrorMessage(refusal)),
	await fingerprintWorkflowError(refusal.message),
);
assert.notEqual(
	await fingerprintWorkflowError(workflowEngineErrorMessage(refusal)),
	await fingerprintWorkflowError(workflowEngineErrorText(refusal)),
);

// Both writers of skill_runs.error — the /status path in index.ts and the cron
// reconciler — must derive the persisted text from the one helper, or the
// failure class downstream depends on which writer wrote last, and must
// fingerprint the raw message. Structural guard over each writer's syntax tree
// (imports and data flow), because neither writer can be driven here without
// its full D1 lifecycle.
type Node = { type: string; [key: string]: any };
function walk(node: unknown, visit: (node: Node) => void) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	const record = node as Node;
	if (typeof record.type === "string") visit(record);
	for (const value of Object.values(record)) walk(value, visit);
}
const calleeName = (node: Node) =>
	node.type === "CallExpression" && node.callee.type === "Identifier"
		? (node.callee.name as string)
		: null;
for (const file of ["../src/index.ts", "../src/reconciler.ts"]) {
	const { program } = parseSync(
		file,
		readFileSync(new URL(file, import.meta.url), "utf8"),
	);
	const imported = new Set<string>();
	const initOf = new Map<string, string | null>();
	const fingerprinted: Node[] = [];
	const projected: Node[] = [];
	let inlineDerivation = false;
	walk(program, (node) => {
		if (
			node.type === "ImportDeclaration" &&
			node.source.value === "./workflow-engine-error"
		)
			for (const specifier of node.specifiers)
				imported.add(specifier.imported.name);
		if (
			node.type === "VariableDeclarator" &&
			node.id.type === "Identifier" &&
			node.init
		)
			initOf.set(node.id.name, calleeName(node.init));
		if (calleeName(node) === "fingerprintWorkflowError")
			fingerprinted.push(node);
		if (calleeName(node) === "workflowEngineErrorText") projected.push(node);
		if (
			node.type === "LogicalExpression" &&
			node.operator === "??" &&
			node.left.type === "MemberExpression" &&
			node.left.property?.name === "message" &&
			node.left.object?.property?.name === "error"
		)
			inlineDerivation = true;
	});
	assert.ok(
		imported.has("workflowEngineErrorText"),
		`${file} imports the shared text`,
	);
	assert.ok(
		imported.has("workflowEngineErrorMessage"),
		`${file} imports the shared message`,
	);
	assert.ok(
		projected.length > 0,
		`${file} persists the shared name-carrying text`,
	);
	assert.equal(
		inlineDerivation,
		false,
		`${file} must not re-derive the engine error inline`,
	);
	for (const call of fingerprinted) {
		const [argument] = call.arguments as Node[];
		const source =
			argument?.type === "Identifier"
				? initOf.get(argument.name)
				: argument
					? calleeName(argument)
					: null;
		assert.equal(
			source,
			"workflowEngineErrorMessage",
			`${file} must fingerprint the raw engine message, not the persisted text`,
		);
	}
}

console.log("workflow engine error projection tests passed");
