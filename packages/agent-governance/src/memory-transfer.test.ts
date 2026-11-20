import { expect, test } from "vite-plus/test";
import { InMemoryMemoryAdapter } from "./in-memory";
import { exportMemory, importMemory } from "./memory-transfer";
import type { MemoryRevision } from "./types";

const provenance = {
	actor: { id: "agent", kind: "agent" },
	source: { surface: "test" },
};

test("refuses corrupt bundles before writing any revision", async () => {
	const source = new InMemoryMemoryAdapter();
	await source.write({ key: "key", value: "first", provenance });
	await source.write({ key: "key", value: "second", provenance });
	const rows: MemoryRevision[] = (await exportMemory(source))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const corruptions = [
		[rows[0], { ...rows[1], value: "tampered" }],
		[rows[1], rows[0]],
		[rows[0], { ...rows[1], rolledBackFrom: "missing" }],
		[rows[0], { ...rows[1], revisionId: rows[0]!.revisionId }],
		[rows[0], { ...rows[1], review: "invalid" }],
		[rows[0], { ...rows[1], provenance: { ...provenance, importedFrom: {} } }],
	];
	for (const rows of corruptions) {
		const destination = new InMemoryMemoryAdapter();
		await expect(
			importMemory(
				destination,
				rows.map((row) => JSON.stringify(row)).join("\n"),
				"source-store",
			),
		).rejects.toThrow();
		expect(await destination.list()).toEqual([]);
	}
});

test("refuses occupied keys without importing earlier keys", async () => {
	const source = new InMemoryMemoryAdapter();
	await source.write({ key: "a", value: 1, provenance });
	await source.write({ key: "z", value: 2, provenance });
	const destination = new InMemoryMemoryAdapter();
	const existing = await destination.write({
		key: "z",
		value: "keep",
		provenance,
	});
	await expect(
		importMemory(destination, await exportMemory(source), "source-store"),
	).rejects.toThrow("already exists");
	expect(await destination.read("a")).toBeNull();
	expect(await destination.history("z")).toEqual([existing]);
});
