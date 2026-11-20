import { describe, expect, it, vi } from "vite-plus/test";
import { resolveDelegationWorkContext } from "./delegation-work-context";
const target = {
	id: "abcdef01-0000-4000-8000-000000000001",
	title: "Original research",
	description: "Read the source",
	acceptanceContract: { doneLooksLike: "Cited note" },
};
describe("original delegation Work context", () => {
	it("resolves prefixes exactly and keeps the original target independent of dispatch ownership", async () => {
		const resolve = vi.fn(async () => [target]);
		expect(
			await resolveDelegationWorkContext(
				"Research for Work abcdef01 and comment on Work abcdef01",
				resolve,
			),
		).toEqual([target]);
		expect(resolve).toHaveBeenCalledExactlyOnceWith("abcdef01");
	});
	it("leaves out a reference that names no single Work Item and never fails the send", async () => {
		const other = { ...target, id: "abcdef02-0000-4000-8000-000000000002" };
		expect(
			await resolveDelegationWorkContext(
				"Work abcdef01, Work abcdef02, Work abcdef03 and Work abcdef04",
				async (prefix) => {
					if (prefix === "abcdef01") return [target];
					if (prefix === "abcdef02") return [];
					if (prefix === "abcdef03") return [target, other];
					throw new Error("read failed");
				},
			),
		).toEqual([target]);
	});
});
