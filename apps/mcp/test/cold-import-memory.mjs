import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRequire = createRequire(
	import.meta.resolve("@cloudflare/vitest-plugin"),
);
const { Miniflare, convertV4MiniflareOptions } = await import(
	pluginRequire.resolve("miniflare")
);
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temp = mkdtempSync(join(tmpdir(), "tedix-cold-import-memory-"));
let runtime;
try {
	const build = await Bun.build({
		entrypoints: [join(appDir, "test/fixtures/cold-import-memory.ts")],
		target: "browser",
		splitting: true,
		outdir: temp,
		write: false,
		external: ["cloudflare:workers", "node:*"],
	});
	assert.equal(build.success, true, build.logs.map(String).join("\n"));
	const modules = await Promise.all(
		build.outputs.map(async (output) => ({
			type: "ESModule",
			path: output.path,
			contents: await output.text(),
		})),
	);
	const entry = modules.findIndex((module) =>
		module.path.endsWith("/cold-import-memory.js"),
	);
	assert.notEqual(entry, -1);
	modules.unshift(...modules.splice(entry, 1));
	// Keep resident schemas and cold compilation within a finite heap budget.
	process.env.MINIFLARE_WORKERD_V8_FLAGS = "--max-old-space-size=128";
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			workers: [
				{
					name: "cold-import-memory",
					modules,
					modulesRoot: temp,
					compatibilityDate: "2026-05-14",
					compatibilityFlags: ["nodejs_compat"],
					workerLoaders: { LOADER: {} },
					bindings: { DO_NOT_TRACK: "1", MCP_URL: "https://fixture.invalid" },
					serviceBindings: {
						API_SERVICE: () =>
							new Response("Fixture API disabled", { status: 503 }),
					},
					outboundService: () =>
						new Response("Fixture network denied", { status: 599 }),
				},
			],
		}),
	);
	const worker = await runtime.getWorker("cold-import-memory");
	const seed = await worker.fetch("https://fixture.invalid/seed");
	assert.equal(seed.status, 200);
	assert.deepEqual(await seed.json(), { retainedSchemas: 5791 });
	const cold = await worker.fetch("https://fixture.invalid/build");
	assert.equal(cold.status, 200);
	assert.deepEqual(await cold.json(), {
		compactTools: 20422,
		retainedSchemas: 0,
		retainedSources: 0,
	});
	console.log(
		"Cold Code Mode build passed with a 128 MB old-space limit and 20,422 compact tools",
	);
} finally {
	await runtime?.dispose();
	rmSync(temp, { recursive: true, force: true });
}
