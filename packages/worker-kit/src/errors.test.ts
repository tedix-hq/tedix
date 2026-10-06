import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Hono } from "hono";
import { installHonoErrorHandlers } from "./errors";

afterEach(() => vi.restoreAllMocks());

describe("shared Hono error handler", () => {
	test("returns a stable JSON 404 envelope", async () => {
		const app = new Hono();
		installHonoErrorHandlers(app, { service: "test" });
		const response = await app.request("https://example.test/missing");
		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toEqual({
			error: "not_found",
			message: "Not Found",
			path: "/missing",
		});
	});

	test("hides unexpected error details", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const app = new Hono();
		app.get("/boom", () => {
			throw new Error("secret implementation detail");
		});
		installHonoErrorHandlers(app, { service: "test" });
		const response = await app.request("https://example.test/boom");
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toEqual({
			error: "internal_error",
			message: "Internal Server Error",
		});
	});

	test("logs a structured cause while keeping the public 500 generic", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		const app = new Hono();
		installHonoErrorHandlers(app, { service: "test.worker" });
		app.get("/boom", () => {
			throw new Error("outer", { cause: new TypeError("inner") });
		});

		const response = await app.request("/boom");
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: "internal_error",
			message: "Internal Server Error",
		});
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[0]).toMatchObject({
			component: "test.worker",
			event: "request.failed",
			message: "Request failed",
			exception: {
				type: "Error",
				message: "outer",
				cause: { type: "TypeError", message: "inner" },
			},
		});
	});
});
