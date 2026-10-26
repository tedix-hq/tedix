import { describe, expect, it, vi } from "vite-plus/test";
import { validateAppSource } from "./os-app-validation";

const files = { "server.js": "export class App {}", "client.js": "" };
function fixture(status = 200, body = "valid") {
	const fetch = vi.fn(async () => new Response(body, { status }));
	return {
		fetch,
		env: { TEDI_SERVICE: { fetch } } as unknown as CloudflareEnv,
	};
}
describe("app source validation", () => {
	it.each(["server.js", "client.js", "helper.js"])(
		"refuses broken %s with file, line and column before a runtime call",
		async (path) => {
			const f = fixture();
			await expect(
				validateAppSource(f.env, {
					...files,
					[path]: "// first line\nconst value = ;",
				}),
			).rejects.toMatchObject({
				code: "BAD_REQUEST",
				message: expect.stringContaining(`${path}:2:15:`),
			});
			expect(f.fetch).not.toHaveBeenCalled();
		},
	);
	it("parses modern modules and dry-loads before a write", async () => {
		const f = fixture();
		await validateAppSource(f.env, {
			...files,
			"helper.js": "export const value = {nested: 1}?.nested ?? 0;",
			"settings.json": "{}",
		});
		expect(f.fetch).toHaveBeenCalledOnce();
	});
	it("propagates dry-load diagnostics", async () => {
		const f = fixture(400, "server.js:3:4: missing import");
		await expect(validateAppSource(f.env, files)).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "server.js:3:4: missing import",
		});
	});
	it("fails closed when the runtime cannot validate", async () => {
		const f = fixture(503);
		await expect(validateAppSource(f.env, files)).rejects.toMatchObject({
			code: "BAD_GATEWAY",
		});
	});
});
