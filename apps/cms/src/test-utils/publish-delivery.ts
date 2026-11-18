import type { PluginContext, StorageCollection } from "emdash";
type QueryOptions = NonNullable<Parameters<StorageCollection["query"]>[0]>;
import { vi } from "vite-plus/test";
import type { DeliveryJob } from "../../templates/tedix/src/lib/publish-delivery";

/** Plugin storage fake with atomic revision conflicts and paginated indexed reads. */
export function deliveryFixture() {
	const rows = new Map<string, { value: DeliveryJob; revision: string }>();
	let revision = 0;
	function matches(value: DeliveryJob, where: QueryOptions["where"]) {
		return Object.entries(where ?? {}).every(([key, filter]) => {
			const field = value[key as keyof DeliveryJob];
			return typeof filter === "object" && filter !== null && "lte" in filter
				? Number(field) <= Number(filter.lte)
				: field === filter;
		});
	}
	const deliveries = {
		getVersioned: async (id: string) => structuredClone(rows.get(id) ?? null),
		compareAndSet: vi.fn(
			async (id: string, expected: string | null, value: DeliveryJob) => {
				if ((rows.get(id)?.revision ?? null) !== expected)
					return { applied: false as const };
				const next = String(++revision);
				rows.set(id, { value: structuredClone(value), revision: next });
				return { applied: true as const, revision: next };
			},
		),
		query: async (options: QueryOptions = {}) => ({
			items: [...rows]
				.filter(([, row]) => matches(row.value, options.where))
				.sort((a, b) => a[1].value.due - b[1].value.due)
				.slice(0, options.limit ?? 50)
				.map(([id, row]) => ({ id, data: structuredClone(row.value) })),
			hasMore: false,
		}),
		count: async (where: QueryOptions["where"]) =>
			[...rows.values()].filter((row) => matches(row.value, where)).length,
	};
	const tasks: Array<{ name: string }> = [];
	const cron = {
		list: async () => tasks,
		schedule: vi.fn(async (name: string) => {
			tasks.push({ name });
		}),
	};
	const ctx = {
		storage: { deliveries },
		cron,
		site: { name: "Acme", url: "https://acme.example" },
	} as unknown as PluginContext;
	return { rows, deliveries, cron, ctx };
}
