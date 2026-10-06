import { RPCHandler } from "@orpc/server/fetch";
import { tedisContract } from "@tedix/api-contract/contracts/tedis";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { tedisContractRouter } from "../tedis";
import {
	decommissionTediProcedure,
	inspectAgentMemoryProcedure,
	rebindProcedure,
} from "./crud";
import { inspectRuntimeRecoveryProcedure } from "./recovery-diagnostic";

afterEach(() => vi.restoreAllMocks());

describe("removed automatic runtime recovery", () => {
	test("the contract and composed router retain explicit administration without auto recovery", () => {
		expect(Object.hasOwn(tedisContract, "recover")).toBe(false);
		expect(Object.hasOwn(tedisContractRouter, "recover")).toBe(false);
		for (const operation of [
			"rebind",
			"decommission",
			"inspectAgentMemory",
			"inspectRuntimeRecovery",
		] as const) {
			expect(tedisContract[operation]).toBeDefined();
			expect(tedisContractRouter[operation]).toBeDefined();
		}
		expect(tedisContractRouter.rebind).toBe(rebindProcedure);
		expect(tedisContractRouter.decommission).toBe(decommissionTediProcedure);
		expect(tedisContractRouter.inspectAgentMemory).toBe(
			inspectAgentMemoryProcedure,
		);
		expect(tedisContractRouter.inspectRuntimeRecovery).toBe(
			inspectRuntimeRecoveryProcedure,
		);
	});

	test("the former RPC is unmatched without inspecting state or dispatching effects", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
			throw new Error("Removed recovery must not contact a runtime");
		});
		const access = vi.fn(() => {
			throw new Error("Removed recovery must not inspect or mutate state");
		});
		const context = Object.defineProperties(
			{},
			{
				db: { get: access },
				env: { get: access },
			},
		);
		const handler = new RPCHandler({ tedis: tedisContractRouter });
		const result = await handler.handle(
			new Request("https://api.tedix.test/rpc/tedis/recover", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					json: { tediId: "11111111-1111-4111-8111-111111111111" },
				}),
			}),
			{ prefix: "/rpc", context: context as never },
		);
		expect(result.matched).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
		expect(access).not.toHaveBeenCalled();
	});
});
