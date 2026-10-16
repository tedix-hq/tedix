import {
	renderActionReceipt,
	type ActionReceipt,
} from "@tedix/api-contract/utils/action-receipt";

/** Receipts are owned by the tool ledger, before the model/facet return path. */
export class ActionReceiptJournal {
	constructor(
		private readonly storage: Pick<DurableObjectStorage, "put" | "list">,
	) {}
	async record(event: {
		id: string;
		kind: string;
		runId?: string;
		payload?: unknown;
	}) {
		if (event.kind !== "tool.completed" || !event.runId) return;
		const payload = event.payload as { name?: unknown } | null;
		const receipts = collectActionReceipts(
			event.payload,
			typeof payload?.name === "string" ? payload.name : "",
		);
		if (receipts.length)
			await this.storage.put(
				`action-receipts:${event.runId}:${event.id}`,
				receipts,
			);
	}
	async finish(runId: string, text: string): Promise<string> {
		const stored = await this.storage.list<ActionReceipt[]>({
			prefix: `action-receipts:${runId}:`,
		});
		return appendActionReceipts(text, [...stored.values()].flat());
	}
}

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
