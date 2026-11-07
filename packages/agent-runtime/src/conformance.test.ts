import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import {
	ADDER_BINDING,
	type CloudflareAgentObject,
	type TestEnv,
	type WorkerdAgentObject,
} from "../test/worker";
import { cloudflareAgentObjectStub } from "./cloudflare";
import {
	describeAgentRuntimeConformance,
	type AgentRuntimeConformanceHarness,
} from "./conformance";
import type { AgentJurisdiction, AgentRuntime } from "./index";
import { workerdAgentObjectStub } from "./workerd";

type AgentObject = CloudflareAgentObject | WorkerdAgentObject;

const testEnv = env as unknown as TestEnv;

function harness(
	namespace: DurableObjectNamespace<AgentObject>,
	jurisdiction: AgentJurisdiction,
): AgentRuntimeConformanceHarness {
	const stubFor = (objectId: string) => namespace.getByName(objectId);
	return {
		jurisdiction,
		adderBinding: ADDER_BINDING,
		withRuntime: <T>(
			objectId: string,
			fn: (runtime: AgentRuntime) => Promise<T>,
		) =>
			runInDurableObject(stubFor(objectId), (instance: AgentObject) =>
				fn(instance.runtime),
			),
		connect: async (objectId, after = 0) => {
			const response = await stubFor(objectId).fetch(
				new Request(`https://workspace/events?after=${after}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			const ws = response.webSocket;
			if (!ws) throw new Error(`No WebSocket in ${response.status} response`);
			return ws;
		},
		fireAlarm: async (objectId) => {
			await runDurableObjectAlarm(stubFor(objectId));
		},
		firedAlarms: (objectId) =>
			runInDurableObject(stubFor(objectId), (instance: AgentObject) =>
				instance.firedAlarms(),
			),
	};
}

describeAgentRuntimeConformance(
	"cloudflare",
	harness(testEnv.CLOUDFLARE_AGENT, "global"),
);

describeAgentRuntimeConformance(
	"workerd",
	harness(testEnv.WORKERD_AGENT, "local"),
);

describe("addressing", () => {
	it("creates an EU object inside the EU jurisdiction", () => {
		const selected: string[] = [];
		const namespace = {
			getByName: (name: string) => `global:${name}`,
			jurisdiction(value: string) {
				selected.push(value);
				return { getByName: (name: string) => `${value}:${name}` };
			},
		};
		expect(
			cloudflareAgentObjectStub(namespace, {
				objectId: "w1",
				jurisdiction: "eu",
			}),
		).toBe("eu:w1");
		expect(
			cloudflareAgentObjectStub(namespace, {
				objectId: "w2",
				jurisdiction: "global",
			}),
		).toBe("global:w2");
		expect(selected).toEqual(["eu"]);
	});

	it("refuses a local jurisdiction on Cloudflare", () => {
		expect(() =>
			cloudflareAgentObjectStub(
				{ getByName: (name: string) => name },
				{ objectId: "w", jurisdiction: "local" as never },
			),
		).toThrow(/"eu" or "global"/);
	});

	it("addresses a self-hosted object by name alone", () => {
		expect(
			workerdAgentObjectStub(
				{ getByName: (name: string) => `disk:${name}` },
				"w3",
			),
		).toBe("disk:w3");
	});

	it("resolves the same object for the same id on the real namespace", async () => {
		const stub = cloudflareAgentObjectStub(testEnv.CLOUDFLARE_AGENT, {
			objectId: "same-id",
			jurisdiction: "global",
		});
		const again = cloudflareAgentObjectStub(testEnv.CLOUDFLARE_AGENT, {
			objectId: "same-id",
			jurisdiction: "global",
		});
		expect(stub.id.equals(again.id)).toBe(true);
	});
});
