#!/usr/bin/env bun

/**
 * Output kind boundary (`bun scripts/lint-output-kinds.ts`, part of `lint:repo`).
 *
 * Tedix owns a small native data layer (document, sheet, presentation, video);
 * every other view is a workspace app bound to a slot (Decision 134d3667). So a
 * new member of `OsOutputKindSchema`, or a new first-party Output editor in
 * Tedix OS (a route under `apps/os/src/routes` naming outputs, or an
 * `apps/os/src/components/output-editor*.tsx` module), must be listed below
 * with the decision that allowed it. Removing one needs no entry.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Decision Work Item id prefix: eight lowercase hex characters. */
const DECISION_RE = /^[0-9a-f]{8}$/;

const KIND_SCHEMA_FILE = "packages/api-contract/src/schemas/os-workspaces.ts";

/** Every Output kind Tedix stores natively, with the decision that keeps it. */
export const ALLOWED_KINDS: Record<string, string> = {
	document: "134d3667",
	sheet: "134d3667",
	presentation: "134d3667",
	// A rendered artifact with access-checked media delivery and a quality
	// gate; it has no editor. Reviewed on 33edadcc.
	video: "33edadcc",
};

/** Every first-party Output editor surface, with the decision that allowed it. */
export const ALLOWED_EDITOR_FILES: Record<string, string> = {
	"apps/os/src/routes/_session/_tenant/outputs.tsx": "134d3667",
	"apps/os/src/routes/_session/_tenant/outputs_.$outputId.tsx": "134d3667",
	"apps/os/src/components/output-editor.tsx": "134d3667",
	"apps/os/src/components/output-editor-document.tsx": "134d3667",
	"apps/os/src/components/output-editor-sheet.tsx": "134d3667",
	"apps/os/src/components/output-editor-slides.tsx": "134d3667",
	"apps/os/src/components/output-editor-slide-list.tsx": "134d3667",
	"apps/os/src/components/output-editor-toolbar.tsx": "134d3667",
};

/** The members of `OsOutputKindSchema`, read from its `z.enum([...])` literal. */
export function outputKinds(source: string): string[] {
	const match = source.match(
		/export const OsOutputKindSchema = z\.enum\(\[([^\]]*)\]\)/,
	);
	if (!match)
		throw new Error(`OsOutputKindSchema not found in ${KIND_SCHEMA_FILE}`);
	return [...match[1]!.matchAll(/"([^"]+)"/g)].map((kind) => kind[1]!);
}

const TEST_RE = /\.(?:test|spec)(?:\.browser)?\.[jt]sx?$/;

function files(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? files(path) : [path];
	});
}

/** Repo-relative paths that are Output editor surfaces. */
export function editorFiles(paths: readonly string[]): string[] {
	return paths.filter(
		(path) =>
			!TEST_RE.test(path) &&
			((path.startsWith("apps/os/src/routes/") &&
				/(?:^|[/._-])outputs?(?:[/._-]|$)/.test(
					path.slice("apps/os/src/routes/".length),
				)) ||
				/^apps\/os\/src\/components\/output-editor[^/]*\.tsx$/.test(path)),
	);
}

export function findings(
	kinds: readonly string[],
	editors: readonly string[],
): string[] {
	const problems: string[] = [];
	for (const [name, decision] of [
		...Object.entries(ALLOWED_KINDS),
		...Object.entries(ALLOWED_EDITOR_FILES),
	])
		if (!DECISION_RE.test(decision))
			problems.push(
				`${name}: decision reference "${decision}" is not a Work Item id prefix`,
			);
	for (const kind of kinds)
		if (!Object.hasOwn(ALLOWED_KINDS, kind))
			problems.push(
				`${KIND_SCHEMA_FILE}: Output kind "${kind}" has no decision reference. A new view is a workspace app bound to a slot; add the kind to ALLOWED_KINDS in scripts/lint-output-kinds.ts only with the decision that allows it.`,
			);
	for (const file of editors)
		if (!Object.hasOwn(ALLOWED_EDITOR_FILES, file))
			problems.push(
				`${file}: new Output editor surface has no decision reference. Build the view as a workspace app, or add it to ALLOWED_EDITOR_FILES in scripts/lint-output-kinds.ts with the decision that allows it.`,
			);
	return problems;
}

if (import.meta.main) {
	const kinds = outputKinds(
		readFileSync(join(REPO_ROOT, KIND_SCHEMA_FILE), "utf8"),
	);
	const editors = editorFiles(
		[
			...files(join(REPO_ROOT, "apps/os/src/routes")),
			...files(join(REPO_ROOT, "apps/os/src/components")),
		].map((path) => relative(REPO_ROOT, path)),
	);
	const problems = findings(kinds, editors);
	for (const problem of problems) console.error(problem);
	if (problems.length) process.exit(1);
	console.log(
		`Output kinds: ${kinds.length} kinds and ${editors.length} editor files, all with a decision reference.`,
	);
}
