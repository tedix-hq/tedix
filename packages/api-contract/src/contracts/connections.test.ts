import { getOpenAPIMeta } from "@orpc/openapi";
import { describe, expect, it } from "vite-plus/test";
import { ConnectionInventoryInputSchema } from "../schemas/connections";
import { procedureInputSchema } from "../utils/procedure-schemas";
import { zodToToolInputJsonSchema } from "../utils/tool-json-schema";
import { connectionsContract } from "./connections";

describe("connections overview MCP projection", () => {
	it("exposes separate attention and unchecked filters with their meanings", () => {
		const schema = zodToToolInputJsonSchema(
			procedureInputSchema(connectionsContract.getConnectionsOverview),
		);
		expect(schema.properties?.status).toMatchObject({
			enum: ["all", "attention", "unchecked", "in_use", "unused"],
			default: "all",
			description: expect.stringContaining("unchecked: restricted or unknown"),
		});
		expect(
			getOpenAPIMeta(connectionsContract.getConnectionsOverview)?.description,
		).toContain("Unchecked accounts are excluded from attention");
		expect(ConnectionInventoryInputSchema.parse({}).status).toBe("all");
		expect(
			ConnectionInventoryInputSchema.parse({ status: "unchecked" }).status,
		).toBe("unchecked");
	});
});
