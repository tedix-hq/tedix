import { env } from "cloudflare:workers";
import { runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it, vi } from "vite-plus/test";
import { mintWorkspaceAppSession } from "@tedix/auth/workspace-app-session";
import type { WorkspaceAppHostDO } from "../../src/workspace-app-host-do";
import { appRuntimeCodeDigest } from "@tedix/api-contract/utils/app-runtime";

const gadgetId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";
const namespace = (
	env as unknown as {
		WORKSPACE_APP_HOST: DurableObjectNamespace<WorkspaceAppHostDO>;
	}
).WORKSPACE_APP_HOST;
const hostWorkspaces = new WeakMap<object, string>();
function createHost() {
	const id = crypto.randomUUID();
	const stub = namespace.getByName(`fictional-org:${id}`);
	hostWorkspaces.set(stub, id);
	return stub;
}
const files = (version: string) => ({
	"client.js": "",
	"server.js": `
import { DurableObject } from 'cloudflare:workers';
let retained;
export class App extends DurableObject {
  count() { const n = (this.ctx.storage.kv.get('n') || 0) + 1; this.ctx.storage.kv.put('n', n); return {n, version: '${version}'}; }
  readHost() { return this.ctx.storage.kv.get('hostSecret') ?? null; }
  async network() { try { await fetch('https://example.com'); return 'escaped'; } catch { return 'blocked'; } }
  async importEnv() { try { const { env } = await import('cloudflare:workers'); return env.SECRETS_MASTER_KEY || env.LOADER || env.API_SERVICE || env.TEDIX ? 'escaped' : 'blocked'; } catch { return 'blocked'; } }
  async build() { return await this.env.TEDIX.outputsWrite('sheet', {}); }
  remember() { retained = this.env.TEDIX.dup(); return true; }
  async reuse() { try { return await retained.outputsWrite('sheet', {}); } finally { retained[Symbol.dispose](); retained = null; } }
}`,
});
async function call(
	stub: DurableObjectStub<WorkspaceAppHostDO>,
	options: {
		gadget?: string;
		revision?: string;
		version?: string;
		method?: string;
		role?: "build" | "use";
		previewId?: string;
	} = {},
) {
	const code = files(options.version ?? "v1");
	const { token } = await mintWorkspaceAppSession("fictional-app-test-key", {
		organizationId: "fictional-org",
		workspaceId: hostWorkspaces.get(stub)!,
		gadgetId: options.gadget ?? gadgetId,
		revisionId: options.revision ?? revisionId,
		revision: options.revision ? 2 : 1,
		role: options.role ?? "use",
		principal: { kind: "user", id: "fictional-member" },
		grants: [{ slot: "sheet", operations: ["outputs.read", "outputs.write"] }],
		previewId: options.previewId,
		codeDigest: await appRuntimeCodeDigest(code),
	});
	return stub.call({
		session: token,
		files: code,
		method: options.method ?? "count",
		args: [],
	});
}
describe("workspace app supervisor in workerd", () => {
	it("isolates app SQLite from sibling apps and the supervisor", async () => {
		const stub = createHost();
		await runInDurableObject(stub, (_instance, state) => {
			state.storage.kv.put("hostSecret", "parent-only");
		});
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
		expect(
			await call(stub, { gadget: "44444444-4444-4444-8444-444444444444" }),
		).toEqual({ n: 1, version: "v1" });
		expect(await call(stub, { method: "readHost" })).toBe(null);
	});
	it("aborts old code on revision changes and preserves app SQLite", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(
			await call(stub, {
				revision: "55555555-5555-4555-8555-555555555555",
				version: "v2",
			}),
		).toEqual({ n: 2, version: "v2" });
	});
	it("gives a preview its own SQLite", async () => {
		const stub = createHost();
		expect(await call(stub)).toEqual({ n: 1, version: "v1" });
		expect(
			await call(stub, { previewId: "66666666-6666-4666-8666-666666666666" }),
		).toEqual({ n: 1, version: "v1" });
		expect(await call(stub)).toEqual({ n: 2, version: "v1" });
	});
	it("blocks global fetch and refuses build operations for a use session", async () => {
		const stub = createHost();
		expect(await call(stub, { method: "network" })).toBe("blocked");
		expect(await call(stub, { method: "importEnv" })).toBe("blocked");
		await expect(call(stub, { method: "build" })).rejects.toThrow(
			/outputsWrite/,
		);
	});
	it("does not retain build authority when the next caller has use access", async () => {
		const stub = createHost();
		expect(await call(stub, { method: "build", role: "build" })).toEqual({
			recorded: true,
		});
		await expect(call(stub, { method: "build", role: "use" })).rejects.toThrow(
			/outputsWrite/,
		);
		expect(await call(stub, { method: "remember", role: "build" })).toBe(true);
		await expect(call(stub, { method: "reuse", role: "use" })).rejects.toThrow(
			"App capability expired",
		);
	});
	it("durably queues failed trace writes and redrives them through an alarm", async () => {
		const stub = createHost();
		await call(stub);
		const tailId = crypto.randomUUID();
		await stub.recordTail({
			tailId,
			organizationId: "fictional-org",
			workspaceId: hostWorkspaces.get(stub)!,
			gadgetId,
			revisionId,
			events: [{ outcome: "fixture_unavailable" }],
		});
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, async (_instance, state) => {
					const pending = await state.storage.get(`app-tail:${tailId}`);
					return Boolean(pending) && (await state.storage.getAlarm()) !== null;
				}),
			).toBe(true),
		);
		await runInDurableObject(stub, async (_instance, state) => {
			const key = `app-tail:${tailId}`;
			const trace = await state.storage.get<Record<string, unknown>>(key);
			await state.storage.put(key, { ...trace, events: [{ outcome: "ok" }] });
		});
		await runDurableObjectAlarm(stub);
		await vi.waitFor(async () =>
			expect(
				await runInDurableObject(stub, (_instance, state) =>
					state.storage.get(`app-tail:${tailId}`),
				),
			).toBeUndefined(),
		);
	});
});
