import { expect, test } from "bun:test";
import { adapter } from "./adapter";
import { facts, orgs } from "./fixtures";

test("production retrieval uses a real isolated database and seeded entity graph", async () => {
	const a = await adapter(process.cwd());
	try {
		a.seed(facts);
		const entities = a.sqlite
			.prepare("SELECT COUNT(*) AS n FROM memory_entities")
			.get() as { n: number };
		expect(entities.n).toBeGreaterThan(30);
		const result = await a.recall(orgs[0]!, "Vessel-0 launch current date");
		expect(result.ids.length).toBeGreaterThan(0);
		for (const id of result.ids) {
			const f = facts.find((f) => f.id === id)!;
			expect(f.org).toBe(orgs[0]!);
			expect(f.validTo).toBeUndefined();
		}
		expect((await a.recall("org_fable_unseeded", "Vessel-0")).ids).toEqual([]);
	} finally {
		a.close();
	}
});
