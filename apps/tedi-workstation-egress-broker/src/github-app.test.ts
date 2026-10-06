import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	changeInstallationState,
	clearGitHubAppTokenCache,
	installationTokenForRepository,
	revokeCachedInstallationTokens,
	type GitHubAppEnv,
} from "./github-app";

const NOW = 1_800_000_000;
const SCOPE = {
	installationId: 987,
	repository: "tedix/tedix",
	repositoryId: 123,
};

async function testEnv(): Promise<GitHubAppEnv> {
	const pair = (await crypto.subtle.generateKey(
		{
			hash: "SHA-256",
			modulusLength: 2048,
			name: "RSASSA-PKCS1-v1_5",
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const key = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey),
	);
	let binary = "";
	for (const byte of key) binary += String.fromCharCode(byte);
	const body =
		btoa(binary)
			.match(/.{1,64}/g)
			?.join("\n") ?? "";
	const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
	return {
		GITHUB_APP_ENABLED: "true",
		GITHUB_APP_ID: "12345",
		GITHUB_APP_PRIVATE_KEY_PKCS8: `-----BEGIN ${privateKeyLabel}-----\n${body}\n-----END ${privateKeyLabel}-----`,
	};
}

function installationFetch(
	options: {
		expiresAt?: number;
		repository?: string;
		repositoryId?: number;
		token?: string;
	} = {},
): typeof fetch {
	return vi.fn(async (request: Request) => {
		if (request.url.endsWith("/app/installations/987/access_tokens")) {
			return Response.json({
				expires_at: new Date(
					(options.expiresAt ?? NOW + 3600) * 1000,
				).toISOString(),
				repositories: [
					{
						full_name: options.repository ?? "tedix/tedix",
						id: options.repositoryId ?? 123,
					},
				],
				token: options.token ?? "installation-secret",
			});
		}
		throw new Error(`unexpected request ${request.method} ${request.url}`);
	}) as typeof fetch;
}

describe("GitHub App installation tokens", () => {
	beforeEach(() => {
		clearGitHubAppTokenCache();
	});

	it("mints and memory-caches an exact repository-scoped token", async () => {
		const env = await testEnv();
		const fetchImpl = installationFetch();
		const first = await installationTokenForRepository(env, SCOPE, {
			fetchImpl,
			nowSeconds: NOW,
		});
		const second = await installationTokenForRepository(env, SCOPE, {
			fetchImpl,
			nowSeconds: NOW + 1,
		});

		expect(first).toMatchObject({
			source: "minted",
			value: {
				expiresAt: NOW + 3600,
				installationId: 987,
				repository: "tedix/tedix",
				repositoryId: 123,
				token: "installation-secret",
			},
		});
		expect(second.source).toBe("cache");
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const mint = (fetchImpl as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as Request;
		expect(mint.headers.get("Authorization")?.split(".")).toHaveLength(3);
		expect(mint.method).toBe("POST");
		expect(await mint.json()).toEqual({
			permissions: { contents: "write" },
			repository_ids: [123],
		});
	});

	it("measures the one-hour token ceiling when GitHub responds", async () => {
		const env = await testEnv();
		const now = vi.spyOn(Date, "now").mockReturnValue((NOW + 1) * 1000);

		const result = await installationTokenForRepository(env, SCOPE, {
			fetchImpl: installationFetch({ expiresAt: NOW + 3601 }),
			nowSeconds: NOW,
		});

		expect(result.source).toBe("minted");
		now.mockRestore();
	});

	it("refuses disabled, overlong, or repository-mismatched credentials", async () => {
		const env = await testEnv();
		const disabledFetch = installationFetch();
		await expect(
			installationTokenForRepository(
				{ ...env, GITHUB_APP_ENABLED: "false" },
				SCOPE,
				{ fetchImpl: disabledFetch, nowSeconds: NOW },
			),
		).rejects.toThrow("github_app_disabled");
		expect(disabledFetch).not.toHaveBeenCalled();

		await expect(
			installationTokenForRepository(env, SCOPE, {
				fetchImpl: installationFetch({ expiresAt: NOW + 3601 }),
				nowSeconds: NOW,
			}),
		).rejects.toThrow("github_app_token_invalid");
		await expect(
			installationTokenForRepository(env, SCOPE, {
				fetchImpl: installationFetch({ repository: "other/repo" }),
				nowSeconds: NOW,
			}),
		).rejects.toThrow("github_app_token_invalid");
		await expect(
			installationTokenForRepository(env, SCOPE, {
				fetchImpl: installationFetch({ repositoryId: 999 }),
				nowSeconds: NOW,
			}),
		).rejects.toThrow("github_app_token_invalid");
	});

	it("revokes tokens still held in the isolate before clearing them", async () => {
		const env = await testEnv();
		await installationTokenForRepository(env, SCOPE, {
			fetchImpl: installationFetch(),
			nowSeconds: NOW,
		});
		const revoke = vi.fn(
			async () => new Response(null, { status: 204 }),
		) as typeof fetch;

		await revokeCachedInstallationTokens(revoke);

		expect(revoke).toHaveBeenCalledTimes(1);
		const request = (revoke as ReturnType<typeof vi.fn>).mock
			.calls[0]?.[0] as Request;
		expect(request.method).toBe("DELETE");
		expect(request.url).toBe("https://api.github.com/installation/token");
		expect(request.headers.get("Authorization")).toBe(
			"Bearer installation-secret",
		);
	});

	it("retains a cached token and reports a failed revocation", async () => {
		const env = await testEnv();
		const mint = installationFetch();
		await installationTokenForRepository(env, SCOPE, {
			fetchImpl: mint,
			nowSeconds: NOW,
		});
		await expect(
			revokeCachedInstallationTokens(
				vi.fn(async () => new Response(null, { status: 503 })) as typeof fetch,
			),
		).rejects.toThrow("github_app_token_revocation_failed");

		const cached = await installationTokenForRepository(env, SCOPE, {
			fetchImpl: mint,
			nowSeconds: NOW + 1,
		});
		expect(cached.source).toBe("cache");
		expect(mint).toHaveBeenCalledTimes(1);
	});

	it.each([
		["suspend", "PUT", "/app/installations/987/suspended"],
		["uninstall", "DELETE", "/app/installations/987"],
	] as const)(
		"uses App JWT authority to %s an installation",
		async (action, method, path) => {
			const env = await testEnv();
			const fetchImpl = vi.fn(
				async () => new Response(null, { status: 204 }),
			) as typeof fetch;

			await changeInstallationState(env, 987, action, fetchImpl);

			const request = (fetchImpl as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0] as Request;
			expect(request.method).toBe(method);
			expect(request.url).toBe(`https://api.github.com${path}`);
			expect(request.headers.get("Authorization")?.split(".")).toHaveLength(3);
		},
	);

	it("reports a failed installation incident action", async () => {
		const env = await testEnv();
		await expect(
			changeInstallationState(
				env,
				987,
				"suspend",
				vi.fn(
					async () => new Response("denied", { status: 403 }),
				) as typeof fetch,
			),
		).rejects.toThrow("github_app_incident_403");
	});
});
