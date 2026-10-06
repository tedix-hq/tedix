import { strict as assert } from "node:assert";
import {
	artifactResourceMimeType,
	deriveTediArtifactResourceDescriptors,
	readTediArtifactResource,
	registerTediArtifactResources,
} from "./mcp-mount";

// --- artifactResourceMimeType: path → mime ---------------------------------

assert.equal(artifactResourceMimeType("memory/MEMORY.md"), "text/markdown");
assert.equal(artifactResourceMimeType("state/cursor.JSON"), "application/json");
assert.equal(artifactResourceMimeType("config.yaml"), "application/yaml");
assert.equal(artifactResourceMimeType("config.yml"), "application/yaml");
assert.equal(artifactResourceMimeType("scripts/run.sh"), "text/x-shellscript");
assert.equal(artifactResourceMimeType("scripts/etl.py"), "text/x-python");
assert.equal(artifactResourceMimeType("repo/src/index.ts"), "text/javascript");
assert.equal(artifactResourceMimeType("repo/src/index.js"), "text/javascript");
assert.equal(artifactResourceMimeType("notes.txt"), "text/plain");
assert.equal(artifactResourceMimeType("Dockerfile"), "text/plain");

// --- deriveTediArtifactResourceDescriptors: files → descriptors ------------

// Live DO shape: files is a string[] of repo paths. Every path is included —
// .r2/ notes and repo/ files too — no filtering beyond dedupe + the cap.
assert.deepEqual(
	deriveTediArtifactResourceDescriptors({
		files: [
			"SOUL.md",
			"memory/MEMORY.md",
			".r2/large-blob.note",
			"repo/src/index.ts",
			"SOUL.md", // duplicate
		],
	}),
	[
		{
			path: "SOUL.md",
			uri: "artifact:///SOUL.md",
			mimeType: "text/markdown",
		},
		{
			path: "memory/MEMORY.md",
			uri: "artifact:///memory/MEMORY.md",
			mimeType: "text/markdown",
		},
		{
			path: ".r2/large-blob.note",
			uri: "artifact:///.r2/large-blob.note",
			mimeType: "text/plain",
		},
		{
			path: "repo/src/index.ts",
			uri: "artifact:///repo/src/index.ts",
			mimeType: "text/javascript",
		},
	],
);

// Object entries ({ path } / { name }) are also accepted.
assert.deepEqual(
	deriveTediArtifactResourceDescriptors({
		files: [{ path: "a.md" }, { name: "b.txt" }, {}, null, ""],
	}).map((descriptor) => descriptor.path),
	["a.md", "b.txt"],
);

// Listings are capped at 200 descriptors.
assert.equal(
	deriveTediArtifactResourceDescriptors({
		files: Array.from({ length: 250 }, (_, i) => `state/file-${i}.md`),
	}).length,
	200,
);

// Missing/failed listings derive no resources.
assert.deepEqual(
	deriveTediArtifactResourceDescriptors({ ok: false, error: "boom" }),
	[],
);
assert.deepEqual(deriveTediArtifactResourceDescriptors(null), []);
assert.deepEqual(deriveTediArtifactResourceDescriptors({ files: "nope" }), []);

// --- readTediArtifactResource: lazy read → contents envelope ---------------

const bodies: Record<string, string> = {
	"memory/MEMORY.md": "# Memory\n\nFacts.",
	"state/cursor.json": '{"cursor":42}',
};
const reads: Array<{ path: string; maxChars?: number }> = [];
const readTools = {
	readArtifactFile: async (input: { path: string; maxChars?: number }) => {
		reads.push({ path: input.path, maxChars: input.maxChars });
		const content = bodies[input.path];
		return content === undefined
			? { ok: false, error: "not_found" }
			: { ok: true, content };
	},
};

{
	const result = await readTediArtifactResource(
		readTools,
		"memory/MEMORY.md",
		"artifact:///memory/MEMORY.md",
	);
	assert.deepEqual(result, {
		contents: [
			{
				uri: "artifact:///memory/MEMORY.md",
				mimeType: "text/markdown",
				text: "# Memory\n\nFacts.",
			},
		],
	});
	// The lazy read fetched the full body (no maxChars cap).
	assert.deepEqual(reads, [{ path: "memory/MEMORY.md", maxChars: undefined }]);
}

// A missing file fails loudly, naming the path.
await assert.rejects(
	readTediArtifactResource(readTools, "gone.md", "artifact:///gone.md"),
	/gone\.md/,
);

