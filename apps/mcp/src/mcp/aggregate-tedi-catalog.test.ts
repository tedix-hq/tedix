import { expect, it } from "vite-plus/test";
import snapshot from "./aggregate-tedi-catalog.generated.json";
import { aggregateTediCatalog } from "./aggregate-tedi-catalog-source";

it("keeps the runtime tedi catalog identical to its contract-backed source", () => {
	expect(snapshot).toEqual(JSON.parse(JSON.stringify(aggregateTediCatalog)));
});
