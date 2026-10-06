#!/usr/bin/env bun

/**
 * Worker Loader sandbox-manifest lint. Every Loader site (a `mainModule`+`modules`
 * manifest, `LOADER.get/load(`, `new DynamicWorkerExecutor(`) must set
 * `globalOutbound` explicitly (absence inherits the parent's network), set
 * `disallow_importable_env` for model-authored code, and be listed in
 * ALLOWLIST_ENTRIES with a reason. `--strict` exits 1 on any error.
 */

import { type Dirent, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Roots scanned for Loader manifest construction. */
const SCAN_ROOTS = ["apps", "packages"] as const;

const SOURCE_FILE_RE = /\.(?:[cm]?ts|tsx)$/;

const TEST_FILE_RE = /\.(?:test|spec)\.|(?:^|\/)(?:__tests__|test|tests)\//;

/**
 * Generated Workers type declarations describe the manifest interface itself
 * (`mainModule: string;` beside `modules`), so every app's copy would otherwise
 * report as an unapproved manifest site.
 */
const GENERATED_FILE_RE = /(?:^|\/)worker-configuration\.d\.ts$|\.d\.ts$/;

const SKIPPED_DIRS = new Set([
	"node_modules",
	"dist",
	"build",
	".wrangler",
	".astro",
	".vercel",
	"coverage",
	"templates",
]);

type CheckId = "globalOutbound" | "disallowImportableEnv";

type DetectorId = "raw-manifest" | "loader-call" | "executor";

interface AllowlistEntry {
	/** Repo-relative path of the file permitted to construct a manifest. */
	readonly file: string;
	/**
	 * Why this code is allowed to load a Worker. Required: adding a site is a
	 * deliberate act that has to be justified in the diff.
	 */
	readonly reason: string;
	/**
	 * True when the sandbox executes code a model wrote. Gates the
	 * `disallow_importable_env` assertion.
	 */
	readonly runsModelAuthoredCode: boolean;
}

/**
 * The complete set of locations permitted to construct a Worker Loader
 * manifest. Anything else is an error, in both default and strict mode.
 */
const ALLOWLIST_ENTRIES: readonly AllowlistEntry[] = [
	{
		file: "packages/tedi-codemode-core/src/register-codemode-tools.ts",
		reason:
			"Shared Code Mode registration builds the DynamicWorkerExecutor that every tedi surface reuses, so its sandbox policy is the default the other Code Mode sites inherit.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/tedi-runtime/src/durable-codemode.ts",
		reason:
			"The durable Code Mode runtime owns a per-DO executor whose lifetime and execution ceiling are bound to the Durable Object, which the shared registration path cannot express.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/mcp/src/mcp/codemode.ts",
		reason:
			"The MCP edge's Code Mode transport resolves per-tenant timeout, extra modules, and namespace overrides from D1 mcpConfig before constructing the sandbox.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/mcp/src/mcp/handler.ts",
		reason:
			"The MCP code transport executes stored per-tool JavaScript standalone (no tool namespaces), which is a distinct sandbox shape from Code Mode's provider-bearing executor.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/skill-runtime/src/runner.ts",
		reason:
			"The tenant skill runner is the only site with a conditional network opt-in: manifest.network selects between full isolation and the platform OutboundProxy that injects provider credentials loader-side.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/cms-runtime/src/tenant-plugin-executor.ts",
		reason:
			"The CMS parent loads one tenant plugin into an isolated Worker with a tenant-scoped DO bridge and explicit capability grants; it cannot share the Astro bundle Loader manifest.",
		runsModelAuthoredCode: true,
	},
	{
		file: "apps/cms-runtime/src/index.ts",
		reason:
			"The CMS runtime loads a per-tenant Astro bundle from R2 with tenant-scoped EmDashDB/R2/session entrypoint stubs built from ctx.exports, which no shared constructor signature covers.",
		runsModelAuthoredCode: false,
	},
];

const ALLOWLIST = new Map(
	ALLOWLIST_ENTRIES.map((entry) => [entry.file, entry] as const),
);

interface Finding {
	readonly severity: "error" | "warning";
	readonly file: string;
	readonly message: string;
}

interface Detection {
	readonly file: string;
	readonly line: number;
	readonly detector: DetectorId;
	/** Offsets of the construct's span in the masked source. */
	readonly start: number;
	readonly end: number;
	/** Masked span text — comments and string bodies are blanked. */
	readonly span: string;
}

/**
 * Blank out comments and the CONTENTS of string/template literals, preserving
 * every offset and newline. Two things depend on this:
 *
 *   - Detection cannot fire on generated code carried inside a template literal
 *     (`DISPATCH_SHIM` and friends emit Worker source as data).
 *   - The `globalOutbound` presence assertion cannot be satisfied by a COMMENT
 *     that merely mentions the field. `apps/mcp/src/mcp/handler.ts` documents
 *     `globalOutbound: null` in its module docblock; only real syntax counts.
 */
function maskSource(source: string, blankStringBodies: boolean): string {
	const out = source.split("");
	const blank = (from: number, to: number): void => {
		for (let i = from; i < to && i < out.length; i += 1) {
			if (out[i] !== "\n") out[i] = " ";
		}
	};
	const blankBody = (from: number, to: number): void => {
		if (blankStringBodies) blank(from, to);
	};

	/*
	 * A mode STACK, not a flag. Template literals nest arbitrarily through
	 * `${}` interpolations, and a scanner that merely toggles on every backtick
	 * mis-reads a template's CLOSING backtick as an opening one and inverts the
	 * mask for the whole rest of the file. That is not a corner case here:
	 * `apps/skill-runtime/src/runner.ts` and `apps/mcp/src/mcp/handler.ts` both
	 * embed generated Worker source in interpolated templates immediately
	 * around their manifest, so an inverted mask silently blinds the lint on
	 * exactly the files it exists to check.
	 */
	type Frame =
		| { readonly kind: "template" }
		| { kind: "code"; readonly interpolation: boolean; depth: number };
	const stack: Frame[] = [{ kind: "code", interpolation: false, depth: 0 }];

	let i = 0;
	while (i < source.length) {
		const top = stack[stack.length - 1];
		const char = source[i];
		const next = source[i + 1];

		if (top?.kind === "template") {
			if (char === "\\") {
				blankBody(i, i + 2);
				i += 2;
				continue;
			}
			if (char === "`") {
				stack.pop();
				i += 1;
				continue;
			}
			if (char === "$" && next === "{") {
				stack.push({ kind: "code", interpolation: true, depth: 0 });
				i += 2;
				continue;
			}
			blankBody(i, i + 1);
			i += 1;
			continue;
		}
		if (!top || top.kind !== "code") break;

		if (char === "/" && next === "/") {
			let end = source.indexOf("\n", i);
			if (end === -1) end = source.length;
			blank(i, end);
			i = end;
			continue;
		}
		if (char === "/" && next === "*") {
			const close = source.indexOf("*/", i + 2);
			const end = close === -1 ? source.length : close + 2;
			blank(i, end);
			i = end;
			continue;
		}
		if (char === '"' || char === "'") {
			let j = i + 1;
			while (j < source.length) {
				if (source[j] === "\\") {
					j += 2;
					continue;
				}
				if (source[j] === char || source[j] === "\n") break;
				j += 1;
			}
			blankBody(i + 1, j);
			i = j + 1;
			continue;
		}
		if (char === "`") {
			stack.push({ kind: "template" });
			i += 1;
			continue;
		}
		if (char === "{") {
			top.depth += 1;
			i += 1;
			continue;
		}
		if (char === "}") {
			if (top.depth === 0 && top.interpolation) stack.pop();
			else top.depth -= 1;
			i += 1;
			continue;
		}
		i += 1;
	}
	return out.join("");
}

/**
 * Structural view: comments AND string/template bodies blanked. Used for
 * detection and for the `globalOutbound` presence assertion, so neither can be
 * satisfied by prose or by generated Worker source carried as data.
 */
function maskLiterals(source: string): string {
	return maskSource(source, true);
}

/**
 * Comments-only view: string bodies survive. Compatibility flags ARE string
 * literals (`["nodejs_als", ..., "disallow_importable_env"]`), so the flag
 * assertion has to read them — while a comment merely discussing the flag still
 * must not count as setting it.
 */
function maskComments(source: string): string {
	return maskSource(source, false);
}

/**
 * True only when executable syntax in one manifest/executor construct applies
 * the model-code isolation flag, directly, through the shared Loader guard, or
 * through an exact referenced array constant whose declaration contains it.
 * An unrelated occurrence elsewhere in the file cannot satisfy the check.
 */
export function hasModelAuthoredCodeIsolation(
	constructSource: string,
	containingSource = constructSource,
): boolean {
	const constructSyntax = maskComments(constructSource);
	if (
		/\bdisallow_importable_env\b/.test(constructSyntax) ||
		/\bwithModelAuthoredCodeIsolation\s*\(/.test(constructSyntax)
	) {
		return true;
	}

	const referencedConstants = constructSyntax.matchAll(
		/\bcompatibilityFlags\s*:\s*([A-Za-z_$][\w$]*)/g,
	);
	const structuralSource = maskLiterals(containingSource);
	const sourceWithoutComments = maskComments(containingSource);
	for (const match of referencedConstants) {
		const identifier = match[1];
		if (!identifier) continue;
		const declaration = new RegExp(
			`\\b(?:export\\s+)?const\\s+${identifier}\\s*=\\s*\\[`,
		).exec(structuralSource);
		if (!declaration) continue;
		const openIndex = declaration.index + declaration[0].lastIndexOf("[");
		const array = balancedSpan(structuralSource, openIndex, "[", "]");
		if (
			array &&
			/\bdisallow_importable_env\b/.test(
				sourceWithoutComments.slice(array.start, array.end),
			)
		) {
			return true;
		}
	}
	return false;
}

function lineOf(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < source.length; i += 1) {
		if (source[i] === "\n") line += 1;
	}
	return line;
}

/** Span of the balanced bracket group opened at `openIndex`. */
function balancedSpan(
	masked: string,
	openIndex: number,
	open: string,
	close: string,
): { start: number; end: number } | null {
	let depth = 0;
	for (let i = openIndex; i < masked.length; i += 1) {
		if (masked[i] === open) depth += 1;
		else if (masked[i] === close) {
			depth -= 1;
			if (depth === 0) return { start: openIndex, end: i + 1 };
		}
	}
	return null;
}

/** Innermost object literal containing `index`, or null. */
function enclosingObjectLiteral(
	masked: string,
	index: number,
): { start: number; end: number } | null {
	let depth = 0;
	for (let i = index; i >= 0; i -= 1) {
		if (masked[i] === "}") depth += 1;
		else if (masked[i] === "{") {
			if (depth === 0) return balancedSpan(masked, i, "{", "}");
			depth -= 1;
		}
	}
	return null;
}

function detect(file: string, masked: string): Detection[] {
	const detections: Detection[] = [];
	const push = (
		detector: DetectorId,
		span: { start: number; end: number },
	): void => {
		if (
			detections.some(
				(d) =>
					d.detector === detector &&
					d.start === span.start &&
					d.end === span.end,
			)
		) {
			return;
		}
		detections.push({
			file,
			line: lineOf(masked, span.start),
			detector,
			start: span.start,
			end: span.end,
			span: masked.slice(span.start, span.end),
		});
	};

	/*
	 * 1. Raw manifest: an object literal carrying `mainModule` together with
	 * `modules` and a compatibility field.
	 *
	 * `modules` is matched in both longhand and SHORTHAND form (`modules,`) —
	 * `apps/cms-runtime` writes the shorthand, so a `:`-only pattern misses the
	 * one site that actually has the bug this lint was built for.
	 *
	 * The compatibility field is what separates a manifest from the many
	 * `mainModule`/`modules` pairs that are not sandboxes: TypeScript type
	 * declarations (`packages/provisioning/src/cms.ts`'s TenantBundleResult) and
	 * bundler REPORT records that describe a bundle without ever loading it.
	 * This is a precision fix, not a relaxation: `compatibilityDate` is
	 * REQUIRED by the Worker Loader, so a literal without one cannot be a live
	 * sandbox, and the loader-call detector below still fires unconditionally
	 * on every `LOADER.get`/`load` regardless of how its manifest was built.
	 */
	for (const match of masked.matchAll(/\bmainModule\s*[:,]/g)) {
		const literal = enclosingObjectLiteral(masked, match.index);
		if (!literal) continue;
		const body = masked.slice(literal.start, literal.end);
		if (!/\bmodules\s*[:,}]/.test(body)) continue;
		if (!/\bcompatibility(?:Date|Flags)\s*[:,]/.test(body)) continue;
		push("raw-manifest", literal);
	}

	// 2. Any Worker Loader binding call.
	for (const match of masked.matchAll(/\bLOADER\s*\.\s*(?:get|load)\s*\(/g)) {
		const paren = masked.indexOf("(", match.index);
		const span = balancedSpan(masked, paren, "(", ")");
		if (span) push("loader-call", { start: match.index, end: span.end });
	}

	// 3. Codemode executor: builds the manifest internally from these options.
	for (const match of masked.matchAll(/\bnew\s+DynamicWorkerExecutor\s*\(/g)) {
		const paren = masked.indexOf("(", match.index);
		const span = balancedSpan(masked, paren, "(", ")");
		if (span) push("executor", { start: match.index, end: span.end });
	}

	return detections;
}

function collectSourceFiles(dir: string, out: string[]): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRS.has(entry.name)) continue;
			collectSourceFiles(path, out);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!SOURCE_FILE_RE.test(entry.name)) continue;
		if (GENERATED_FILE_RE.test(path)) continue;
		if (TEST_FILE_RE.test(path)) continue;
		out.push(path);
	}
}

