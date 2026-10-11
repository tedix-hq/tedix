import { createRouterClient } from "@orpc/server";
import { masterKeyFingerprints } from "@tedix/db/utils/secrets-encryption";
import { describe, expect, it } from "vite-plus/test";
import type { BaseContext } from "../orpc";
import { organizationSecretsContractRouter } from "./organization-secrets";

const API_KEY = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=";
const OTHER_KEY = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=";

function tediService(
	respond: () => Promise<Response> | Response,
): Pick<Fetcher, "fetch"> {
	return {
		fetch: async (_url: unknown, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("X-Service-Binding")).toBe("true");
			return respond();
		},
	};
}

function relay(workers: unknown[]) {
	return tediService(() => Response.json({ workers }));
}

function client(
	auth: "platform-user" | "tenant-user" | "platform-key",
	env: Record<string, unknown>,
) {
	const context = {
		authType: auth === "platform-key" ? "apikey" : "user",
		db: {} as BaseContext["db"],
		env: { ENVIRONMENT: "test", ...env } as unknown as CloudflareEnv,
		headers: new Headers(),
		organizationId: "org-1",
		url: new URL("https://api.tedix.test/rpc/secrets"),
		...(auth === "platform-key"
			? {
					apiKey: {
						id: "key-1",
						name: "ops",
						organizationId: "org-1",
						scopes: ["platform:admin"],
					},
				}
			: {
					user: {
						aud: "test",
						dct: "tenant-1",
						exp: 2,
						iat: 1,
						iss: "https://auth.tedix.test",
						permissions: auth === "tenant-user" ? ["secrets:manage"] : [],
						roles: auth === "platform-user" ? ["platform-admin"] : ["admin"],
						sub: "user-1",
					},
				}),
	} as unknown as BaseContext;
	return createRouterClient(organizationSecretsContractRouter, { context });
}

describe("secrets.masterKeyFingerprints", () => {
	it("reports every Worker and consistent when they agree", async () => {
		const fingerprints = await masterKeyFingerprints(API_KEY);
		const result = await client("platform-user", {
			SECRETS_MASTER_KEY: API_KEY,
			TEDI_SERVICE: relay([
				{ worker: "tedi", fingerprints },
				{ worker: "tedi-runtime", fingerprints },
			]),
		}).masterKeyFingerprints({});
		expect(result).toEqual({
			workers: [
				{ worker: "api", fingerprints },
				{ worker: "tedi", fingerprints },
				{ worker: "tedi-runtime", fingerprints },
			],
			consistent: true,
		});
		expect(JSON.stringify(result)).not.toContain(API_KEY);
	});

	it("flags a Worker whose encrypting key differs", async () => {
		const result = await client("platform-key", {
			SECRETS_MASTER_KEY: `${API_KEY},${OTHER_KEY}`,
			TEDI_SERVICE: relay([
				{ worker: "tedi", fingerprints: await masterKeyFingerprints(API_KEY) },
				{
					worker: "tedi-runtime",
					fingerprints: await masterKeyFingerprints(OTHER_KEY),
				},
			]),
		}).masterKeyFingerprints({});
		expect(result.consistent).toBe(false);
		expect(result.workers.map((entry) => entry.worker)).toEqual([
			"api",
			"tedi",
			"tedi-runtime",
		]);
		expect(result.workers[0]?.fingerprints).toHaveLength(2);
	});

	it("reports an error entry and inconsistency when the fleet is unreachable", async () => {
		const result = await client("platform-user", {
			SECRETS_MASTER_KEY: API_KEY,
			TEDI_SERVICE: tediService(() => {
				throw new Error("connect failed");
			}),
		}).masterKeyFingerprints({});
		expect(result.consistent).toBe(false);
		expect(result.workers).toEqual([
			{ worker: "api", fingerprints: await masterKeyFingerprints(API_KEY) },
			{ worker: "tedi", fingerprints: [], error: "unreachable" },
			{ worker: "tedi-runtime", fingerprints: [], error: "unreachable" },
		]);
	});

	it("reports an unset API key and a relayed Worker error as inconsistent", async () => {
		const result = await client("platform-user", {
			TEDI_SERVICE: relay([
				{ worker: "tedi", fingerprints: await masterKeyFingerprints(API_KEY) },
				{ worker: "tedi-runtime", fingerprints: [], error: "unset" },
			]),
		}).masterKeyFingerprints({});
		expect(result.consistent).toBe(false);
		expect(result.workers[0]).toEqual({
			worker: "api",
			fingerprints: [],
			error: "unset",
		});
	});

	it("rejects a tenant admin", async () => {
		await expect(
			client("tenant-user", {
				SECRETS_MASTER_KEY: API_KEY,
				TEDI_SERVICE: relay([]),
			}).masterKeyFingerprints({}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
