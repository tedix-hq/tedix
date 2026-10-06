/**
 * Content addressing for portable blueprint payloads.
 *
 * A blueprint export travels to organizations that cannot read the source row,
 * so the only way to identify what was forked is a digest of the content
 * itself. `JSON.stringify` alone is not stable enough for that: key order
 * follows insertion order, which follows the parse path, so two byte-different
 * serializations of the SAME parsed definition would digest differently. Keys
 * are therefore sorted recursively before hashing.
 */

import { sha256Hex } from "@tedix/worker-kit/crypto";

/** Deterministic JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === "object") {
		const source = value as Record<string, unknown>;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) {
			if (source[key] === undefined) continue;
			sorted[key] = canonicalize(source[key]);
		}
		return sorted;
	}
	return value;
}

/** The digest an export records and an import re-computes to verify the envelope. */
export async function canonicalDigest(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}
