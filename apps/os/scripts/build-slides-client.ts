import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const osRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destination = resolve(
	osRoot,
	"../../packages/api-contract/src/assets/slides-client.v2.generated.json",
);
const result = await build({
	absWorkingDir: osRoot,
	alias: { "@": resolve(osRoot, "src") },
	tsconfigRaw: {},
	entryPoints: ["src/gadgets/slides-client-entry.ts"],
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	charset: "utf8",
	minify: true,
	legalComments: "eof",
	define: { "process.env.NODE_ENV": '"production"' },
	write: false,
	metafile: true,
	outfile: "slides-client.js",
});
for (const output of Object.values(result.metafile.outputs))
	if (output.imports.some((item) => item.external))
		throw new Error("Slides client must have no external imports");
for (const input of Object.keys(result.metafile.inputs)) {
	if (
		/(?:react-dom|node_modules\/react\/|src\/lib\/(?:api|os-query-options|theme)\.|src\/router)/.test(
			input,
		)
	)
		throw new Error(`Slides client includes a host-only module: ${input}`);
}
const packages = new Map<string, string>();
for (const output of Object.values(result.metafile.outputs)) {
	for (const [input, contribution] of Object.entries(output.inputs)) {
		if (!contribution.bytesInOutput || !input.includes("node_modules/"))
			continue;
		let directory = dirname(resolve(osRoot, input));
		while (directory !== dirname(directory)) {
			try {
				const metadata = JSON.parse(
					await readFile(resolve(directory, "package.json"), "utf8"),
				);
				if (metadata.name && metadata.version) {
					packages.set(directory, `${metadata.name}@${metadata.version}`);
					break;
				}
			} catch {
				/* Continue to the package root. */
			}
			directory = dirname(directory);
		}
	}
}
const notices = new Map<string, string[]>();
for (const [directory, name] of packages) {
	const filenames = (await readdir(directory))
		.filter((filename) =>
			/^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(filename),
		)
		.sort();
	if (!filenames.length) throw new Error(`Missing license notice for ${name}`);
	for (const filename of filenames) {
		const notice = (
			await readFile(resolve(directory, filename), "utf8")
		).trim();
		if (notice.includes("*/"))
			throw new Error(`Unsafe license comment for ${name}`);
		notices.set(notice, [...(notices.get(notice) ?? []), name]);
	}
}
const legal = [...notices]
	.map(
		([notice, names]) =>
			`${[...new Set(names)].sort().join(", ")}\n\n${notice}`,
	)
	.sort()
	.join("\n\n");
const source = `${result.outputFiles[0]!.text}\n/*! Third-party notices\n${legal}\n*/\n`;

if (source.length > 450_000)
	throw new Error(`Slides client exceeds source budget: ${source.length}`);
const sha256 = createHash("sha256").update(source).digest("hex");
const generated = JSON.stringify({ sha256, source }, null, "\t") + "\n";
if (process.argv.includes("--check")) {
	if ((await readFile(destination, "utf8")) !== generated)
		throw new Error(
			"Slides client is stale. Run bun run --cwd apps/os slides:generate",
		);
} else await writeFile(destination, generated);
console.log(`Slides client ${source.length} units; SHA-256 ${sha256}`);
