import type { JsonValue } from "@tedix/api-contract/schemas/common";
import type { ControlPlaneDiffEntry } from "@tedix/api-contract/schemas/control-plane";

function isRecord(
	value: JsonValue | undefined,
): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalJson(
	left: JsonValue | undefined,
	right: JsonValue | undefined,
): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/** Deterministic path-based JSON diff. Arrays remain atomic ordered values. */
function diffJson(
	before: JsonValue,
	after: JsonValue,
	path = "$",
): ControlPlaneDiffEntry[] {
	if (isRecord(before) && isRecord(after)) {
		const keys = [
			...new Set([...Object.keys(before), ...Object.keys(after)]),
		].sort();
		return keys.flatMap((key) => {
			const childPath = `${path}.${key}`;
			if (!(key in before)) {
				return [{ path: childPath, kind: "added" as const, after: after[key] }];
			}
			if (!(key in after)) {
				return [
					{ path: childPath, kind: "removed" as const, before: before[key] },
				];
			}
			return diffJson(
				before[key] as JsonValue,
				after[key] as JsonValue,
				childPath,
			);
		});
	}
	if (equalJson(before, after)) return [];
	return [{ path, kind: "changed", before, after }];
}

export function diffControlPlaneJson(
	before: unknown,
	after: unknown,
): ControlPlaneDiffEntry[] {
	const normalizedBefore = JSON.parse(JSON.stringify(before)) as JsonValue;
	const normalizedAfter = JSON.parse(JSON.stringify(after)) as JsonValue;
	return diffJson(normalizedBefore, normalizedAfter);
}
