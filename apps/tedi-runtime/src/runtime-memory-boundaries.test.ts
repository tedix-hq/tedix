import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Keep the memory host and each concern small enough to review independently.
const modules = readdirSync(import.meta.dirname).filter((name) =>
	/^runtime-memory(?:-[\w-]+)?\.ts$/.test(name),
);
for (const name of modules) {
	const source = readFileSync(join(import.meta.dirname, name), "utf8");
	const lines = source.trimEnd().split("\n").length;
	assert.ok(lines <= 800, `${name} has ${lines} lines; split it by concern`);
	assert.doesNotMatch(
		source,
		/export\s+(?:type\s+)?(?:\*|\{)[^;]*\bfrom\s*["']/s,
		`${name} must import moved helpers directly rather than re-export them`,
	);
}
console.log(`runtime memory boundaries passed (${modules.length} modules)`);
