import { listContractEndpoints } from "@tedix/api-contract/utils/contract-routers";
import { describe, expect, it } from "vite-plus/test";
import {
	buildAuthorizationMatrix,
	OBJECT_AUTHORIZATION_REVIEWS,
} from "./authorization-matrix";

describe("authorization matrix", () => {
	it("inventories every API contract including internal and non-MCP endpoints", () => {
		const matrix = buildAuthorizationMatrix();
		expect(matrix.rows.map((r) => r.endpoint)).toEqual(
			listContractEndpoints({ includeInternal: true }).map(
				(e) => `${e.router}/${e.procPath}`,
			),
		);
		expect(matrix.rows.filter((r) => r.mcp.toolId).length).toBeGreaterThan(500);
		expect(matrix.rows.some((r) => r.internal && !r.mcp.toolId)).toBe(true);
	});

	it("never treats scope coverage or a sibling's negative test as object proof", () => {
		const matrix = buildAuthorizationMatrix();
		const sibling = matrix.rows.find(
			(r) => r.endpoint === "tediAppAssignments/listByApp",
		)!;
		expect(sibling).toBeDefined();
		expect(sibling.mcp.scopes?.length).toBeGreaterThan(0);
		expect(sibling.objectAuthorization).toBeNull();
		expect(matrix.unreviewedEndpoints).toContain(sibling.endpoint);
		expect(
			matrix.rows
				.filter((r) => r.objectAuthorization)
				.map((r) => r.endpoint)
				.sort(),
		).toEqual(OBJECT_AUTHORIZATION_REVIEWS.map((r) => r.endpoint).sort());
	});

	it("rejects stale, duplicate and empty proof entries", () => {
		const review = OBJECT_AUTHORIZATION_REVIEWS[0]!;
		expect(() =>
			buildAuthorizationMatrix([{ ...review, endpoint: "unknown/get" }]),
		).toThrow("Unknown reviewed endpoint");
		expect(() => buildAuthorizationMatrix([review, review])).toThrow(
			"Duplicate review",
		);
		expect(() =>
			buildAuthorizationMatrix([{ ...review, negativeTest: " " }]),
		).toThrow("Incomplete object authorization review");
	});
});
