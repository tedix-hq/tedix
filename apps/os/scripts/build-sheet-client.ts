import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const osRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(
	osRoot,
	"../../packages/api-contract/src/assets/sheet-client.v3.generated.json",
);
const result = await build({
	absWorkingDir: osRoot,
	tsconfigRaw: {},
	entryPoints: ["src/gadgets/sheet-client-entry.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	charset: "utf8",
	minify: true,
	legalComments: "eof",
	write: false,
	metafile: true,
	outfile: "sheet-client.js",
});
for (const output of Object.values(result.metafile.outputs))
	if (output.imports.some((item) => item.external))
		throw new Error("Sheet client must have no external imports");
for (const input of Object.keys(result.metafile.inputs))
	if (
		/(?:node_modules\/|src\/components\/|src\/lib\/(?:api|format|workbook-formulas)\.)/.test(
			input,
		)
	)
		throw new Error(`Sheet client includes a host-only dependency: ${input}`);
const source = result.outputFiles[0]!.text;
const sha256 = createHash("sha256").update(source).digest("hex");
const generated = JSON.stringify({ sha256, source }, null, "\t") + "\n";
if (process.argv.includes("--check")) {
	if ((await readFile(destination, "utf8")) !== generated)
		throw new Error(
			"Sheet client is stale. Run bun apps/os/scripts/build-sheet-client.ts",
		);
} else await writeFile(destination, generated);
console.log(`Sheet client ${source.length} units; SHA-256 ${sha256}`);
