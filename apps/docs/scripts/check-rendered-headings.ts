import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "dist");

async function readPage(route: string): Promise<string> {
	return readFile(join(dist, route, "index.html"), "utf8");
}

function h1Text(html: string): string[] {
	return [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((match) =>
		(match[1] ?? "").replace(/<[^>]+>/g, "").trim(),
	);
}

const standard = h1Text(await readPage("getting-started"));
if (standard.length !== 1 || standard[0] !== "Getting started") {
	throw new Error(
		`Standard page must render one layout title; received ${JSON.stringify(standard)}`,
	);
}

const custom = h1Text(await readPage("custom-layout-regression"));
if (custom.length !== 1 || custom[0] !== "Authored custom title") {
	throw new Error(
		`Custom page must preserve its authored title; received ${JSON.stringify(custom)}`,
	);
}

console.log(
	"rendered heading contract ok: standard and custom pages have one owned H1",
);
