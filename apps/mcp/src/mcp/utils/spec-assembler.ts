/**
 * Spec Assembler — Parses JSONL (RFC 6902 patches) and YAML into json-render Specs.
 *
 * Thin wrapper around @json-render/core and @json-render/yaml.
 *
 * @module @tedix/mcp/mcp/utils/spec-assembler
 */

import { compileSpecStream, isNonEmptySpec } from "@json-render/core";
import type { Spec } from "@json-render/core";
import { createYamlStreamCompiler } from "@json-render/yaml";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const JSONL_LANGS = ["json", "jsonl"];
const YAML_LANGS = ["yaml-spec", "yaml"];

/**
 * Extract content from the first matching markdown fenced code block.
 * Returns the inner content if a matching fence is found, otherwise the
 * original text (so bare JSONL / YAML still works).
 */
function extractFromFences(text: string, langs: string[]): string {
	const langAlt = langs.join("|");
	const re = new RegExp(`\`\`\`(?:${langAlt})\\s*\\n([\\s\\S]*?)\`\`\``);
	const match = text.match(re);
	return match?.[1] ?? text;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse JSONL (RFC 6902 JSON Patch lines) into a Spec.
 *
 * Extracts from markdown fences (```json / ```jsonl) when present.
 * Returns `null` if the result is not a valid non-empty spec.
 */
export function parseJsonlSpec(text: string): Spec | null {
	const extracted = extractFromFences(text, JSONL_LANGS);

	try {
		const result = compileSpecStream(extracted, {
			root: "",
			elements: {},
		} as Record<string, unknown>);

		return isNonEmptySpec(result) ? result : null;
	} catch {
		return null;
	}
}

/**
 * Parse YAML spec text into a Spec.
 *
 * Extracts from markdown fences (```yaml-spec / ```yaml) when present.
 * Returns `null` if the result is not a valid non-empty spec.
 */
export function parseYamlSpec(text: string): Spec | null {
	const extracted = extractFromFences(text, YAML_LANGS);

	try {
		const compiler = createYamlStreamCompiler();
		compiler.push(extracted);
		const { result } = compiler.flush();

		return isNonEmptySpec(result) ? result : null;
	} catch {
		return null;
	}
}

/**
 * Auto-detect format and parse into a Spec.
 *
 * Checks for YAML fences first (`yaml-spec` or `yaml`), then falls back
 * to JSONL parsing.
 */
export function parseSpec(text: string): Spec | null {
	// YAML fence takes priority
	if (/```(?:yaml-spec|yaml)\s*\n/.test(text)) {
		return parseYamlSpec(text) ?? parseJsonlSpec(text);
	}

	// JSONL first, YAML fallback (handles unfenced YAML)
	return parseJsonlSpec(text) ?? parseYamlSpec(text);
}
