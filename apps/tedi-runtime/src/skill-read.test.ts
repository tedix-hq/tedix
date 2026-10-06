import assert from "node:assert/strict";
import { asSchema } from "ai";
import type { SkillForMcpEntry } from "./brain/platform-client";
import { createSkillReadTool } from "./skill-read";

const id = "5eed0031-0000-4000-8000-000000000031";
const entry: SkillForMcpEntry = {
	id,
	slug: "review",
	title: "Review",
	summary: "Independent review",
	content: "# Review\nRead the proposal.",
	lifecycleState: "active",
	tags: ["review"],
	domain: "engineering",
	files: { "reference.md": "private contents" },
};
const reads: Array<{ id?: string; slug?: string }> = [];
let writes = 0;
let answer: SkillForMcpEntry | null = entry;
let failure: unknown;
const platform = {
	getSkillForMcp: async (input: { id?: string; slug?: string }) => {
		reads.push(input);
		if (failure !== undefined) throw failure;
		return { entry: answer };
	},
	skillUsage: () => {
		writes++;
		throw new Error("A lookup must never stamp usage");
	},
};
const reader = createSkillReadTool(() => platform);
const execute = (input: { id?: string; slug?: string }) =>
	reader.execute!(input, {
		toolCallId: "read-1",
		messages: [],
		context: {},
	});
const expected = {
	ok: true,
	id,
	slug: "review",
	title: entry.title,
	summary: entry.summary,
	content: entry.content,
	lifecycleState: "active",
	tags: ["review"],
	domain: "engineering",
	files: ["reference.md"],
};
for (const input of [
	{ slug: "review" },
	{ id },
	{ id, slug: "review" },
	{ id },
]) {
	assert.deepEqual(await execute(input), expected);
}
assert.deepEqual(reads, [
	{ slug: "review" },
	{ id },
	{ slug: "review" },
	{ id },
]);
assert.equal(writes, 0);
assert.deepEqual(await execute({}), {
	ok: false,
	error: "Provide either slug or id",
});
assert.equal(reads.length, 4, "missing selectors must not call the platform");
answer = null;
for (const input of [{ id }, { slug: "missing" }]) {
	assert.deepEqual(await execute(input), {
		ok: false,
		error: `Skill not found: ${input.slug ?? id}`,
	});
}
assert.equal(writes, 0, "failed lookups must not demote or flag a skill");
answer = { id, title: "Minimal" };
assert.deepEqual(await execute({ slug: "fallback" }), {
	ok: true,
	id,
	slug: "fallback",
	title: "Minimal",
	summary: null,
	content: null,
	lifecycleState: null,
	tags: [],
	domain: null,
	files: [],
});
const secret = "synthetic".repeat(4);
failure = new Error(`Bearer ${secret} ${"x".repeat(2000)}`);
const failed = (await execute({ id })) as Record<string, unknown>;
assert.equal(failed.ok, false);
assert.equal(typeof failed.error, "string");
assert.ok(!String(failed.error).includes(secret));
assert.ok(String(failed.error).includes("__TEDIX_REDACTED__"));
assert.ok(String(failed.error).endsWith("…(truncated)"));
assert.ok(String(failed.error).length <= 1014);
failure = {
	toString() {
		throw new Error("unprintable");
	},
};
assert.deepEqual(await execute({ id }), {
	ok: false,
	error: "skill read failed",
});
assert.equal(
	writes,
	0,
	"thrown lookup errors must not stamp failed executions",
);

const absent = createSkillReadTool(() => null);
assert.deepEqual(
	await absent.execute!(
		{ id },
		{ toolCallId: "absent", messages: [], context: {} },
	),
	{
		ok: false,
		error:
			"Platform client not available — tedi identity may not be resolved yet",
	},
);
// A later turn can replace its binding; the already-created reader retains its
// captured platform rather than consulting a mutable global active turn.
const first = {
	platform: { getSkillForMcp: async () => ({ entry: { id, title: "first" } }) },
};
let active = first;
const captured = active;
const bound = createSkillReadTool(() => captured.platform);
active = {
	platform: {
		getSkillForMcp: async () => ({ entry: { id, title: "second" } }),
	},
};
assert.equal(
	(
		(await bound.execute!(
			{ id },
			{ toolCallId: "bound", messages: [], context: {} },
		)) as Record<string, unknown>
	).title,
	"first",
);
assert.equal((await active.platform.getSkillForMcp()).entry.title, "second");
const schema = asSchema(reader.inputSchema);
assert.equal((await schema.validate!({ id: "not-a-uuid" })).success, false);
assert.equal(
	(await schema.validate!({ slug: "x".repeat(201) })).success,
	false,
);
assert.equal((await schema.validate!({ id })).success, true);
console.log("skill-read.test.ts: all assertions passed");
