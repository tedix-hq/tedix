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
	it("returns candidates instead of padding or inventing a UUID", async () => {
		await expect(
			resolveDelegationWorkContext("Work abcdef01", async () => []),
		).rejects.toThrow("Never invent a UUID");
		await expect(
			resolveDelegationWorkContext("Work abcdef01", async () => [
				target,
				{ ...target, id: "abcdef01-0000-4000-8000-000000000002" },
			]),
		).rejects.toThrow("candidates: abcdef01-");
	});
});
