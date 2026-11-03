import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { handleWorkspaceAppValidate } from "../../src/workspace-app-route";

function validate(server: string, extra: Record<string, string> = {}) {
	return handleWorkspaceAppValidate(
		new Request("https://runtime/__internal/workspace-app/validate", {
			method: "POST",
			headers: {
				"X-Service-Binding": "true",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				files: { "server.js": server, "client.js": "", ...extra },
			}),
		}),
		env as unknown as { LOADER: WorkerLoader },
	);
}

describe("app dry-load", () => {
	it("keeps fresh validation IDs, lazy manifests and exact loader results", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const keys: string[] = [];
		const factories: Array<() => unknown> = [];
		const response = new Response("fixture-result");
		const request = () =>
			new Request("https://runtime/validate", {
				method: "POST",
				headers: {
					"X-Service-Binding": "true",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					files: { "server.js": "export class App {}", "client.js": "" },
				}),
			});
		const loader = {
			get(key: string, factory: () => unknown) {
				keys.push(key);
				factories.push(factory);
				return { getEntrypoint: () => ({ fetch: async () => response }) };
			},
		};
		try {
			for (let i = 0; i < 2; i++)
				expect(
					await handleWorkspaceAppValidate(request(), {
						LOADER: loader as never,
					}),
				).toBe(response);
			expect(keys[0]).toMatch(/^validate:[0-9a-f-]{36}$/);
			expect(keys[1]).not.toBe(keys[0]);
			expect(factories).toHaveLength(2);
			expect(log.mock.calls.map(([value]) => JSON.parse(value))).toEqual(
				["attempted", "returned", "attempted", "returned"].map((phase) => ({
					event: "tedix.dynamic_worker.loader_call",
					version: 1,
					surface: "workspace_app_validation",
					reason: "workspace_app_validation",
					method: "get",
					identity: "named",
					phase,
				})),
			);
		} finally {
			log.mockRestore();
		}
	});
	it("links a real App and its local imports without constructing it", async () => {
		const response = await validate(
			"import { value } from './helper.js'; export class App { constructor() { throw new Error('must not run'); } count() { return value; } }",
			{ "helper.js": "export const value = 1;" },
		);
		expect(response.status).toBe(200);
	});
	it("dry-loads supported text and JSON source files as exact importable strings", async () => {
		const response = await validate(
			"import notes from './notes.txt'; import settings from './settings.json'; if (notes !== 'Draft notes' || typeof settings !== 'string' || JSON.parse(settings).label !== 'Review') throw new Error('wrong asset module'); export class App {}",
			{ "notes.txt": "Draft notes", "settings.json": '{"label":"Review"}' },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ valid: true });
	});
	it.each([
		"export class Other {}",
		"export const App = 1;",
		"export function App() {}",
		"import './missing.js'; export class App {}",
		"throw new Error('broken initialization'); export class App {}",
		"await fetch('https://example.test/'); export class App {}",
	])("refuses an unloadable app: %s", async (server) => {
		const response = await validate(server);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("server.js:1:1:");
	});
	it("cannot read parent secrets or bindings through importable env", async () => {
		const response = await validate(
			"import { env } from 'cloudflare:workers'; if (env.SECRETS_MASTER_KEY || env.LOADER || env.API_SERVICE) throw new Error('escaped'); export class App {}",
		);
		expect(response.status).toBe(200);
	});
	it("refuses an untrusted caller before loading code", async () => {
		const response = await handleWorkspaceAppValidate(
			new Request("https://runtime/", { method: "POST" }),
			env as unknown as { LOADER: WorkerLoader },
		);
		expect(response.status).toBe(403);
	});
});
