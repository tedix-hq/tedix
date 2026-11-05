import { describe, expect, it, vi } from "vite-plus/test";
import {
	type GatewayToolContractSnapshot,
	persistGatewayToolContractSnapshot,
} from "./gateway-tool-contract-snapshot";

function snapshot(
	tools: GatewayToolContractSnapshot["tools"],
): GatewayToolContractSnapshot {
	return {
		version: 1,
		organizationId: "org-1",
		gatewayId: "gateway-1",
		gatewaySlug: "acme-unified",
		tools,
	};
}

function tool(
	name: string,
	overrides: Partial<GatewayToolContractSnapshot["tools"][number]> = {},
) {
	return {
		name,
		namespace: "work",
		requiredScopes: ["mcp:work.read"],
		writeCapability: "read" as const,
		schemaHash: `${name}-hash`,
		...overrides,
	};
}

function bucket(initial: GatewayToolContractSnapshot) {
	let value = JSON.stringify(initial);
	return {
		get: vi.fn(async () => ({ text: async () => value })),
		put: vi.fn(async (_key: string, next: string) => {
			value = next;
		}),
	};
}

describe("gateway tool contract snapshots", () => {
	it("reports added, removed, and changed tools, then writes nothing for the same surface", async () => {
		const store = bucket(
			snapshot([tool("removed"), tool("changed", { schemaHash: "old-hash" })]),
		);
		const notify = vi.fn(async () => undefined);
		const next = snapshot([
			tool("added"),
			tool("changed", { schemaHash: "new-hash" }),
		]);

		await expect(
			persistGatewayToolContractSnapshot(store, next, notify),
		).resolves.toEqual({
			added: ["work.added"],
			removed: ["work.removed"],
			changed: ["work.changed"],
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledTimes(1);

		await expect(
			persistGatewayToolContractSnapshot(store, next, notify),
		).resolves.toBeNull();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(store.put).toHaveBeenCalledTimes(1);
	});
});
