#!/usr/bin/env bun

/**
 * Dependency-license allow-list, run after `bun install`.
 *
 * 1. Every installed package declares a license compatible with shipping the
 *    product under AGPL-3.0-only.
 * 2. The runtime closure of every Apache-2.0 or MIT workspace stays free of
 *    strong copyleft, so those packages remain usable under their own license.
 * 3. Every dependency patch is named in THIRD_PARTY_NOTICES.md.
 *
 * A new license string fails until someone decides it belongs in a set below.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { checkPublicSurface } from "./public-surface";

/** Permissive, plus weak (file- or library-level) copyleft. */
const PERMISSIVE = new Set(
	"0BSD AFL-2.1 Apache-2.0 BlueOak-1.0.0 BSD-2-Clause BSD-3-Clause CC-BY-4.0 CC0-1.0 ISC MIT MIT-0 MPL-2.0 OFL-1.1 Python-2.0 Unlicense WTFPL Zlib LGPL-3.0 LGPL-3.0-only LGPL-3.0-or-later".split(
		" ",
	),
);
/** Strong copyleft: allowed only where AGPL-3.0-only product code is the consumer. */
const COPYLEFT = new Set(
	"GPL-2.0-or-later GPL-3.0-only GPL-3.0-or-later AGPL-3.0-only AGPL-3.0-or-later".split(
		" ",
	),
);
/** Reviewed packages whose manifest carries no SPDX expression. */
const REVIEWED: Record<string, string> = {
	"@fingerprintjs/fingerprintjs-pro":
		"external-service SDK pulled only through the Descope identity prerequisite; governed by Fingerprint and Descope terms",
};
/** Reviewed copyleft packages inside an Apache-2.0 or MIT runtime closure. */
const REVIEWED_IN_ECOSYSTEM: Record<string, string> = {
	"@wordpress/block-serialization-default-parser":
		"reached only through upstream emdash's WordPress import (@emdash-cms/gutenberg-to-portable-text), as in emdash's own MIT templates; Tedix code does not import it. Owner accepted 2026-10-08, matching upstream emdash",
};

type Manifest = {
	name?: string;
	version?: string;
	license?: unknown;
	licenses?: Array<{ type?: string }>;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
};
const read = (dir: string): Manifest =>
	JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
const licenseOf = (m: Manifest): string =>
	typeof m.license === "string"
		? m.license
		: ((m.license as { type?: string })?.type ??
			m.licenses?.map((l) => l.type).join(" OR ") ??
			"");

/** An SPDX expression passes when one OR-alternative has every AND-term allowed. */
export function allowed(
	expression: string,
	permitted: (id: string) => boolean,
): boolean {
	return expression
		.replace(/[()]/g, "")
		.split(/\s+OR\s+/)
		.some((alt) => alt.split(/\s+AND\s+/).every((id) => permitted(id.trim())));
}

const root = resolve(import.meta.dirname, "../..");
const errors: string[] = [];
const store = join(root, "node_modules/.bun");
for (const entry of existsSync(store) ? readdirSync(store) : []) {
	const modules = join(store, entry, "node_modules");
	for (const top of existsSync(modules) ? readdirSync(modules) : []) {
		for (const dir of top.startsWith("@")
			? readdirSync(join(modules, top)).map((n) => join(modules, top, n))
			: [join(modules, top)]) {
			if (!existsSync(join(dir, "package.json")) || realpathSync(dir) !== dir)
				continue;
			const m = read(dir);
			const license = licenseOf(m);
			if (m.name && REVIEWED[m.name]) continue;
			if (!allowed(license, (id) => PERMISSIVE.has(id) || COPYLEFT.has(id)))
				errors.push(
					`${m.name}@${m.version}: license "${license || "none"}" is not on the allow-list`,
				);
		}
	}
}

function resolveFrom(from: string, name: string): string | undefined {
	for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json")))
			return realpathSync(candidate);
	}
}
for (const workspace of checkPublicSurface(root).resolved) {
	if (workspace.licenseClass === "agpl-product") continue;
	const queue = [resolve(root, workspace.path)];
	const seen = new Set(queue);
	while (queue.length > 0) {
		const dir = queue.pop() as string;
		const m = read(dir);
		for (const name of Object.keys({
			...m.dependencies,
			...m.optionalDependencies,
			...m.peerDependencies,
		})) {
			const target = resolveFrom(dir, name);
			if (!target || seen.has(target) || !target.includes("/node_modules/"))
				continue;
			seen.add(target);
			const dep = read(target);
			if (
				!REVIEWED[name] &&
				!REVIEWED_IN_ECOSYSTEM[name] &&
				!allowed(licenseOf(dep), (id) => PERMISSIVE.has(id))
			)
				errors.push(
					`${workspace.path} (${workspace.licenseClass}) reaches ${name}@${dep.version} under "${licenseOf(dep)}" at runtime`,
				);
			queue.push(target);
		}
	}
}

const notices = readFileSync(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const patches = Bun.spawnSync(["git", "ls-files", "*patches/*.patch"], {
	cwd: root,
})
	.stdout.toString()
	.split("\n")
	.filter(Boolean);
for (const patch of patches) {
	const [, name, version] = /patches\/(.+)@([^@/]+)\.patch$/.exec(patch) ?? [];
	if (!notices.includes(`patch to ${name} ${version}`))
		errors.push(
			`${patch}: THIRD_PARTY_NOTICES.md has no "patch to ${name} ${version}" notice`,
		);
}

for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.log(`dependency licenses ok; ${patches.length} patches noticed`);
