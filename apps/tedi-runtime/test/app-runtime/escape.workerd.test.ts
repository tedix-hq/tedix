import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vite-plus/test";
import {
	mintWorkspaceAppSession,
	type WorkspaceAppSession,
} from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";

/**
 * Hostile app code against the workspace app host. Each server.js below tries
 * to reach something an app must not: inherited or lifecycle methods, the
 * host isolate, bindings, the network, another app's storage, another
 * tenant's host, or authority beyond its signed session.
 */

const key = "fictional-app-test-key";
const gadgetId = "22222222-2222-4222-8222-222222222222";
const otherGadgetId = "44444444-4444-4444-8444-444444444444";
const revisionId = "33333333-3333-4333-8333-333333333333";
const namespace = (
	env as unknown as {
		WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
	}
).WORKSPACE_APP_HOST;

const hostileServer = (marker = "v1") => `
import { DurableObject } from 'cloudflare:workers';
class Base extends DurableObject {
  inheritedSecret() { return 'leaked-from-base'; }
}
let stolen;
export class App extends Base {
  marker() { return '${marker}'; }
  get getterMethod() { return 'leaked-getter'; }
  envKeys() { return Object.keys(this.env).sort(); }
  globals() {
    return ['LOADER', 'SECRETS_MASTER_KEY', 'API_SERVICE', 'WORKSPACE_APP_HOST', 'TEDI_RUNTIME_SERVICE', 'DB']
      .filter((name) => name in globalThis);
  }
  pollute() {
    Object.prototype.polluted = 'yes';
    Array.prototype.includes = () => true;
    JSON.parse = () => ({ allowed: true });
    return true;
  }
  pollutedHere() { return ({}).polluted ?? null; }
  async socket() {
    try {
      const { connect } = await import('cloudflare:sockets');
      const socket = connect({ hostname: 'example.com', port: 80 });
      await socket.opened;
      return 'escaped';
    } catch { return 'blocked'; }
  }
  async fetchRelative() { try { await fetch('http://api/rpc/osAppRuntime/capability', { method: 'POST' }); return 'escaped'; } catch { return 'blocked'; } }
  async readUngranted() { return await this.env.TEDIX.outputsRead('other', null); }
  async writeReadOnlyGrant() { return await this.env.TEDIX.outputsWrite('sheet', {}); }
  async patchReadOnlyGrant() { return await this.env.TEDIX.outputsPatch('sheet', {}); }
  async readGranted() { return await this.env.TEDIX.outputsRead('sheet', null); }
  async capabilityInternals() {
    const cap = this.env.TEDIX;
    const probes = {};
    for (const name of ['endpoint', '#endpoint', 'token', 'props', 'env', 'ctx']) {
      try { const value = await cap[name]; probes[name] = value === undefined ? 'undefined' : typeof value; }
      catch { probes[name] = 'refused'; }
    }
    return probes;
  }
  async closeThenUse() {
    const cap = this.env.TEDIX;
    await cap.close();
    try { await cap.outputsRead('sheet', null); return 'still-open'; } catch (error) { return String(error.message); }
  }
  async holdCapability() {
    stolen = this.env.TEDIX;
    await scheduler.wait(50);
    return true;
  }
  async useHeldCapability() {
    try { return await stolen.outputsWrite('sheet', {}); }
    catch (error) { return 'denied: ' + error.message; }
  }
}`;

function filesFor(marker = "v1") {
	return { "client.js": "", "server.js": hostileServer(marker) };
}

type Session = Partial<WorkspaceAppSession> & {
	files?: Record<string, string>;
	method: string;
	signWith?: string;
	digestOf?: Record<string, string>;
};

async function prepare(workspaceId: string, options: Session) {
	const files = options.files ?? filesFor();
	const { files: _files, method, signWith, digestOf, ...overrides } = options;
	const { token } = await mintWorkspaceAppSession(signWith ?? key, {
		organizationId: "fictional-org",
		workspaceId,
		gadgetId,
		revisionId,
		revision: 1,
		role: "use",
		principal: { kind: "user", id: "fictional-member" },
		grants: [{ slot: "sheet", operations: ["outputs.read"] }],
		codeDigest: await appRuntimeCodeDigest(digestOf ?? files),
		...overrides,
	});
	return { session: token, files, method, args: [] };
}

