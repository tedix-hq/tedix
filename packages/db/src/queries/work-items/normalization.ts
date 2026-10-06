import type {
	WorkItem,
	WorkItemAcceptanceContract,
} from "../../schema/work-items";

export function normalizeWorkItemAcceptanceContract(
	value: unknown,
): WorkItemAcceptanceContract | null {
	if (value === null || value === undefined) return null;
	const parsed = typeof value === "string" ? JSON.parse(value) : value;
	if (typeof parsed !== "object" || parsed === null) {
		return parsed as WorkItemAcceptanceContract;
	}
	// Older accepted rows carry the retired `claims[]` shape; the
	// contract is what done looks like, so the legacy key is dropped on read.
	const { claims: _legacyClaims, ...contract } = parsed as Record<
		string,
		unknown
	>;
	return contract as unknown as WorkItemAcceptanceContract;
}

/** Normalize SQLite JSON scalar encodings before rows cross the DB boundary. */
export function normalizeWorkItemRow(item: WorkItem): WorkItem {
	return {
		...item,
		acceptanceContract: normalizeWorkItemAcceptanceContract(
			item.acceptanceContract,
		),
	};
}
