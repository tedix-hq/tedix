import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import {
	ADDER_BINDING,
	type CloudflareWorkspaceObject,
	type TestEnv,
	type WorkerdWorkspaceObject,
} from "../test/worker";
import { cloudflareWorkspaceStub } from "./cloudflare";
import {
	describeWorkspaceRuntimeConformance,
	type WorkspaceRuntimeConformanceHarness,
} from "./conformance";
import type { WorkspaceJurisdiction, WorkspaceRuntime } from "./index";
import { workerdWorkspaceStub } from "./workerd";

type WorkspaceObject = CloudflareWorkspaceObject | WorkerdWorkspaceObject;

const testEnv = env as unknown as TestEnv;

function harness(
	namespace: DurableObjectNamespace<WorkspaceObject>,
	jurisdiction: WorkspaceJurisdiction,
): WorkspaceRuntimeConformanceHarness {
	const stubFor = (workspaceId: string) => namespace.getByName(workspaceId);
	return {
		jurisdiction,
		adderBinding: ADDER_BINDING,
		withRuntime: <T>(
			workspaceId: string,
			fn: (runtime: WorkspaceRuntime) => Promise<T>,
		) =>
			runInDurableObject(stubFor(workspaceId), (instance: WorkspaceObject) =>
				fn(instance.runtime),
			),
		connect: async (workspaceId, after = 0) => {
			const response = await stubFor(workspaceId).fetch(
				new Request(`https://workspace/events?after=${after}`, {
					headers: { Upgrade: "websocket" },
				}),
			);
			const ws = response.webSocket;
			if (!ws) throw new Error(`No WebSocket in ${response.status} response`);
			return ws;
		},
		fireAlarm: async (workspaceId) => {
			await runDurableObjectAlarm(stubFor(workspaceId));
		},
		firedAlarms: (workspaceId) =>
			runInDurableObject(stubFor(workspaceId), (instance: WorkspaceObject) =>
				instance.firedAlarms(),
			),
	};
}

describeWorkspaceRuntimeConformance(
	"cloudflare",
	harness(testEnv.CLOUDFLARE_WORKSPACE, "global"),
);

describeWorkspaceRuntimeConformance(
	"workerd",
	harness(testEnv.WORKERD_WORKSPACE, "local"),
);

describe("addressing", () => {
	it("creates an EU workspace inside the EU jurisdiction", () => {
		const selected: string[] = [];
		const namespace = {
			getByName: (name: string) => `global:${name}`,
			jurisdiction(value: string) {
				selected.push(value);
				return { getByName: (name: string) => `${value}:${name}` };
			},
		};
		expect(
			cloudflareWorkspaceStub(namespace, {
				workspaceId: "w1",
				jurisdiction: "eu",
			}),
		).toBe("eu:w1");
		expect(
			cloudflareWorkspaceStub(namespace, {
				workspaceId: "w2",
				jurisdiction: "global",
			}),
		).toBe("global:w2");
		expect(selected).toEqual(["eu"]);
	});

	it("refuses a local jurisdiction on Cloudflare", () => {
		expect(() =>
			cloudflareWorkspaceStub(
				{ getByName: (name: string) => name },
				{ workspaceId: "w", jurisdiction: "local" as never },
			),
		).toThrow(/"eu" or "global"/);
	});

	it("addresses a self-hosted workspace by name alone", () => {
		expect(
			workerdWorkspaceStub(
				{ getByName: (name: string) => `disk:${name}` },
				"w3",
			),
		).toBe("disk:w3");
	});

	it("resolves the same object for the same id on the real namespace", async () => {
		const stub = cloudflareWorkspaceStub(testEnv.CLOUDFLARE_WORKSPACE, {
			workspaceId: "same-id",
			jurisdiction: "global",
		});
		const again = cloudflareWorkspaceStub(testEnv.CLOUDFLARE_WORKSPACE, {
			workspaceId: "same-id",
			jurisdiction: "global",
		});
		expect(stub.id.equals(again.id)).toBe(true);
	});
});