async function call(
	stub: DurableObjectStub<WorkspaceAppHostDO>,
	workspaceId: string,
	options: Session,
) {
	return stub.call(await prepare(workspaceId, options));
}

function host(organizationId = "fictional-org") {
	const workspaceId = crypto.randomUUID();
	return {
		workspaceId,
		stub: namespace.getByName(`${organizationId}:${workspaceId}`),
	};
}

describe("hostile app code in the workspace app host", () => {
	it("dispatches only to the app's own methods", async () => {
		const { stub, workspaceId } = host();
		expect(await call(stub, workspaceId, { method: "marker" })).toBe("v1");
		for (const method of [
			"inheritedSecret",
			"getterMethod",
			"toString",
			"hasOwnProperty",
			"fetch",
			"invoke",
		])
			await expect(call(stub, workspaceId, { method }), method).rejects.toThrow(
				/Unknown app method/,
			);
		for (const method of ["constructor", "__proto__", "alarm", "a.b", ""])
			await expect(
				call(stub, workspaceId, { method }),
				method,
			).rejects.toThrow();
	});

	it("hands the app only CONFIG and its capability, with no bindings in scope", async () => {
		const { stub, workspaceId } = host();
		expect(await call(stub, workspaceId, { method: "envKeys" })).toEqual([
			"CONFIG",
			"TEDIX",
		]);
		expect(await call(stub, workspaceId, { method: "globals" })).toEqual([]);
	});

	it("has no outbound network: sockets and service-shaped URLs are refused", async () => {
		const { stub, workspaceId } = host();
		expect(await call(stub, workspaceId, { method: "socket" })).toBe("blocked");
		expect(await call(stub, workspaceId, { method: "fetchRelative" })).toBe(
			"blocked",
		);
	});

	it("keeps prototype pollution inside the app's own isolate", async () => {
		const { stub, workspaceId } = host();
		expect(await call(stub, workspaceId, { method: "pollute" })).toBe(true);
		expect(await call(stub, workspaceId, { method: "pollutedHere" })).toBe(
			"yes",
		);
		// The host still parses sessions, checks the matrix and refuses ungranted reads.
		await expect(
			call(stub, workspaceId, { method: "writeReadOnlyGrant", role: "build" }),
		).rejects.toThrow("App capability denied");
		await runInDurableObject(stub, () => {
			expect(({} as { polluted?: string }).polluted).toBeUndefined();
			expect([1].includes(2)).toBe(false);
		});
		const sibling = { gadgetId: otherGadgetId };
		expect(
			await call(stub, workspaceId, { method: "pollutedHere", ...sibling }),
		).toBeNull();
	});

	it("checks the slot and the grant's operation in the host before any API call", async () => {
		const { stub, workspaceId } = host();
		await expect(
			call(stub, workspaceId, { method: "readUngranted" }),
		).rejects.toThrow("App capability denied");
		await expect(
			call(stub, workspaceId, { method: "writeReadOnlyGrant", role: "build" }),
		).rejects.toThrow("App capability denied");
		// A use session never even receives the write method.
		await expect(
			call(stub, workspaceId, {
				method: "writeReadOnlyGrant",
				grants: [{ slot: "sheet", operations: ["outputs.write"] }],
			}),
		).rejects.toThrow(/outputsWrite/);
		await expect(
			call(stub, workspaceId, { method: "patchReadOnlyGrant", role: "build" }),
		).rejects.toThrow("App capability denied");
		await expect(
			call(stub, workspaceId, {
				method: "patchReadOnlyGrant",
				grants: [{ slot: "sheet", operations: ["outputs.patch"] }],
			}),
		).rejects.toThrow(/outputsPatch/);
		expect(await call(stub, workspaceId, { method: "readGranted" })).toEqual({
			recorded: true,
		});
	});

	it("exposes no endpoint, token or props through the capability object", async () => {
		const { stub, workspaceId } = host();
		const probes = (await call(stub, workspaceId, {
			method: "capabilityInternals",
		})) as Record<string, string>;
		for (const [name, result] of Object.entries(probes))
			expect(["undefined", "refused"], name).toContain(result);
		expect(await call(stub, workspaceId, { method: "closeThenUse" })).toBe(
			"App capability expired",
		);
	});

	it("serializes callers so a held build capability is dead before a use caller runs", async () => {
		const { stub, workspaceId } = host();
		// Sign both first so the build caller provably enters before the use caller.
		const build = await prepare(workspaceId, {
			method: "holdCapability",
			role: "build",
		});
		const use = await prepare(workspaceId, { method: "useHeldCapability" });
		const [held, used] = await Promise.all([stub.call(build), stub.call(use)]);
		expect(held).toBe(true);
		// Either the host closed it or the runtime disposed the stub: never usable.
		expect(used).toMatch(
			/^denied: (App capability expired|RPC stub used after being disposed)/,
		);
	});

	it("refuses sessions it did not sign, viewers, and code that does not match the signature", async () => {
		const { stub, workspaceId } = host();
		await expect(
			call(stub, workspaceId, { method: "marker", signWith: "forged-key" }),
		).rejects.toThrow();
		await expect(
			call(stub, workspaceId, { method: "marker", role: "viewer" }),
		).rejects.toThrow("App interaction requires use access");
		await expect(
			call(stub, workspaceId, {
				method: "marker",
				files: filesFor("tampered"),
				digestOf: filesFor("signed"),
			}),
		).rejects.toThrow("App code does not match the signed revision");
		const smuggled = {
			...filesFor(),
			"__tedix_invocation.js": "export class AppInvocation {}",
		};
		await expect(
			call(stub, workspaceId, { method: "marker", files: smuggled }),
		).rejects.toThrow();
	});

	it("never serves cached code that differs from the signed files", async () => {
		const { stub, workspaceId } = host();
		expect(
			await call(stub, workspaceId, { method: "marker", files: filesFor("a") }),
		).toBe("a");
		// Same app, same revision number, different signed files.
		expect(
			await call(stub, workspaceId, { method: "marker", files: filesFor("b") }),
		).toBe("b");
	});

	it("binds a host to one tenant workspace", async () => {
		const { stub, workspaceId } = host();
		expect(await call(stub, workspaceId, { method: "marker" })).toBe("v1");
		await expect(
			call(stub, workspaceId, {
				method: "marker",
				organizationId: "fictional-other-org",
			}),
		).rejects.toThrow("Workspace host scope mismatch");
		await expect(
			call(stub, crypto.randomUUID(), { method: "marker" }),
		).rejects.toThrow("Workspace host scope mismatch");
		const traced = await stub
			.recordTail({
				tailId: crypto.randomUUID(),
				organizationId: "fictional-other-org",
				workspaceId,
				gadgetId,
				revisionId,
				events: [],
			})
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(String(traced)).toContain("Workspace trace scope mismatch");
	});

	it("routes only service-binding calls with a valid session to the host", async () => {
		const self = (exports as unknown as { default: Fetcher }).default;
		const url = "https://tedi-runtime/__internal/workspace-app/call";
		expect((await self.fetch(url, { method: "POST", body: "{}" })).status).toBe(
			403,
		);
		expect(
			(
				await self.fetch(url, {
					method: "POST",
					headers: { "X-Service-Binding": "true" },
					body: JSON.stringify({ session: "not-a-token" }),
				})
			).status,
		).toBe(403);
		const { token } = await mintWorkspaceAppSession("forged-key", {
			organizationId: "fictional-org",
			workspaceId: crypto.randomUUID(),
			gadgetId,
			revisionId,
			revision: 1,
			role: "build",
			principal: { kind: "user", id: "fictional-member" },
			grants: [],
		});
		expect(
			(
				await self.fetch(url, {
					method: "POST",
					headers: { "X-Service-Binding": "true" },
					body: JSON.stringify({ session: token }),
				})
			).status,
		).toBe(403);
	});
});
