import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTediDurableCodemode } from "./durable-codemode";
import { durableCodemodeRuntimeName } from "./durable-codemode-runtime-name";

const names = [
	"computer-workspace-a:scratch",
	"computer-workspace-a:lease-a",
	"computer-workspace-b:lease-a",
	"computer-workspace:a-lease",
	"computer-workspace-a:lease",
	"computer-雪:🌍",
	"computer-雪:🌎",
	"computer-\ud800:scratch",
	"computer-\ud801:scratch",
	"computer-\\ud800:scratch",
	"computer-\ufffd:scratch",
	`computer-${"a".repeat(512)}:lease-a`,
	`computer-${"a".repeat(512)}:lease-b`,
	"a".repeat(118),
	"a".repeat(119),
	"",
];
const encoded = await Promise.all(names.map(durableCodemodeRuntimeName));
assert.equal(new Set(encoded).size, names.length);
for (const [index, name] of names.entries()) {
	const value = encoded[index]!;
	assert.match(value, /^tedix-(?:sha256-)?[a-f0-9]+$/);
	assert.equal(await durableCodemodeRuntimeName(name), value);
	assert.ok(`codemode:${value}`.length <= 256);
	const source = JSON.stringify(name);
	const priorHexName = `tedix-${Buffer.from(source).toString("hex")}`;
	if (`codemode:${priorHexName}`.length > 256) {
		assert.equal(
			value,
			`tedix-sha256-${createHash("sha256").update(source).digest("hex")}`,
		);
		continue;
	}
	assert.equal(
		value,
		priorHexName,
		"Existing valid identities must not change",
	);
	const bytes = Uint8Array.from(
		value.slice("tedix-".length).match(/../g)!,
		(pair) => Number.parseInt(pair, 16),
	);
	assert.equal(JSON.parse(new TextDecoder().decode(bytes)), name);
}

// Reach the actual SDK lookup through the production adapter, rather than
// duplicating its naming validator or replacing createCodemodeRuntime.
const lookups: string[] = [];
const limits: Array<number | undefined> = [];
const execution = { id: "native-execution" };
const ctx = {
	exports: { CodemodeRuntime: class {} },
	facets: {
		get(name: string, factory: () => { class: unknown }) {
			// Workerd actor-state.c++ enforces MAX_FACET_NAME_LENGTH=256.
			assert.ok(Buffer.byteLength(name) <= 256, "Facet name is too long");
			lookups.push(name);
			assert.equal(factory().class, ctx.exports.CodemodeRuntime);
			return {
				async listExecutions(limit?: number) {
					limits.push(limit);
					return [execution];
				},
			};
		},
	},
} as unknown as DurableObjectState;
const noWorkspaceAccess = async () => {
	throw new Error("Execution inventory must not access connector tools");
};
for (const name of names) {
	const runtime = await createTediDurableCodemode({
		ctx,
		env: {} as Cloudflare.Env,
		loader: {} as WorkerLoader,
		name,
		mcpRuntime: {
			ensureSynced: noWorkspaceAccess,
			getToolSpecs: () => {
				throw new Error("Inventory must not hydrate tools");
			},
			executeTool: noWorkspaceAccess,
		},
		workspace: {
			deleteFile: noWorkspaceAccess,
			diffContent: noWorkspaceAccess,
			readFile: noWorkspaceAccess,
			writeFile: noWorkspaceAccess,
		},
	});
	assert.deepEqual(await runtime.executions(1), [execution]);
}
assert.deepEqual(
	lookups,
	encoded.map((name) => `codemode:${name}`),
);
assert.deepEqual(
	limits,
	names.map(() => 1),
);
console.log("durable Code Mode runtime name and SDK adapter tests passed");
