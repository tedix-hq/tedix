import { memoryStorage } from "./tedi-do";

export function facetContext() {
	const cursor = {
		toArray: () => [],
		one: () => ({}),
		raw: () => [][Symbol.iterator](),
		columnNames: [],
		rowsRead: 0,
		rowsWritten: 0,
		*[Symbol.iterator]() {},
	};
	return {
		storage: {
			...memoryStorage(),
			sql: { exec: () => cursor, databaseSize: 0 },
			transactionSync: <T>(run: () => T) => run(),
			setAlarm: async () => {},
			getAlarm: async () => null,
			deleteAlarm: async () => {},
			kv: { get: () => undefined, put: () => {}, delete: () => false },
		},
		id: { toString: () => "facet-id", name: "facet" },
		blockConcurrencyWhile: async <T>(run: () => Promise<T>) => run(),
		waitUntil: () => {},
		acceptWebSocket: () => {},
		getWebSockets: () => [],
		setWebSocketAutoResponse: () => {},
		exports: {},
	};
}
