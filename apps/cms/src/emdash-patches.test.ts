import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

// Each starter template is a standalone install (its own bun.lock) that is
// also copied into the Site Builder sandbox, so it carries its own copy of the
// root Emdash patches. The root `patches/` copy is the source.
const read = (path: string) =>
	readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

const sections = (patch: string) => patch.split(/^(?=diff --git )/m).slice(1);

describe("starter Emdash patches", () => {
	for (const name of [
		"@emdash-cms/cloudflare@1.1.0.patch",
		"emdash@1.1.0.patch",
	]) {
		it(`tedix starter copies patches/${name} byte for byte`, () => {
			expect(read(`apps/cms/templates/tedix/patches/${name}`)).toBe(
				read(`patches/${name}`),
			);
		});
	}

	it("marketing starter copies the cloudflare patch byte for byte", () => {
		const name = "@emdash-cms/cloudflare@1.1.0.patch";
		expect(read(`apps/cms/templates/marketing/patches/${name}`)).toBe(
			read(`patches/${name}`),
		);
	});

	// Marketing adds one hunk of its own: it drops Emdash's deferred
	// `prefetchLayoutData()` after anonymous HTML responses (6f4fd316c4). Keep it
	// until a measurement shows the prefetch is neutral for the marketing
	// bundle. Every root hunk must still be present unchanged.
	it("marketing starter emdash patch contains every root hunk", () => {
		const marketing = new Set(
			sections(read("apps/cms/templates/marketing/patches/emdash@1.1.0.patch")),
		);
		for (const section of sections(read("patches/emdash@1.1.0.patch"))) {
			expect(marketing.has(section)).toBe(true);
		}
	});
});
