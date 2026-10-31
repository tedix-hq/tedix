import { sha256Hex } from "@tedix/worker-kit/crypto";

export function canonicalWorkflowRuntimeJson(value: unknown): string {
	const normalize = (current: unknown): unknown => {
		if (Array.isArray(current)) return current.map(normalize);
		if (current && typeof current === "object") {
			return Object.fromEntries(
				Object.entries(current as Record<string, unknown>)
					.filter(([, item]) => item !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, normalize(item)]),
			);
		}
		return current;
	};
	return JSON.stringify(normalize(value));
}

export async function buildWorkflowExecutionCompatibility(input: {
	surface: unknown;
	serviceToken: string;
}): Promise<{
	executionCompatibilityHash: string;
	serviceTokenVersion: string;
}> {
	const serviceTokenVersion = await sha256Hex(input.serviceToken);
	return {
		serviceTokenVersion,
		executionCompatibilityHash: await sha256Hex(
			canonicalWorkflowRuntimeJson({
				surface: input.surface,
				serviceTokenVersion,
			}),
		),
	};
}
