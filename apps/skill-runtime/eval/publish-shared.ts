/**
 * Shared plumbing for the eval skill publishers.
 *
 * One copy of the scaffolding that has repeatedly caused real bugs:
 * anchored placeholder replacement, the comment-free payload assertion,
 * the upsert-by-canonical-id publish payload, and the tedix-CLI invocation.
 * `publish-calibration-skill.ts` and `publish-drill-skill.ts` import from
 * here.
 *
 * Everything in this module is a pure helper — no top-level side effects —
 * so tests and hash-verification scripts can import it (and the publishers'
 * assembly builders) without touching the live platform.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(EVAL_DIR, "../../..");

/**
 * Replace an anchor that must occur exactly once.
 *
 * A naive first-occurrence `String.replace` once injected the gold set into a
 * doc comment that also mentioned the placeholder while the code kept it (the
 * run failed with "__GOLD__ is not defined"). Anchoring on the full unique
 * string and refusing to proceed on zero or multiple occurrences makes that
 * class of bug loud at publish time instead of at run time.
 */
export function replaceAnchor(
	template: string,
	anchor: string,
	replacement: string,
): string {
	const first = template.indexOf(anchor);
	if (first < 0) {
		throw new Error(`anchor not found: ${JSON.stringify(anchor)}`);
	}
	if (template.indexOf(anchor, first + anchor.length) >= 0) {
		throw new Error(`anchor occurs more than once: ${JSON.stringify(anchor)}`);
	}
	return (
		template.slice(0, first) +
		replacement +
		template.slice(first + anchor.length)
	);
}

/**
 * Strip the repo-only `// @ts-nocheck` pragma line from a workflow template.
 * The runtime strips types itself; the pragma is for the repo's editors only.
 * Throws when the template does not carry the pragma — a template that lost
 * it (or already lost it to an earlier strip) is a drifted input, not a
 * publishable one.
 */
export function stripTsNocheckPragma(template: string, label: string): string {
	const stripped = template.replace(/^\/\/ @ts-nocheck[^\n]*\n/, "");
	if (stripped === template) {
		throw new Error(`${label}: missing leading // @ts-nocheck pragma`);
	}
	return stripped;
}

/**
 * Assert a codemode payload contains no `//` line comments outside string
 * literals. Payloads are folded onto one line before shipping through the
 * CLI, so a surviving line comment swallows the rest of the program (that
 * exact failure shipped once).
 *
 * This is a deliberate line-scan heuristic, not a JS parser. It tracks
 * '/"/` quoting and backslash escapes. Known limits: a `//` inside a regex
 * literal false-positives, and a `//` inside a nested template-literal
 * `${ ... }` expression is treated as string content and missed. Keep
 * payloads simple enough that neither case arises; a false positive here is
 * a prompt to simplify the payload, not to weaken the check.
 */
export function assertNoLineComments(source: string, label: string): void {
	let quote: "'" | '"' | "`" | null = null;
	let escaped = false;
	let line = 1;
	for (let i = 0; i < source.length; i++) {
		const ch = source[i] as string;
		if (ch === "\n") {
			line++;
			// A newline terminates any escape and any single-line quote context we
			// mis-tracked; only backticks legitimately span lines.
			escaped = false;
			if (quote === "'" || quote === '"') quote = null;
			continue;
		}
		if (quote) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			quote = ch;
			continue;
		}
		if (ch === "/" && source[i + 1] === "/") {
			throw new Error(
				`${label}: line comment at line ${line} would swallow the one-lined payload — use /* */ or move the prose out of the payload`,
			);
		}
	}
}

export function toBase64(s: string): string {
	return Buffer.from(s, "utf8").toString("base64");
}

/**
 * Build the upsert payload: One `improve_skills` call against the canonical
 * skill id. Never search by title — `list_skills_by_org` pagination clamps at
 * scale and silently misses the row (the fallback create then mints a
 * duplicate, which happened once, and silently failed twice). The repo knows
 * which skill it owns; it says so explicitly.
 *
 * Payloads go base64 so quoting/tabs survive the shell; the embedded workflow
 * keeps its newlines inside the base64, so only this outer payload is subject
 * to the one-line fold (and therefore to `assertNoLineComments`).
 */
export function buildUpsertSkillJs(opts: {
	skillId: string;
	skillMd: string;
	workflowJs: string;
	revisionReasoning: string;
}): string {
	return `async () => {
  const dec = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
  const content = dec("${toBase64(opts.skillMd)}");
  const wf = dec("${toBase64(opts.workflowJs)}");
  const r = await skills.improve_skills({ id: ${JSON.stringify(opts.skillId)}, content, files: { "scripts/workflow.ts": wf }, revisionReasoning: ${JSON.stringify(opts.revisionReasoning)} });
  const e = r && (r.entry || r);
  return { action: "updated", id: ${JSON.stringify(opts.skillId)}, revision: e && e.revision, schedule: e && e.content && e.content.includes("schedule:") };
}`;
}

/**
 * Publish a codemode payload through the installed CLI to an explicit workspace.
 * Asserts the payload is line-comment-free, folds it onto one line, and runs
 * it. This is the only function in this module with a side effect — callers
 * keep it out of import-time paths.
 */
export function runTedixCode(
	js: string,
	opts?: {
		label?: string;
		/** How many trailing output lines to keep (default 1: the JSON result). */
		tailLines?: number;
		/** Merge stderr into the captured output (default: discard it). */
		includeStderr?: boolean;
		timeoutMs?: number;
	},
): string {
	const label = opts?.label ?? "codemode payload";
	assertNoLineComments(js, label);
	const workspace = process.env.TEDIX_WORKSPACE?.trim();
	if (!workspace)
		throw new Error("Set TEDIX_WORKSPACE to the publishing workspace.");
	const folded = js.replace(/\s*\n\s*/g, " ");
	const result = spawnSync(
		"tedix",
		["code", folded, "-w", workspace, "--json"],
		{
			cwd: REPO,
			encoding: "utf8",
			timeout: opts?.timeoutMs ?? 180_000,
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw new Error(
			`Publishing failed: ${result.stderr?.trim() || result.status}`,
		);
	const output = `${result.stdout ?? ""}${opts?.includeStderr ? (result.stderr ?? "") : ""}`;
	return output
		.trim()
		.split("\n")
		.slice(-(opts?.tailLines ?? 1))
		.join("\n");
}
