const assert = {
	equal(actual: unknown, expected: unknown) {
		if (actual !== expected)
			throw new Error(
				`Expected ${String(expected)}, received ${String(actual)}`,
			);
	},
};
import { invalidateConfig, type ProvisioningConfig } from "./index";
for (const [body, status, expected] of [
	[{ ok: true }, 200, true],
	[{ ok: false }, 200, false],
	[{}, 200, false],
	[{ success: true }, 200, false],
	[{ error: "missing" }, 404, false],
] as const) {
	const config: ProvisioningConfig = {
		workerUrl: "https://tedi",
		fetcher: {
			fetch: (async (url, init) => {
				assert.equal(String(url), "https://tedi/api/admin/invalidate-config");
				assert.equal(init?.method, "POST");
				assert.equal(
					new Headers(init?.headers).get("X-Service-Binding"),
					"true",
				);
				return Response.json(body, { status });
			}) as typeof fetch,
		},
	};
	assert.equal(await invalidateConfig(config), expected);
}
console.log("config invalidation requires a successful runtime receipt");
