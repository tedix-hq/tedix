import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { clearGitHubAppTokenCache } from "./github-app";
import { brokerHealth, handleRequest } from "./index";

const worker = exports.default;
const ARTIFACTS_HOST = `${"a".repeat(32)}.artifacts.cloudflare.net`;

function routeInit(headers: Record<string, string> = {}): RequestInit {
	return {
		headers: {
			"X-Tedix-Workstation-Egress-Route-Id": "vendor_proxy",
			"X-Tedix-Workstation-Egress-Route-Ref": "workstation-egress-proxy",
			"X-Tedix-Workstation-Egress-Route-Type": "proxy",
			"X-Tedix-Workstation-Egress-Route-Hosts": '["api.vendor.com"]',
			"X-Tedix-Workstation-Egress-Route-Ports": "[443]",
			...headers,
		},
	};
}

function githubRouteInit(headers: Record<string, string> = {}): RequestInit {
	return {
		headers: {
			"X-Tedix-Workstation-Egress-Credential-Provider": "github_app",
			"X-Tedix-Workstation-Egress-Attempt-Id": "attempt_test",
			"X-Tedix-Workstation-Egress-GitHub-Installation-Id": "987",
			"X-Tedix-Workstation-Egress-GitHub-Repository": "tedix/tedix",
			"X-Tedix-Workstation-Egress-GitHub-Repository-Id": "123",
			"X-Tedix-Workstation-Egress-Lease-Id": "lease_test",
			"X-Tedix-Workstation-Egress-Organization-Id": "org_test",
			"X-Tedix-Workstation-Egress-Route-Hosts": '["github.com"]',
			"X-Tedix-Workstation-Egress-Route-Id": "github-git-transport",
			"X-Tedix-Workstation-Egress-Route-Ports": "[443]",
			"X-Tedix-Workstation-Egress-Route-Ref": "workstation-egress-proxy",
			"X-Tedix-Workstation-Egress-Route-Type": "proxy",
			"X-Tedix-Workstation-Egress-Tedi-Id": "tedi_test",
			"X-Tedix-Workstation-Egress-Work-Item-Id": "work_test",
			"X-Tedix-Workstation-Egress-Workstation-Id": "ws_test",
			...headers,
		},
	};
}

function artifactsRouteInit(headers: Record<string, string> = {}): RequestInit {
	return {
		headers: {
			"X-Tedix-Workstation-Egress-Credential-Provider": "artifacts_token",
			"X-Tedix-Workstation-Egress-Route-Id": "artifacts-git-transport",
			"X-Tedix-Workstation-Egress-Route-Ref": "workstation-egress-proxy",
			"X-Tedix-Workstation-Egress-Route-Type": "proxy",
			"X-Tedix-Workstation-Egress-Route-Hosts": JSON.stringify([
				ARTIFACTS_HOST,
			]),
			"X-Tedix-Workstation-Egress-Route-Ports": "[443]",
			"X-Tedix-Workstation-Egress-Artifacts-Repository-Path":
				"/git/example-namespace/sample-theme.git",
			...headers,
		},
	};
}

async function githubAppPrivateKey(): Promise<string> {
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
	const bytes = new Uint8Array(
		await crypto.subtle.exportKey("pkcs8", pair.privateKey),
	);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const privateKeyLabel = ["PRIVATE", "KEY"].join(" ");
	return `-----BEGIN ${privateKeyLabel}-----\n${btoa(binary)}\n-----END ${privateKeyLabel}-----`;
}