// --- registerTediArtifactResources: registration against stub tools --------

type Registered = {
	name: string;
	uriOrTemplate: unknown;
	config: { description?: string; mimeType?: string };
	cb: (...args: unknown[]) => Promise<{
		contents: Array<{ uri: string; mimeType?: string; text: string }>;
	}>;
};

function stubServer() {
	const registered: Registered[] = [];
	return {
		registered,
		server: {
			registerResource(
				name: string,
				uriOrTemplate: unknown,
				config: Registered["config"],
				cb: Registered["cb"],
			) {
				registered.push({ name, uriOrTemplate, config, cb });
				return {};
			},
		} as unknown as Parameters<typeof registerTediArtifactResources>[0],
	};
}

const listings: Array<{ prefix?: string; limit?: number }> = [];
const tools = {
	listArtifactFiles: async (input: { prefix?: string; limit?: number }) => {
		listings.push(input);
		return { ok: true, files: Object.keys(bodies) };
	},
	readArtifactFile: readTools.readArtifactFile,
};

// resources/list: one bounded listing registers the template plus one static
// resource per path; name/description is the path (no per-file reads).
{
	reads.length = 0;
	const { server, registered } = stubServer();
	await registerTediArtifactResources(server, tools, "resources/list");
	assert.deepEqual(listings, [{ limit: 200 }]);
	assert.equal(reads.length, 0);
	const [template, ...statics] = registered;
	assert.equal(template!.name, "tedi-artifact-file");
	assert.notEqual(typeof template!.uriOrTemplate, "string");
	assert.deepEqual(
		statics.map((entry) => [
			entry.name,
			entry.uriOrTemplate,
			entry.config.description,
			entry.config.mimeType,
		]),
		[
			[
				"memory/MEMORY.md",
				"artifact:///memory/MEMORY.md",
				"memory/MEMORY.md",
				"text/markdown",
			],
			[
				"state/cursor.json",
				"artifact:///state/cursor.json",
				"state/cursor.json",
				"application/json",
			],
		],
	);
	// The static resource callback lazily reads the full body.
	const result = await statics[1]!.cb();
	assert.deepEqual(result.contents, [
		{
			uri: "artifact:///state/cursor.json",
			mimeType: "application/json",
			text: '{"cursor":42}',
		},
	]);
	assert.deepEqual(reads, [{ path: "state/cursor.json", maxChars: undefined }]);
}

// resources/read: no listing, no eager reads — only the I/O-free template,
// which resolves any repo path (listed or not) via one lazy read.
{
	listings.length = 0;
	reads.length = 0;
	const { server, registered } = stubServer();
	await registerTediArtifactResources(server, tools, "resources/read");
	assert.deepEqual(listings, []);
	assert.equal(reads.length, 0);
	assert.equal(registered.length, 1);
	const template = registered[0]!;
	const result = await template.cb(new URL("artifact:///memory/MEMORY.md"), {
		file_path: "memory/MEMORY.md",
	});
	assert.deepEqual(result.contents, [
		{
			uri: "artifact:///memory/MEMORY.md",
			mimeType: "text/markdown",
			text: "# Memory\n\nFacts.",
		},
	]);
	// Array-valued template variables join into a path.
	const joined = await template.cb(new URL("artifact:///state/cursor.json"), {
		file_path: ["state", "cursor.json"],
	});
	assert.equal(joined.contents[0]!.text, '{"cursor":42}');
	// A missing file fails loudly through the template too.
	await assert.rejects(
		template.cb(new URL("artifact:///gone.md"), { file_path: "gone.md" }),
		/gone\.md/,
	);
}

// resources/templates/list: template only, zero I/O.
{
	listings.length = 0;
	const { server, registered } = stubServer();
	await registerTediArtifactResources(
		server,
		tools,
		"resources/templates/list",
	);
	assert.deepEqual(listings, []);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]!.name, "tedi-artifact-file");
}

// A failed listing registers only the template (empty list still serves).
{
	const { server, registered } = stubServer();
	await registerTediArtifactResources(
		server,
		{
			listArtifactFiles: async () => {
				throw new Error("Artifacts unavailable");
			},
			readArtifactFile: readTools.readArtifactFile,
		},
		"resources/list",
	);
	assert.equal(registered.length, 1);
	assert.equal(registered[0]!.name, "tedi-artifact-file");
}

console.log("Tedi MCP resources tests passed.");
