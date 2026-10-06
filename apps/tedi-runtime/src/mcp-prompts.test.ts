import { strict as assert } from "node:assert";
import {
	artifactFileContent,
	deriveTediPromptDescriptors,
	registerTediPrompts,
	tediPromptDescription,
	tediPromptMessages,
} from "./mcp-mount";

// --- deriveTediPromptDescriptors: files → prompt descriptors ---------------

// Live DO shape: files is a string[] of repo paths.
assert.deepEqual(
	deriveTediPromptDescriptors({
		files: [
			"prompts/weekly-report.md",
			"prompts/standup.md",
			"prompts/notes.txt", // not markdown
			"prompts/nested/deep.md", // nested directories are skipped
			"prompts/.hidden.md", // unsafe name (leading dot)
			"memory/MEMORY.md", // outside the prompts/ prefix
			"prompts/weekly-report.md", // duplicate
		],
	}),
	[
		{ name: "weekly-report", path: "prompts/weekly-report.md" },
		{ name: "standup", path: "prompts/standup.md" },
	],
);

// Object entries ({ path } / { name }) are also accepted.
assert.deepEqual(
	deriveTediPromptDescriptors({
		files: [{ path: "prompts/a.md" }, { name: "prompts/b.md" }, {}, null],
	}),
	[
		{ name: "a", path: "prompts/a.md" },
		{ name: "b", path: "prompts/b.md" },
	],
);

// Missing/failed listings derive no prompts.
assert.deepEqual(deriveTediPromptDescriptors({ ok: false, error: "boom" }), []);
assert.deepEqual(deriveTediPromptDescriptors(null), []);
assert.deepEqual(deriveTediPromptDescriptors({ files: "nope" }), []);

// --- tediPromptDescription: body → description -----------------------------

// First markdown heading wins, even after leading prose.
assert.equal(
	tediPromptDescription("intro line\n\n## Weekly Report\nbody", "fb"),
	"Weekly Report",
);
// No heading → first non-empty line.
assert.equal(
	tediPromptDescription("\n\nSummarize the week.\nMore.", "fb"),
	"Summarize the week.",
);
// Empty body → fallback.
assert.equal(tediPromptDescription("\n \n", "fb"), "fb");
// Long lines are clamped to a bounded description.
const longLine = "x".repeat(500);
const clamped = tediPromptDescription(longLine, "fb");
assert.equal(clamped.length, 200);
assert.ok(clamped.endsWith("…"));

// --- artifactFileContent: read result → body -------------------------------

assert.equal(artifactFileContent({ ok: true, content: "hello" }), "hello");
assert.equal(artifactFileContent({ ok: false, error: "not_found" }), null);
assert.equal(artifactFileContent({ ok: true }), null);
assert.equal(artifactFileContent("garbage"), null);
assert.equal(artifactFileContent(null), null);

// --- tediPromptMessages: body → one user message ---------------------------

assert.deepEqual(tediPromptMessages("Do the thing."), {
	messages: [
		{ role: "user", content: { type: "text", text: "Do the thing." } },
	],
});

// --- registerTediPrompts: registration against stub tools ------------------

type Registered = {
	name: string;
	config: { title?: string; description?: string };
	cb: () => Promise<{
		description?: string;
		messages: Array<{ role: string; content: { type: string; text: string } }>;
	}>;
};

function stubServer() {
	const registered: Registered[] = [];
	return {
		registered,
		server: {
			registerPrompt(
				name: string,
				config: Registered["config"],
				cb: Registered["cb"],
			) {
				registered.push({ name, config, cb });
				return {};
			},
		} as unknown as Parameters<typeof registerTediPrompts>[0],
	};
}

const bodies: Record<string, string> = {
	"prompts/weekly-report.md": "# Weekly report drafter\n\nDraft the report.",
	"prompts/standup.md": "Summarize yesterday and today.",
};
const reads: Array<{ path: string; maxChars?: number }> = [];
const tools = {
	listArtifactFiles: async (input: { prefix?: string; limit?: number }) => {
		assert.equal(input.prefix, "prompts/");
		assert.equal(input.limit, 50);
		return { ok: true, files: Object.keys(bodies) };
	},
	readArtifactFile: async (input: { path: string; maxChars?: number }) => {
		reads.push({ path: input.path, maxChars: input.maxChars });
		const content = bodies[input.path];
		return content === undefined
			? { ok: false, error: "not_found" }
			: { ok: true, content };
	},
};

// prompts/list: eager bounded head-reads derive descriptions.
{
	const { server, registered } = stubServer();
	await registerTediPrompts(server, tools, "prompts/list");
	assert.deepEqual(
		registered.map((entry) => [entry.name, entry.config.description]),
		[
			["weekly-report", "Weekly report drafter"],
			["standup", "Summarize yesterday and today."],
		],
	);
	assert.ok(reads.every((read) => read.maxChars === 600));
}

// prompts/get: no eager body reads; the callback lazily reads the full file
// and returns one user message carrying the body.
{
	reads.length = 0;
	const { server, registered } = stubServer();
	await registerTediPrompts(server, tools, "prompts/get");
	assert.equal(reads.length, 0);
	assert.deepEqual(
		registered.map((entry) => [entry.name, entry.config.description]),
		[
			["weekly-report", "weekly-report"],
			["standup", "standup"],
		],
	);
	const result = await registered[0]!.cb();
	assert.equal(result.description, "Weekly report drafter");
	assert.deepEqual(result.messages, [
		{
			role: "user",
			content: {
				type: "text",
				text: "# Weekly report drafter\n\nDraft the report.",
			},
		},
	]);
	// The lazy read fetched the full body (no description head-read cap).
	assert.deepEqual(reads, [
		{ path: "prompts/weekly-report.md", maxChars: undefined },
	]);
}

// A prompt whose file disappeared between list and get fails loudly.
{
	const { server, registered } = stubServer();
	await registerTediPrompts(
		server,
		{
			listArtifactFiles: async () => ({ ok: true, files: ["prompts/gone.md"] }),
			readArtifactFile: async () => ({ ok: false, error: "not_found" }),
		},
		"prompts/get",
	);
	await assert.rejects(registered[0]!.cb(), /prompts\/gone\.md/);
}

// A failed listing registers nothing (the empty prompts list still serves).
{
	const { server, registered } = stubServer();
	await registerTediPrompts(
		server,
		{
			listArtifactFiles: async () => {
				throw new Error("Artifacts unavailable");
			},
			readArtifactFile: tools.readArtifactFile,
		},
		"prompts/list",
	);
	assert.deepEqual(registered, []);
}

// A failed description read degrades to the prompt name, never an error.
{
	const { server, registered } = stubServer();
	await registerTediPrompts(
		server,
		{
			listArtifactFiles: async () => ({ ok: true, files: ["prompts/a.md"] }),
			readArtifactFile: async () => {
				throw new Error("read failed");
			},
		},
		"prompts/list",
	);
	assert.deepEqual(
		registered.map((entry) => [entry.name, entry.config.description]),
		[["a", "a"]],
	);
}

console.log("Tedi MCP prompts tests passed.");
