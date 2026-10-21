import { getOpenAPIMeta } from "@orpc/openapi";
import { describe, expect, it } from "vite-plus/test";
import { tediAppAssignmentsContract } from "./tedi-app-assignments";

describe("tedi app assignments contract", () => {
	const entries = Object.entries(tediAppAssignmentsContract);

	it("covers every operation", () => {
		expect(entries).toHaveLength(14);
	});

	it.each(entries)("%s has a summary and a description", (_name, procedure) => {
		const meta = getOpenAPIMeta(
			procedure as unknown as Parameters<typeof getOpenAPIMeta>[0],
		) as { summary?: string; description?: string } | undefined;
		expect(meta?.summary?.trim()).toBeTruthy();
		expect(meta?.description?.trim()).toBeTruthy();
	});
});
