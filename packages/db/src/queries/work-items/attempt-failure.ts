import type { JsonValue } from "@tedix/api-contract/schemas/common";

export function workAttemptFailureReason(
	summary: string | undefined,
	metadata: Record<string, JsonValue> | undefined,
): string {
	const explicit = metadata?.failureReason;
	if (typeof explicit === "string" && explicit.trim())
		return explicit.trim().replace(/\s+/g, " ");
	const lines =
		summary
			?.split("\n")
			.map((line) => line.trim())
			.filter(Boolean) ?? [];
	return (
		lines.find((line) =>
			/\b(?:block(?:ed|er)|error|reason|failed)\b/i.test(line),
		) ?? "Attempt failed without a reported reason; inspect its run history."
	);
}
