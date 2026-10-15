import { readFile } from "node:fs/promises";
import { SUPPORTED_FORMULAS } from "hot-formula-parser";
import {
	WORKBOOK_CUSTOM_FUNCTIONS,
	WORKBOOK_LAZY_FUNCTIONS,
} from "../src/lib/workbook-custom-functions";

const path = process.argv[2];
if (!path)
	throw new Error(
		"Usage: bun apps/os/scripts/diff-sheet-functions.ts <workspace-sheets/files/client.ts>",
	);
const source = await readFile(path, "utf8");
const generated = Array.from(
	source.matchAll(/for \(const fn of (\[[^\]]+\]) as const\) F\[fn\]/g),
	(match) =>
		Array.from(match[1]!.matchAll(/"([A-Z][A-Z0-9_.]*)"/g), (item) => item[1]!),
).flat();
const reference = [
	...new Set([
		...generated,
		...Array.from(
			source.matchAll(/F\.([A-Z][A-Z0-9_.]*)\s*=/g),
			(match) => match[1]!,
		),
		...Array.from(
			source.matchAll(/F\["([A-Z][A-Z0-9_.]*)"\]\s*=/g),
			(match) => match[1]!,
		),
	]),
].sort();
const before = reference.filter((name) => !SUPPORTED_FORMULAS.includes(name));
const supported = new Set([
	...SUPPORTED_FORMULAS,
	...Object.keys(WORKBOOK_CUSTOM_FUNCTIONS),
	...WORKBOOK_LAZY_FUNCTIONS,
]);
const after = reference.filter((name) => !supported.has(name));
console.log(`Reference functions: ${reference.length}`);
console.log(`Missing before (${before.length}): ${before.join(", ")}`);
console.log(`Missing after (${after.length}): ${after.join(", ") || "none"}`);
if (after.length) process.exitCode = 1;
