import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

const FORBIDDEN = [
	/from\s+["'](cloudflare:|@cloudflare\/|wrangler|drizzle|@tedix\/|@modelcontextprotocol|\.\.\/\.\.\/apps)/,
	/\bDurableObject\b/,
	/\bD1Database\b/,
];

describe("agent-governance stays runtime-neutral", () => {
	it("imports nothing from a platform, database or application", () => {
		const dir = join(import.meta.dirname, ".");
		for (const file of readdirSync(dir).filter(
			(f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
		)) {
			const source = readFileSync(join(dir, file), "utf8");
			for (const pattern of FORBIDDEN) {
				expect(source, `${file} matches ${pattern}`).not.toMatch(pattern);
			}
		}
	});
});
