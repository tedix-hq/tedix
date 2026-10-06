import { isNonEmptySpec } from "@json-render/core";

/**
 * Read the layout spec from the embedded <script> tag.
 * The Astro route SSRs the spec into `<script id="tedix-layout-spec" type="application/json">`.
 */
export function readEmbeddedSpec(): Record<string, unknown> | null {
	if (typeof document === "undefined") return null;
	const el = document.getElementById("tedix-layout-spec");
	if (!el?.textContent) return null;
	try {
		const parsed = JSON.parse(el.textContent);
		return isNonEmptySpec(parsed)
			? (parsed as unknown as Record<string, unknown>)
			: null;
	} catch {
		console.error("[readEmbeddedSpec] Failed to parse embedded layout spec");
		return null;
	}
}

/**
 * Read tool structuredContent embedded by hosts such as Tedix OS.
 */
export function readEmbeddedData(): unknown {
	if (typeof document === "undefined") return undefined;
	const el = document.getElementById("tedix-tool-data");
	const fragmentData =
		typeof window !== "undefined"
			? new URLSearchParams(window.location.hash.slice(1)).get("data")
			: null;
	const text = el?.textContent ?? decodeFragmentData(fragmentData);
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text);
		return parsed;
	} catch {
		console.error("[readEmbeddedData] Failed to parse embedded tool data");
		return undefined;
	}
}

function decodeFragmentData(value: string | null): string | null {
	if (!value) return null;
	try {
		const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
		const padded = normalized.padEnd(
			normalized.length + ((4 - (normalized.length % 4)) % 4),
			"=",
		);
		const binary = atob(padded);
		return new TextDecoder().decode(
			Uint8Array.from(binary, (character) => character.charCodeAt(0)),
		);
	} catch {
		console.error("[readEmbeddedData] Failed to decode fragment tool data");
		return null;
	}
}

/** json-render state is an object; non-object JSON is exposed at $state.value. */
export function widgetRenderData(
	value: unknown,
): Record<string, unknown> | null {
	if (value === undefined) return null;
	if (value !== null && typeof value === "object" && !Array.isArray(value))
		return value as Record<string, unknown>;
	return { value };
}
