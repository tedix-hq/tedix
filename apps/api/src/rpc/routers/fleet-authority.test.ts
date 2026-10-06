import { createRouterClient } from "@orpc/server";
import { describe, expect, test, vi } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { waitlistContractRouter } from "./waitlist";

describe("fleet-commercial router guard", () => {
	test("disabled mode fails before tenant DB or provider configuration access", async () => {
		const env = {
			TEDIX_FLEET_AUTHORITY_MODE: "disabled",
			get DESCOPE_MANAGEMENT_KEY(): string {
				throw new Error("provider secret must not be read");
			},
		} as unknown as CloudflareEnv;
		const context = {
			authType: "user",
			db: new Proxy(
				{},
				{
					get: () => {
						throw new Error("tenant DB must not be read");
					},
				},
			) as BaseContext["db"],
			env,
			headers: new Headers(),
			rateLimiter: {
				limit: vi.fn(async () => ({ success: true })),
			} as unknown as RateLimit,
			url: new URL("https://api.example.invalid/rpc/waitlist"),
			user: { sub: "operator" },
			userRole: "platform-admin",
		} as BaseContext;
		const client = createRouterClient(waitlistContractRouter, { context });

		await expect(client.list({ limit: 10, page: 0 })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});
});
