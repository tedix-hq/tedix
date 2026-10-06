import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { readWorkerSourceConfig } from "./worker-source-config";

const temporary: string[] = [];
function fixture(name: string, text: string): string {
	const root = mkdtempSync(join(tmpdir(), "tedix-worker-source-"));
	temporary.push(root);
	const path = join(root, name);
	writeFileSync(path, text);
	return path;
}
afterEach(() => {
	for (const path of temporary.splice(0)) rmSync(path, { recursive: true });
});

test("keeps authored Wrangler JSONC for the existing overlay parser", async () => {
	const text = '{ // authored comment\n "main": "src/index.ts" }';
	expect(await readWorkerSourceConfig(fixture("wrangler.jsonc", text))).toBe(
		text,
	);
});

test("evaluates cf config with production deployment context", async () => {
	const path = fixture(
		"cloudflare.config.ts",
		`export default ({mode,isPreview}) => ({worker:{name:mode,entrypoint:'src/index.ts',compatibilityDate:'2026-05-14',env:{CONTEXT:{type:'text',value:String(isPreview)}}}});`,
	);
	const rendered = JSON.parse(await readWorkerSourceConfig(path));
	expect(rendered.name).toBe("production");
	expect(rendered.main).toBe("src/index.ts");
	expect(rendered.vars.CONTEXT).toBe("false");
});

test("rejects missing, malformed and unsupported configuration inputs", async () => {
	await expect(
		readWorkerSourceConfig("/missing/cloudflare.config.ts"),
	).rejects.toThrow();
	await expect(
		readWorkerSourceConfig(
			fixture("cloudflare.config.ts", "export default {};"),
		),
	).rejects.toThrow("Invalid Cloudflare Worker configuration");
	await expect(
		readWorkerSourceConfig(
			fixture("arbitrary.ts", "throw new Error('must not execute');"),
		),
	).rejects.toThrow("Unsupported Worker source configuration");
});

test.each(["mcp", "tedi", "skill-runtime"])(
	"converts the actual %s config using the provider's converter",
	async (app) => {
		const path = resolve(
			import.meta.dir,
			"../../..",
			"apps",
			app,
			"cloudflare.config.ts",
		);
		const rendered = JSON.parse(await readWorkerSourceConfig(path));
		expect(rendered.main).toBe("src/index.ts");
		expect(rendered.compatibility_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(rendered.d1_databases[0].binding).toBe("DB");
	},
);
