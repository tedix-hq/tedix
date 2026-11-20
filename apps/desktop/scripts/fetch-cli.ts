/**
 * Puts the Tedix command-line tool where the app build picks it up:
 * `cli/<arch>/tedix`. Run it once per processor type before building.
 *
 *   bun scripts/fetch-cli.ts arm64            the latest published version
 *   bun scripts/fetch-cli.ts x64 0.29.0       one exact version
 *   bun scripts/fetch-cli.ts arm64 --file p   a binary built from source
 *
 * A download comes from downloads.tedix.dev and is refused unless its
 * SHA-256 is the one in that release's SHA256SUMS.
 */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://downloads.tedix.dev";
const [arch, ...rest] = process.argv.slice(2);
if (arch !== "arm64" && arch !== "x64")
	throw new Error(
		"Usage: bun scripts/fetch-cli.ts arm64|x64 [version | --file path]",
	);

const folder = join(import.meta.dir, "..", "cli", arch);
const target = join(folder, "tedix");
mkdirSync(folder, { recursive: true });

async function get(path: string): Promise<Response> {
	const response = await fetch(`${BASE}/${path}`, { redirect: "error" });
	if (!response.ok) throw new Error(`${BASE}/${path}: HTTP ${response.status}`);
	return response;
}

if (rest[0] === "--file") {
	if (!rest[1]) throw new Error("--file needs a path");
	copyFileSync(rest[1], target);
	console.log(`Copied ${rest[1]} to ${target}`);
} else {
	const version =
		rest[0] ??
		String(
			((await (await get("latest.json")).json()) as { version?: unknown })
				.version,
		);
	if (!/^\d+\.\d+\.\d+$/.test(version))
		throw new Error(`Not a version: ${version}`);
	const asset = `tedix-${version}-darwin-${arch}`;
	const sums = await (await get(`releases/${version}/SHA256SUMS`)).text();
	const expected = sums
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([, name]) => name === asset || name === `*${asset}`);
	if (expected.length !== 1 || !/^[0-9a-f]{64}$/.test(expected[0]![0]!))
		throw new Error(`Expected exactly one checksum for ${asset}`);
	const bytes = Buffer.from(
		await (await get(`releases/${version}/${asset}`)).arrayBuffer(),
	);
	const actual = createHash("sha256").update(bytes).digest("hex");
	if (actual !== expected[0]![0])
		throw new Error(
			`${asset} does not match its checksum; nothing was written`,
		);
	writeFileSync(target, bytes);
	console.log(`Fetched and checked ${asset} to ${target}`);
}
chmodSync(target, 0o755);
