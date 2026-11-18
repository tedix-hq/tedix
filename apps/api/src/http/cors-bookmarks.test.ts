import { Hono } from "hono";
import { expect, it } from "vite-plus/test";
import { registerCorsAndLimits } from "./cors-and-limits";

it("exposes bookmarks and timings to credentialed browser clients", async () => {
	const app = new Hono<{ Bindings: CloudflareEnv }>();
	registerCorsAndLimits(app);
	app.get("/bookmark", (c) =>
		c.text("ok", 200, {
			"x-d1-bookmark": "after-write",
			"Server-Timing": "api-rpc;dur=1",
		}),
	);
	const response = await app.request(
		"https://api.example/bookmark",
		{ headers: { Origin: "https://os.tedix.dev" } },
		{ API_URL: "https://api.example" } as CloudflareEnv,
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("Access-Control-Allow-Credentials")).toBe("true");
	expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
		"https://os.tedix.dev",
	);
	expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
		"x-d1-bookmark,Server-Timing",
	);
});
