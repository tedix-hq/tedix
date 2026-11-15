import { aggregateTediCatalog } from "../../apps/mcp/src/mcp/aggregate-tedi-catalog-source";

const target = new URL(
	"../../apps/mcp/src/mcp/aggregate-tedi-catalog.generated.json",
	import.meta.url,
);
const serialized = JSON.stringify(aggregateTediCatalog);
if (process.argv.includes("--check")) {
	const current = await Bun.file(target).json();
	if (JSON.stringify(current) !== serialized) {
		throw new Error(
			"Aggregate tedi catalog is stale. Run bun scripts/mcp/generate-aggregate-tedi-catalog.ts",
		);
	}
} else {
	await Bun.write(
		target,
		`${JSON.stringify(aggregateTediCatalog, null, "\t")}\n`,
	);
}
