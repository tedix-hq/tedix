import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
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
	it("links a real App and its local imports without constructing it", async () => {
		const response = await validate(
			"import { value } from './helper.js'; export class App { constructor() { throw new Error('must not run'); } count() { return value; } }",
			{ "helper.js": "export const value = 1;" },
		);
		expect(response.status).toBe(200);
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
