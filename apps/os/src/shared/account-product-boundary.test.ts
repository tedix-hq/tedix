import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

// The account/launcher vs OS-product separation defines three zones under
// src/: account/ (sign-in + first-org launcher), shared/ (zone-
// neutral session plumbing), and the OS product (everything else). The allowed
// edges are account -> shared, product -> shared, and shared -> neither. This
// test enforces the account <-> product half of that contract by scanning the
// source graph — the same lightweight technique as os-boundary.test.ts,
// with no new build dependency.

const OS_ROOT = /[\\/]apps[\\/]os$/.test(process.cwd())
	? process.cwd()
	: resolve(process.cwd(), "apps/os");

const sourceRoot = (relative: string): string => resolve(OS_ROOT, relative);

const SRC = sourceRoot("src");

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		return [".ts", ".tsx"].includes(extname(path)) && !path.includes(".test.")
			? [path]
			: [];
	});
}

/** Every `@/…` specifier a file references, via static or dynamic import. */
function aliasImports(source: string): string[] {
	const specifiers: string[] = [];
	const pattern = /(?:from\s*|import\s*\(\s*)["'](@\/[^"']+)["']/g;
	for (const match of source.matchAll(pattern)) {
		if (match[1]) specifiers.push(match[1]);
	}
	return specifiers;
}

function relSrc(path: string): string {
	return relative(SRC, path).split("\\").join("/");
}

// The zone-neutral surfaces account/ is allowed to build on. Anything else the
// account zone imports would be reaching into the OS product.
// Kumo is the zone-neutral design system — not "the OS product". Both the
// account zone and the shared zone build their UI on it, so it is named once
// here and referenced by both allowlists below rather than duplicated (a second
// copy would drift the moment a third zone is added).
const KUMO_UI_PREFIX = "@/components/kumo/";

const ACCOUNT_ALLOWED_IMPORT_PREFIXES = [
	"@/account/",
	"@/shared/",
	"@/lib/api",
	"@/lib/use-os-identity", // one consumer: cli-login-page.tsx
	"@/lib/use-document-title",
	"@/lib/theme", // one consumer: descope-sign-up-or-in-flow.tsx
	KUMO_UI_PREFIX,
	"@/components/list-skeleton", // one consumer: cli-login-page.tsx
];

describe("account / product zone boundary", () => {
	test("account does not import the OS product", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(join(SRC, "account"))) {
			for (const specifier of aliasImports(readFileSync(file, "utf8"))) {
				const allowed = ACCOUNT_ALLOWED_IMPORT_PREFIXES.some((prefix) =>
					specifier.startsWith(prefix),
				);
				if (!allowed) violations.push(`${relSrc(file)} -> ${specifier}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("the OS product does not import account", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(SRC)) {
			const rel = relSrc(file);
			// account/ is the zone itself; routes/ is the app composition root that
			// is expected to mount both zones' pages.
			if (rel.startsWith("account/") || rel.startsWith("routes/")) continue;
			for (const specifier of aliasImports(readFileSync(file, "utf8"))) {
				if (!specifier.startsWith("@/account/")) continue;
				violations.push(`${rel} -> ${specifier}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("shared imports neither account nor the OS product", () => {
		const violations: string[] = [];
		for (const file of sourceFiles(join(SRC, "shared"))) {
			for (const specifier of aliasImports(readFileSync(file, "utf8"))) {
				if (
					specifier.startsWith("@/account/") ||
					specifier.startsWith("@/shared/")
				) {
					continue;
				}
				// shared may only lean on zone-neutral infrastructure leaves and
				// the zone-neutral design system (the shared BYOS screens render
				// Kumo controls — the same carve-out account/ already has).
				const neutral =
					specifier.startsWith("@/auth/") ||
					specifier.startsWith("@/lib/os-identity-context") ||
					specifier.startsWith(KUMO_UI_PREFIX);
				if (!neutral) violations.push(`${relSrc(file)} -> ${specifier}`);
			}
		}
		expect(violations).toEqual([]);
	});
});