const DETECTOR_LABEL: Record<DetectorId, string> = {
	"raw-manifest": "manifest object literal (mainModule + modules)",
	"loader-call": "LOADER.get()/LOADER.load() call",
	executor: "new DynamicWorkerExecutor() options",
};

function main(): void {
	const strict = process.argv.includes("--strict");
	const findings: Finding[] = [];

	const files: string[] = [];
	for (const root of SCAN_ROOTS) {
		const dir = join(REPO_ROOT, root);
		try {
			if (statSync(dir).isDirectory()) collectSourceFiles(dir, files);
		} catch {
			// A missing scan root is not this lint's failure to report.
		}
	}
	files.sort();

	const detectionsByFile = new Map<string, Detection[]>();
	for (const path of files) {
		const rel = relative(REPO_ROOT, path);
		const masked = maskLiterals(readFileSync(path, "utf8"));
		const detections = detect(rel, masked);
		if (detections.length > 0) detectionsByFile.set(rel, detections);
	}

	// Gaps observed on this run, keyed `<file>::<check>`.
	const observedGaps = new Map<string, string>();
	const recordGap = (file: string, check: CheckId, detail: string): void => {
		observedGaps.set(`${file}::${check}`, detail);
	};

	for (const [file, detections] of [...detectionsByFile].sort()) {
		const entry = ALLOWLIST.get(file);
		if (!entry) {
			const shapes = [...new Set(detections.map((d) => d.detector))]
				.map((d) => DETECTOR_LABEL[d])
				.join(", ");
			findings.push({
				severity: "error",
				file,
				message:
					`constructs a Worker Loader sandbox manifest (${shapes}) at line(s) ${detections
						.map((d) => d.line)
						.join(", ")} but is not an approved Loader site. ` +
					`Every security property of a loaded Worker is a field of that literal, and the failure mode is omission — so a new site is a deliberate act, not a default. ` +
					`Fix EITHER by routing this through an existing approved site, OR, if this genuinely needs its own sandbox, add it to ALLOWLIST_ENTRIES in scripts/lint-loader-sandbox.ts with a real reason:\n` +
					`    { file: "${file}", reason: "<why this code must load a Worker>", runsModelAuthoredCode: <true|false> }\n` +
					`  then set "globalOutbound" explicitly on the manifest (null for isolation, a Fetcher for mediated egress) and, if it runs model-authored code, add "disallow_importable_env" to its compatibility flags.`,
			});
			continue;
		}

		// A `LOADER.get()` whose argument span CONTAINS a raw manifest literal
		// is asserted through that literal, not twice. A loader call with no
		// visible manifest is asserted on its own span — that case is exactly
		// where the policy could be hiding somewhere unreviewable.
		const manifests = detections.filter((d) => d.detector === "raw-manifest");
		const assertable = detections.filter((d) => {
			if (d.detector !== "loader-call") return true;
			return !manifests.some((m) => m.start > d.start && m.end <= d.end);
		});

		for (const detection of assertable) {
			if (/\bglobalOutbound\s*:/.test(detection.span)) continue;
			recordGap(
				file,
				"globalOutbound",
				`${DETECTOR_LABEL[detection.detector]} at line ${detection.line} omits "globalOutbound"`,
			);
		}

		if (entry.runsModelAuthoredCode) {
			const source = readFileSync(join(REPO_ROOT, file), "utf8");
			for (const detection of assertable) {
				if (
					hasModelAuthoredCodeIsolation(
						source.slice(detection.start, detection.end),
						source,
					)
				) {
					continue;
				}
				recordGap(
					file,
					"disallowImportableEnv",
					`${DETECTOR_LABEL[detection.detector]} at line ${detection.line} runs model-authored code but does not apply "disallow_importable_env"`,
				);
			}
		}
	}

	// Allowlist hygiene: an entry that no longer detects is stale and must go,
	// or the allowlist quietly over-permits after a refactor.
	for (const entry of ALLOWLIST_ENTRIES) {
		if (detectionsByFile.has(entry.file)) continue;
		findings.push({
			severity: "error",
			file: entry.file,
			message:
				`is allowlisted as a Worker Loader site but no manifest construction was detected there. ` +
				`Either the file moved or the site is gone. Fix in scripts/lint-loader-sandbox.ts: delete its ALLOWLIST_ENTRIES entry (or update "file" to the new path).`,
		});
	}

	for (const [key, detail] of [...observedGaps].sort()) {
		const [file = key, check = ""] = key.split("::");
		findings.push({
			severity: "error",
			file,
			message:
				`Worker Loader sandbox gap: ${detail}. ` +
				(check === "globalOutbound"
					? `Absence is the bug, not the value: in the Loader API an omitted "globalOutbound" means INHERIT the parent Worker's network, which is the most permissive of the three options and the one you get by forgetting. Fix at the call site:\n` +
						`    globalOutbound: null,            // fully isolated\n` +
						`    globalOutbound: <fetcherStub>,   // mediated egress through a platform proxy`
					: `Model-authored code inside the sandbox can otherwise reach bindings ambiently via import { env } from "cloudflare:workers", without the manifest ever handing them over. Fix by adding the flag to this site's compatibility flags:\n` +
						`    compatibilityFlags: ["nodejs_compat", "disallow_importable_env"]`),
		});
	}

	for (const finding of findings) {
		const label = finding.severity === "error" ? "ERROR" : "WARN";
		console.error(`[${label}] ${finding.file}: ${finding.message}`);
	}

	const errors = findings.filter(({ severity }) => severity === "error");
	const warnings = findings.filter(({ severity }) => severity === "warning");

	console.log(
		`loader sandbox lint: ${files.length} source file(s) scanned, ${ALLOWLIST_ENTRIES.length} approved site(s), ` +
			`${observedGaps.size} gap(s), ${errors.length} error(s), ${warnings.length} warning(s)${
				strict ? " [strict]" : ""
			}`,
	);

	if (strict && errors.length > 0) process.exit(1);
	if (!strict && errors.length > 0) {
		console.log(
			"note: errors are non-fatal without --strict; lint:repo runs the strict form.",
		);
	}
}

if (import.meta.main) {
	main();
}