describe("workstation egress broker", () => {
	afterEach(() => {
		clearGitHubAppTokenCache();
		vi.restoreAllMocks();
	});

	it("reports health", async () => {
		const response = await worker.fetch("https://broker.example/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			deployedSha: env.GIT_SHA ?? "unknown",
			service: "tedi-workstation-egress-broker",
			status: "ok",
		});
	});

	it("reports the exact deployed SHA when stamped", () => {
		expect(brokerHealth("0123456789abcdef")).toMatchObject({
			deployedSha: "0123456789abcdef",
		});
	});

	it("fails closed when route type is missing", async () => {
		const response = await worker.fetch(
			"https://api.vendor.com/v1?token=secret",
		);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toContain("missing_route_type");
		expect(body).not.toContain("token=secret");
	});

	it("rejects unsupported private routes before forwarding", async () => {
		const response = await worker.fetch(
			"https://10.0.0.5/status?token=secret",
			routeInit({
				"X-Tedix-Workstation-Egress-Route-Type": "private",
			}),
		);

		expect(response.status).toBe(400);
		const body = await response.text();
		expect(body).toContain("unsupported_route_type");
		expect(body).not.toContain("token=secret");
		expect(body).not.toContain("proxy-secret");
	});

	it("fails closed for proxy routes when Route-Hosts header is missing", async () => {
		const response = await worker.fetch(
			"https://api.vendor.com/v1?token=secret",
			routeInit({
				"X-Tedix-Workstation-Egress-Route-Hosts": "",
			}),
		);

		// Empty string is not valid JSON array — treated as unconfigured
		expect(response.status).toBe(403);
		const body = await response.text();
		expect(body).toContain("proxy_route_unconfigured");
		expect(body).not.toContain("token=secret");
		expect(body).not.toContain("proxy-secret");
	});

	it("fails closed when Route-Hosts header is absent", async () => {
		const response = await worker.fetch(
			"https://api.vendor.com/v1?token=secret",
			{
				headers: {
					"X-Tedix-Workstation-Egress-Route-Type": "proxy",
					"X-Tedix-Workstation-Egress-Proxy-Credential": "proxy-secret",
				},
			},
		);

		expect(response.status).toBe(403);
		const body = await response.text();
		expect(body).toContain("proxy_route_unconfigured");
		expect(body).not.toContain("token=secret");
		expect(body).not.toContain("proxy-secret");
	});

	it("blocks internal targets even when route is configured", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await worker.fetch(
			"https://api.tedix.dev/rpc?token=secret",
			routeInit(),
		);

		expect(response.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const body = await response.text();
		expect(body).toContain("target_blocked");
		expect(body).not.toContain("token=secret");
		expect(body).not.toContain("proxy-secret");
	});

	it("blocks destinations not in the route host allowlist", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await worker.fetch(
			"https://other.vendor.com/v1",
			routeInit(),
		);

		expect(response.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const body = await response.text();
		expect(body).toContain("proxy_route_host_denied");
	});

	it("rejects generic proxy requests before forwarding", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const response = await worker.fetch(
			"https://api.vendor.com/v1",
			routeInit(),
		);
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("github_app_required");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("forwards only smart Git requests for the configured Artifacts repository", async () => {
		const host = ARTIFACTS_HOST;
		const base = `https://${host}/git/example-namespace/sample-theme.git`;
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("ok"));
		const allowed = await worker.fetch(
			`${base}/info/refs?service=git-upload-pack`,
			artifactsRouteInit(),
		);
		expect(allowed.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const forwarded = fetchSpy.mock.calls[0]?.[0] as Request;
		expect(
			forwarded.headers.get(
				"X-Tedix-Workstation-Egress-Artifacts-Repository-Path",
			),
		).toBeNull();
		for (const url of [
			`https://${host}/git/example-namespace/other.git/info/refs?service=git-upload-pack`,
			`${base}/../other.git/info/refs?service=git-upload-pack`,
			`${base}/info/refs?service=unexpected`,
			`https://${host}/api/token`,
		]) {
			const response = await worker.fetch(url, artifactsRouteInit());
			expect(response.status).toBe(403);
		}
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("fails closed without issuing when the GitHub App switch is disabled", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { success: true } }),
		);
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?service=git-upload-pack",
				githubRouteInit(),
			),
			{ API_SERVICE: { fetch: apiFetch }, GITHUB_APP_ENABLED: "false" },
		);

		expect(response.status).toBe(503);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(await response.text()).toContain("github_app_disabled");
	});

	it("rejects a Git request outside the server-derived repository scope", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { success: true } }),
		);
		const response = await handleRequest(
			new Request(
				"https://github.com/other/repo.git/info/refs?service=git-upload-pack",
				githubRouteInit(),
			),
			{ API_SERVICE: { fetch: apiFetch }, GITHUB_APP_ENABLED: "true" },
		);

		expect(response.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(await response.text()).toContain("github_repository_scope_mismatch");
	});

	it("rejects GitHub App authority on a mismatched route identity", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { success: true } }),
		);
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?service=git-upload-pack",
				githubRouteInit({
					"X-Tedix-Workstation-Egress-Route-Id": "github-api-transport",
				}),
			),
			{ API_SERVICE: { fetch: apiFetch }, GITHUB_APP_ENABLED: "true" },
		);

		expect(response.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(await response.text()).toContain("github_repository_scope_mismatch");
	});

	it("allows only the exact read-only GitHub repository probe on the API route", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { success: true } }),
		);
		const response = await handleRequest(
			new Request("https://api.github.com/repos/tedix/tedix/issues", {
				...githubRouteInit({
					"X-Tedix-Workstation-Egress-Route-Hosts": '["api.github.com"]',
					"X-Tedix-Workstation-Egress-Route-Id": "github-api-transport",
				}),
				method: "POST",
			}),
			{ API_SERVICE: { fetch: apiFetch }, GITHUB_APP_ENABLED: "true" },
		);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("github_repository_scope_mismatch");
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("durably audits before injecting a token into the upstream request", async () => {
		const order: string[] = [];
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (request: Request | URL | string) => {
				const normalized =
					request instanceof Request ? request : new Request(request);
				if (normalized.url.endsWith("/app/installations/987/access_tokens")) {
					order.push("token");
					return Response.json({
						expires_at: new Date(Date.now() + 3_500_000).toISOString(),
						repositories: [{ full_name: "tedix/tedix", id: 123 }],
						token: "installation-secret",
					});
				}
				order.push("upstream");
				expect(normalized.headers.get("Authorization")).toBe(
					`Basic ${btoa("x-access-token:installation-secret")}`,
				);
				return new Response("github ok", {
					headers: {
						"Content-Type":
							"application/x-git-upload-pack-advertisement; token=header-secret",
						"Content-Length": "9",
						"X-GitHub-Request-Id": "github_request_test",
					},
				});
			});
		const apiFetch = vi.fn(async (request: Request) => {
			const body = await request.clone().text();
			expect(body).not.toContain("installation-secret");
			expect(body).not.toContain("header-secret");
			expect(body).not.toContain("query-secret");
			const action = body.match(/github\.app\.[a-z_.]+/)?.[0] ?? "audit";
			if (action === "github.app.request.outcome") {
				expect(body).toContain('"gitProtocolV2":false');
				expect(body).toContain('"pathClass":"info_refs"');
				expect(body).toContain('"requestMethod":"GET"');
				expect(body).toContain('"responseContentLength":9');
				expect(body).toContain(
					'"responseContentType":"application/x-git-upload-pack-advertisement"',
				);
			}
			order.push(action);
			return Response.json({ json: { success: true } });
		});
		const authorityFetch = vi.fn(async (request: Request) => {
			order.push("authority");
			const body = await request.json();
			expect(body).toMatchObject({
				attemptId: "attempt_test",
				installationId: 987,
				repositoryId: 123,
				workItemId: "work_test",
			});
			return Response.json({ authorized: true });
		});
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix/info/refs?service=git-upload-pack&token=query-secret",
				{
					...githubRouteInit({
						Authorization: "container-supplied",
					}),
				},
			),
			{
				API_SERVICE: { fetch: apiFetch },
				TEDI_SERVICE: { fetch: authorityFetch },
				GITHUB_APP_ENABLED: "true",
				GITHUB_APP_ID: "12345",
				GITHUB_APP_PRIVATE_KEY_PKCS8: await githubAppPrivateKey(),
			},
		);

		expect(response.status).toBe(200);
		expect(order).toEqual([
			"github.app.installation_token.issuance_requested",
			"authority",
			"token",
			"github.app.installation_token.issuance_outcome",
			"upstream",
			"github.app.request.outcome",
		]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(apiFetch).toHaveBeenCalledTimes(3);
		expect(authorityFetch).toHaveBeenCalledTimes(1);

		const auditFailure = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?service=git-upload-pack",
				githubRouteInit(),
			),
			{
				API_SERVICE: {
					fetch: vi.fn(
						async () => new Response("audit unavailable", { status: 503 }),
					),
				},
				GITHUB_APP_ENABLED: "true",
				GITHUB_APP_ID: "12345",
				GITHUB_APP_PRIVATE_KEY_PKCS8: await githubAppPrivateKey(),
			},
		);
		expect(auditFailure.status).toBe(502);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("denies token-mint failures without copying thrown content into audit or response", async () => {
		const auditBodies: string[] = [];
		const apiFetch = vi.fn(async (request: Request) => {
			auditBodies.push(await request.text());
			return Response.json({ json: { success: true } });
		});
		const mintError = new Error("installation-secret request-url-secret", {
			cause: new TypeError("nested-private-key-secret"),
		});
		mintError.name = "arbitrary-secret-name";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(mintError);
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?token=query-secret",
				githubRouteInit(),
			),
			{
				API_SERVICE: { fetch: apiFetch },
				TEDI_SERVICE: {
					fetch: vi.fn(async () => Response.json({ authorized: true })),
				},
				GITHUB_APP_ENABLED: "true",
				GITHUB_APP_ID: "12345",
				GITHUB_APP_PRIVATE_KEY_PKCS8: await githubAppPrivateKey(),
			},
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain("github_app_mint_failed");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(auditBodies).toHaveLength(3);
		const outcome = JSON.parse(
			auditBodies.find((body) =>
				body.includes("github.app.installation_token.issuance_outcome"),
			)!,
		);
		expect(outcome).toMatchObject({
			json: {
				metadata: {
					outcome: "failed",
					reason: "github_app_mint_failed",
					exception: {
						type: "UnknownThrown",
						cause: { type: "TypeError" },
					},
				},
			},
		});
		expect(JSON.stringify([auditBodies, outcome])).not.toMatch(
			/installation-secret|request-url-secret|nested-private-key-secret|arbitrary-secret-name|query-secret/,
		);
	});

	it("audits upstream network failures without exposing request or exception content", async () => {
		const auditBodies: string[] = [];
		const apiFetch = vi.fn(async (request: Request) => {
			auditBodies.push(await request.text());
			return Response.json({ json: { success: true } });
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (request: Request | URL | string) => {
				const url = request instanceof Request ? request.url : String(request);
				if (url.endsWith("/app/installations/987/access_tokens")) {
					return Response.json({
						expires_at: new Date(Date.now() + 3_500_000).toISOString(),
						repositories: [{ full_name: "tedix/tedix", id: 123 }],
						token: "installation-secret",
					});
				}
				throw new Error("network request-url-secret installation-secret", {
					cause: new RangeError("nested-secret"),
				});
			});
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?token=query-secret",
				githubRouteInit(),
			),
			{
				API_SERVICE: { fetch: apiFetch },
				TEDI_SERVICE: {
					fetch: vi.fn(async () => Response.json({ authorized: true })),
				},
				GITHUB_APP_ENABLED: "true",
				GITHUB_APP_ID: "12345",
				GITHUB_APP_PRIVATE_KEY_PKCS8: await githubAppPrivateKey(),
			},
		);

		expect(response.status).toBe(502);
		expect(await response.text()).toContain("github_upstream_failed");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const outcome = JSON.parse(auditBodies.at(-1)!);
		expect(outcome).toMatchObject({
			json: {
				metadata: {
					outcome: "network_failure",
					reason: "github_upstream_failed",
					exception: { type: "Error", cause: { type: "RangeError" } },
				},
			},
		});
		expect(JSON.stringify(auditBodies)).not.toMatch(
			/installation-secret|request-url-secret|nested-secret|query-secret/,
		);
	});

	it.each([
		{
			name: "complete advertisement",
			advertisement: "001e# service=git-upload-pack\n0000000eversion 2\n0000",
			status: 200,
			framing: "valid",
			outcome: "succeeded",
		},
		{
			name: "truncated advertisement",
			advertisement: "001e# service=git-upload-pack\n0000000eversion 2\n",
			status: 502,
			framing: "invalid",
			outcome: "invalid_advertisement",
		},
	])("buffers and checks a $name before delivery", async (scenario) => {
		const auditBodies: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (request) => {
			const normalized =
				request instanceof Request ? request : new Request(request);
			if (normalized.url.endsWith("/app/installations/987/access_tokens"))
				return Response.json({
					expires_at: new Date(Date.now() + 3_500_000).toISOString(),
					repositories: [{ full_name: "tedix/tedix", id: 123 }],
					token: "installation-secret",
				});
			const bytes = new TextEncoder().encode(scenario.advertisement);
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(bytes.subarray(0, 7));
						controller.enqueue(bytes.subarray(7));
						controller.close();
					},
				}),
				{
					headers: {
						"Content-Type": "application/x-git-upload-pack-advertisement",
					},
				},
			);
		});
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?service=git-upload-pack",
				githubRouteInit({ "Git-Protocol": "version=2" }),
			),
			{
				API_SERVICE: {
					fetch: vi.fn(async (request: Request) => {
						auditBodies.push(await request.text());
						return Response.json({ json: { success: true } });
					}),
				},
				TEDI_SERVICE: {
					fetch: vi.fn(async () => Response.json({ authorized: true })),
				},
				GITHUB_APP_ENABLED: "true",
				GITHUB_APP_ID: "12345",
				GITHUB_APP_PRIVATE_KEY_PKCS8: await githubAppPrivateKey(),
			},
		);
		expect(response.status).toBe(scenario.status);
		const body = new TextDecoder().decode(await response.arrayBuffer());
		if (scenario.status === 200) expect(body).toBe(scenario.advertisement);
		else expect(body).toContain("github_git_advertisement_invalid");
		const outcomeAudit = auditBodies.find((value) =>
			value.includes("github.app.request.outcome"),
		);
		expect(outcomeAudit).toContain(
			`"advertisementFraming":"${scenario.framing}"`,
		);
		expect(outcomeAudit).toContain(`"outcome":"${scenario.outcome}"`);
		expect(outcomeAudit).toContain(
			`"advertisementBytes":${new TextEncoder().encode(scenario.advertisement).length}`,
		);
		expect(outcomeAudit).not.toContain("installation-secret");
		expect(outcomeAudit).not.toContain("git-upload-pack\\n0000");
	});

	it("fails closed and audits when live authority denies the request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const apiFetch = vi.fn(async () =>
			Response.json({ json: { success: true } }),
		);
		const response = await handleRequest(
			new Request(
				"https://github.com/tedix/tedix.git/info/refs?service=git-upload-pack",
				githubRouteInit(),
			),
			{
				API_SERVICE: { fetch: apiFetch },
				GITHUB_APP_ENABLED: "true",
				TEDI_SERVICE: {
					fetch: vi.fn(async () =>
						Response.json(
							{ authorized: false, reason: "work_attempt_not_authoritative" },
							{ status: 403 },
						),
					),
				},
			},
		);

		expect(response.status).toBe(403);
		expect(await response.text()).toContain("work_attempt_not_authoritative");
		expect(apiFetch).toHaveBeenCalledTimes(2);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects unsafe methods and upgrade attempts", async () => {
		const traceResponse = worker.fetch("https://api.vendor.com/v1", {
			...routeInit(),
			method: "TRACE",
		});
		const upgradeResponse = await worker.fetch(
			"https://api.vendor.com/v1",
			routeInit({ Upgrade: "websocket" }),
		);

		expect((await traceResponse).status).toBe(405);
		expect(upgradeResponse.status).toBe(400);
	});
});
