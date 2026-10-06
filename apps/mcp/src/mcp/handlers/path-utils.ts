/**
 * Pure path-manipulation helpers for tool response shaping.
 *
 * Used by `ToolHandler` to apply `config.responsePick`, `config.responseRedact`,
 * `config.responseStripFields`, and similar D1-driven response transformations.
 *
 * No module state, no side effects beyond the in-place mutations documented
 * per function.
 */

/**
 * Path segments that would reach `Object.prototype` (or a constructor) when
 * written. Writers skip any path containing one, so a tool config can never
 * pollute prototypes shared by every request in the isolate.
 */
function isUnsafePathKey(key: string): boolean {
	return key === "__proto__" || key === "constructor" || key === "prototype";
}

/**
 * Extract a value from a nested object using dot-path notation.
 * e.g., getByPath({ a: { b: [1,2] } }, "a.b") => [1,2]
 *
 * Note: Does not support numeric array indices (e.g., "items.0.id").
 * Arrays are typically terminal values in API responses — extract the array, not elements within.
 */
export function getByPath(obj: unknown, path: string): unknown {
	let current = obj;
	for (const key of path.split(".")) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/**
 * Redact a value at a path inside an object, replacing it with "<redacted>".
 * Supports `[*]` wildcard for array fan-out (e.g. "sessions[*].cdpUrl").
 * Mutates the target object in place. Used by config.responseRedact.
 */
export function redactByPath(obj: Record<string, unknown>, path: string): void {
	const segments = path.split(".");
	const visit = (node: unknown, idx: number): void => {
		if (node == null || idx >= segments.length) return;
		const seg = segments[idx]!;
		const wildcardMatch = seg.match(/^([^[]+)\[\*\]$/);
		if (wildcardMatch) {
			const key = wildcardMatch[1]!;
			if (typeof node !== "object") return;
			const arr = (node as Record<string, unknown>)[key];
			if (!Array.isArray(arr)) return;
			if (idx === segments.length - 1) {
				for (let i = 0; i < arr.length; i++) {
					if (typeof arr[i] === "string") arr[i] = "<redacted>";
				}
				return;
			}
			for (const item of arr) visit(item, idx + 1);
			return;
		}
		if (typeof node !== "object" || isUnsafePathKey(seg)) return;
		const target = node as Record<string, unknown>;
		if (idx === segments.length - 1) {
			if (typeof target[seg] === "string") target[seg] = "<redacted>";
			return;
		}
		visit(target[seg], idx + 1);
	};
	visit(obj, 0);
}

/**
 * Set a value on a nested object using dot-path notation, creating intermediate objects as needed.
 * e.g., setByPath(obj, "price.formatted", "$9.99") => obj.price.formatted = "$9.99"
 */
export function setByPath(
	obj: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const keys = path.split(".");
	if (keys.some(isUnsafePathKey)) return;
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < keys.length - 1; i++) {
		const key = keys[i]!;
		if (current[key] == null || typeof current[key] !== "object") {
			current[key] = {};
		}
		current = current[key] as Record<string, unknown>;
	}
	current[keys[keys.length - 1]!] = value;
}

/**
 * Walk a path expression with `[]` array iterators and apply a callback
 * to each array found at the terminal position.
 *
 * Example: "items[].offers" with callback `fn` will:
 *   1. Get `obj.items` (must be array)
 *   2. For each element, get `.offers`
 *   3. If `.offers` is an array, call `fn(offers)`
 */
export function applyToNestedArrays(
	obj: unknown,
	pathExpr: string,
	fn: (arr: unknown[]) => void,
): void {
	const segments = pathExpr.split("[]");
	function walk(current: unknown, segIdx: number): void {
		if (current == null || typeof current !== "object") return;
		const seg = segments[segIdx]!;
		// Remove leading dot from segment (e.g., ".offers" → "offers")
		const path = seg.startsWith(".") ? seg.slice(1) : seg;

		if (segIdx === segments.length - 1) {
			// Terminal segment — resolve path and apply fn
			const target = path ? getByPath(current, path) : current;
			if (Array.isArray(target)) fn(target);
		} else {
			// Intermediate segment — resolve path, expect array, recurse
			const arr = path ? getByPath(current, path) : current;
			if (!Array.isArray(arr)) return;
			for (const item of arr) {
				walk(item, segIdx + 1);
			}
		}
	}
	walk(obj, 0);
}

/**
 * Strip a field from the output using a path expression with `[]` iterators.
 *
 * Parses path into segments: "items[].offers[].paymentMethods" becomes
 * [{key:"items", iterate:true}, {key:"offers", iterate:true}, {key:"paymentMethods", iterate:false}]
 *
 * Walks the tree recursively — when a segment has `iterate:true`, it expects
 * an array and recurses into each element. The final segment is deleted.
 */
export function applyStripField(obj: unknown, pathExpr: string): void {
	// Parse "items[].offers[].paymentMethods" into structured segments
	const parts = pathExpr.split(".");
	const segments: { key: string; iterate: boolean }[] = [];
	for (const part of parts) {
		if (part.endsWith("[]")) {
			segments.push({ key: part.slice(0, -2), iterate: true });
		} else {
			segments.push({ key: part, iterate: false });
		}
	}

	function walk(current: unknown, idx: number): void {
		if (current == null || typeof current !== "object") return;
		const seg = segments[idx]!;

		if (idx === segments.length - 1) {
			// Terminal: delete the field
			if (!Array.isArray(current)) {
				delete (current as Record<string, unknown>)[seg.key];
			}
			return;
		}

		// Intermediate: resolve and optionally iterate
		const value = (current as Record<string, unknown>)[seg.key];
		if (seg.iterate) {
			if (!Array.isArray(value)) return;
			for (const item of value) {
				walk(item, idx + 1);
			}
		} else {
			walk(value, idx + 1);
		}
	}

	walk(obj, 0);
}
