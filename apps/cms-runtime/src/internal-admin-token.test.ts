import { describe, expect, test } from "vite-plus/test";
import type { Env } from "./env";
import { verifyInternalCmsRequest } from "./internal-admin-http";

const env = { CMS_INTERNAL_AUTH_TOKEN: "internal-token" } as Env;
const request = (headers: Record<string, string>) =>
	new Request("https://cms.internal/admin", { headers });

describe("internal admin token", () => {
	test("accepts the token on either header", async () => {
		expect(
			await verifyInternalCmsRequest(
				request({ "X-Tedix-CMS-Internal-Auth": "internal-token" }),
				env,
			),
		).toBe(true);
		expect(
			await verifyInternalCmsRequest(
				request({ Authorization: "Bearer internal-token" }),
				env,
			),
		).toBe(true);
	});

	test("refuses a wrong, partial or missing token", async () => {
		const refused: Record<string, string>[] = [
			{},
			{ "X-Tedix-CMS-Internal-Auth": "internal-toke" },
			{ "X-Tedix-CMS-Internal-Auth": "internal-token-extra" },
			{ Authorization: "Bearer wrong" },
			{ Authorization: "internal-token" },
		];
		for (const headers of refused) {
			expect(await verifyInternalCmsRequest(request(headers), env)).toBe(false);
		}
	});

	test("fails closed when no token is configured", async () => {
		for (const unset of [{}, { CMS_INTERNAL_AUTH_TOKEN: "" }]) {
			expect(
				await verifyInternalCmsRequest(
					request({ "X-Tedix-CMS-Internal-Auth": "" }),
					unset as Env,
				),
			).toBe(false);
			expect(
				await verifyInternalCmsRequest(
					request({ Authorization: "Bearer " }),
					unset as Env,
				),
			).toBe(false);
		}
	});
});
