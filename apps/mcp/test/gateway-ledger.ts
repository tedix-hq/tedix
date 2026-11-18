import { createInMemoryAdapters } from "@tedix/agent-governance/in-memory";
import type {
	ChangeRecordInput,
	LedgerQuery,
} from "@tedix/agent-governance/types";

export function createGatewayLedgerApi() {
	const { accountability } = createInMemoryAdapters();
	return {
		appendChangeRecord: (input: ChangeRecordInput) =>
			accountability.append(input),
		listChangeRecords: (query: LedgerQuery) => accountability.list(query),
		getChangeRecord: ({ id }: { id: string }) => accountability.get(id),
	};
}
