import {
	renderActionReceipt,
	type ActionReceipt,
} from "@tedix/api-contract/utils/action-receipt";

/** Code Mode keeps receipts outside the model-authored projection. */
export function collectActionReceipts(
	value: unknown,
	toolName: string,
): ActionReceipt[] {
	if (
		(toolName !== "tedix_mcp_code" && toolName !== "tedix_mcp_call_tool") ||
		!value ||
		typeof value !== "object" ||
		!("actionReceipts" in value) ||
		!Array.isArray(value.actionReceipts)
	)
		return [];
	return value.actionReceipts.filter(
		(record): record is ActionReceipt =>
			record &&
			typeof record === "object" &&
			typeof record.operation === "string" &&
			typeof record.actor === "string" &&
			typeof record.verified === "boolean" &&
			typeof record.state === "string" &&
			typeof record.checkedAt === "string" &&
			(record.url === null || typeof record.url === "string"),
	);
}

export function appendActionReceipts(
	text: string,
	receipts: ActionReceipt[],
): string {
	const unique = new Map(
		receipts.map((receipt) => [
			`${receipt.operation}:${receipt.url}:${receipt.checkedAt}`,
			receipt,
		]),
	);
	const summary = receipts.some((receipt) => !receipt.verified)
		? "I could not verify every action. The receipts show what is confirmed."
		: text;
	return [summary, ...[...unique.values()].map(renderActionReceipt)]
		.filter(Boolean)
		.join("\n\n");
}
