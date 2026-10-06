import { TediRuntimeEventKindSchema } from "@tedix/api-contract/schemas/cognitive-runtime";
import { afterEach, describe, expect, it, type Mock, vi } from "vite-plus/test";
import {
	egressDecisionForRequest,
	flushEgressAuditWrites,
	outboundEgressHandler,
	validateOutboundRequest,
	type WorkstationEgressContext,
	type WorkstationEgressEnv,
} from "./egress";

type ApiServiceFetchMock = Mock<(request: Request) => Promise<Response>>;
type RouteBrokerFetchMock = Mock<(request: Request) => Promise<Response>>;
type EventEnv = WorkstationEgressEnv & {
	API_SERVICE: { fetch: ApiServiceFetchMock };
};

function githubRoute() {
	return {
		credentialProvider: "github_app" as const,
		githubInstallationId: 987,
		githubRepository: "tedix/tedix",
		githubRepositoryId: 123,
		hosts: ["github.com"],
		id: "github-git-transport",
		ports: [443],
		proxyRef: "workstation-egress-proxy",
	};
}

function eventEnv(
	status = 200,
	bindings: Record<string, { fetch: RouteBrokerFetchMock }> = {},
): EventEnv {
	const fetch: ApiServiceFetchMock = vi.fn(
		async (_request: Request) => new Response("{}", { status }),
	);
	return {
		API_SERVICE: {
			fetch,
		},
		ENVIRONMENT: "test",
		...bindings,
	};
}

function eventCtx(
	overrides: Partial<Record<string, unknown>> = {},
): WorkstationEgressContext {
	return {
		className: "TediWorkstationRuntimeSandbox",
		containerId: "tedi_test",
		params: {
			attemptId: "attempt_test",
			kernelRunId: "kernel_run_test",
			leaseId: "lease_test",
			organizationId: "org_test",
			profileId: "general",
			tediId: "tedi_test",
			traceBundleId: "trace_bundle_test",
			traceId: "trace_test",
			workstationId: "ws_test",
			workItemId: "work_item_test",
			...overrides,
		},
	};
}

async function firstApiPayload(env: ReturnType<typeof eventEnv>) {
	const request = env.API_SERVICE.fetch.mock.calls[0]?.[0] as Request;
	expect(request).toBeInstanceOf(Request);
	return {
		body: JSON.parse(await request.text()),
		headers: request.headers,
		url: request.url,
	};
}

describe("validateOutboundRequest", () => {
	it("denies direct GitHub egress when the configured App route is absent", async () => {
		const ctx = eventCtx({
			tedixAllowedHosts: ["github.com"],
			tedixProxyRequiredHosts: ["github.com", "api.github.com"],
			tedixProxyRoutes: [],
		});
		const env = eventEnv();
		const upstream = vi.spyOn(globalThis, "fetch");
		try {
			const response = await outboundEgressHandler(
				new Request("https://github.com/tedix/tedix.git/git-upload-pack", {
					method: "POST",
				}),
				env,
				ctx,
			);
			expect(response.status).toBe(403);
			expect(upstream).not.toHaveBeenCalled();
		} finally {
			upstream.mockRestore();
		}
	});

	describe("rejects private / metadata / internal destinations", () => {
		it("blocks the AWS/GCP link-local metadata IP (169.254.169.254)", () => {
			const res = validateOutboundRequest(
				new Request("http://169.254.169.254/latest/meta-data/"),
			);
			expect(res?.status).toBe(403);
		});

		it("blocks the GCP metadata hostname (metadata.google.internal)", () => {
			const res = validateOutboundRequest(
				new Request("http://metadata.google.internal/computeMetadata/v1/"),
			);
			expect(res?.status).toBe(403);
		});

		it("blocks loopback (127.0.0.1)", () => {
			const res = validateOutboundRequest(
				new Request("http://127.0.0.1:8080/"),
			);
			expect(res?.status).toBe(403);
		});

		it("blocks RFC1918 private ranges (10.x / 172.16.x / 192.168.x)", () => {
			expect(
				validateOutboundRequest(new Request("http://10.0.0.1/"))?.status,
			).toBe(403);
			expect(
				validateOutboundRequest(new Request("http://172.16.0.1/"))?.status,
			).toBe(403);
			expect(
				validateOutboundRequest(new Request("https://192.168.1.1/"))?.status,
			).toBe(403);
		});

		it("blocks IPv6 loopback ([::1])", () => {
			expect(
				validateOutboundRequest(new Request("http://[::1]/"))?.status,
			).toBe(403);
		});

		it("blocks decimal-encoded loopback bypass (2130706433)", () => {
			expect(
				validateOutboundRequest(new Request("http://2130706433/"))?.status,
			).toBe(403);
		});

		it("blocks internal Tedix services (api.tedix.dev)", () => {
			expect(
				validateOutboundRequest(new Request("https://api.tedix.dev/rpc"))
					?.status,
			).toBe(403);
		});
	});

	describe("allows public destinations", () => {
		it("returns null for an allowed public HTTPS host", () => {
			expect(
				validateOutboundRequest(new Request("https://api.github.com/repos")),
			).toBeNull();
		});

		it("returns null for an allowed public HTTP host", () => {
			expect(
				validateOutboundRequest(new Request("http://example.com/")),
			).toBeNull();
		});
	});
});

describe("egressDecisionForRequest", () => {
	it("returns a sanitized allow decision", () => {
		expect(
			egressDecisionForRequest(
				new Request("https://api.github.com/repos?token=secret", {
					method: "post",
				}),
			),
		).toEqual({
			decision: "allow",
			error: undefined,
			host: "api.github.com",
			method: "POST",
			protocol: "https",
			reason: "ok",
		});
	});

	it("returns a stable deny reason without path/query data", () => {
		const decision = egressDecisionForRequest(
			new Request("https://app.tedix.dev/rpc?token=secret"),
		);
		expect(decision).toMatchObject({
			decision: "deny",
			host: "app.tedix.dev",
			method: "GET",
			protocol: "https",
			reason: "internal_service",
		});
		expect(JSON.stringify(decision)).not.toContain("token=secret");
		expect(JSON.stringify(decision)).not.toContain("/rpc");
	});

	it("applies workstation allow/deny policy inside the handler decision", () => {
		expect(
			egressDecisionForRequest(new Request("https://api.github.com/repos"), {
				allowedHosts: ["api.github.com"],
				deniedHosts: [],
			}).decision,
		).toBe("allow");
		expect(
			egressDecisionForRequest(new Request("https://example.com/"), {
				allowedHosts: ["api.github.com"],
				deniedHosts: [],
			}),
		).toMatchObject({
			decision: "deny",
			host: "example.com",
			reason: "blocked_host",
		});
		expect(
			egressDecisionForRequest(new Request("https://api.github.com/repos"), {
				allowedHosts: ["*"],
				deniedHosts: ["api.github.com"],
			}),
		).toMatchObject({
			decision: "deny",
			host: "api.github.com",
			reason: "blocked_host",
		});
	});

	it("requires the GitHub broker for a configured repository route", () => {
		const request = new Request("https://github.com/tedix/tedix.git/info/refs");
		const policy = { proxyRoutes: [githubRoute()] };
		expect(egressDecisionForRequest(request, policy)).toMatchObject({
			decision: "deny",
			host: "github.com",
			reason: "proxy_route_unavailable",
			route: {
				id: "github-git-transport",
				ref: "workstation-egress-proxy",
				type: "proxy",
			},
		});
		expect(
			egressDecisionForRequest(request, policy, {
				routeBrokerAvailable: (route) =>
					route.ref === "workstation-egress-proxy",
			}),
		).toMatchObject({ decision: "allow", reason: "proxy_route" });
	});
});

describe("outboundEgressHandler", () => {
	/** Handler + audit flush: audit writes are detached from the hot path, so
	 * tests drain them before asserting on recordEvent calls/warns. */
	async function runEgressHandler(
		...args: Parameters<typeof outboundEgressHandler>
	): Promise<Response> {
		const res = await outboundEgressHandler(...args);
		await flushEgressAuditWrites();
		return res;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("forwards allowed-host requests via fetch (pass-through)", async () => {
		const upstream = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);

		const request = new Request("https://api.github.com/repos");
		const res = await runEgressHandler(request);

		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(fetchSpy).toHaveBeenCalledWith(request);
		expect(res).toBe(upstream);
	});

	it("injects configured headers only after an allow decision", async () => {
		const upstream = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
		const env = eventEnv();
		const ctx = eventCtx({
			tedixAllowedHosts: ["api.vendor.com"],
			tedixInjectedHeaders: [
				{
					header: "Authorization",
					hosts: ["api.vendor.com"],
					secretRef: "VENDOR_API_KEY",
					value: "Bearer vendor-secret",
				},
			],
		});

		const res = await runEgressHandler(
			new Request("https://api.vendor.com/v1", {
				headers: { Authorization: "Bearer container-supplied" },
			}),
			env,
			ctx,
		);

		expect(res).toBe(upstream);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const forwarded = fetchSpy.mock.calls[0]?.[0] as Request;
		expect(forwarded).toBeInstanceOf(Request);
		expect(forwarded.url).toBe("https://api.vendor.com/v1");
		expect(forwarded.headers.get("Authorization")).toBe("Bearer vendor-secret");
		const event = await firstApiPayload(env);
		expect(event.body.json.payload).toMatchObject({
			decision: "allow",
			host: "api.vendor.com",
			injectedHeaderCount: 1,
			injectedHeaders: [
				{ header: "Authorization", secretRef: "VENDOR_API_KEY" },
			],
			reason: "ok",
		});
		const serialized = JSON.stringify(event.body);
		expect(serialized).not.toContain("vendor-secret");
		expect(serialized).not.toContain("container-supplied");
	});

	it("blocks private/metadata requests without calling fetch", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const res = await runEgressHandler(
			new Request("http://169.254.169.254/latest/meta-data/"),
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("records allowed decisions as durable runtime events without URL forensics", async () => {
		const upstream = new Response("ok", { status: 200 });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
		const env = eventEnv();

		const res = await runEgressHandler(
			new Request("https://api.github.com/repos?token=secret", {
				headers: { Authorization: "Bearer secret" },
				method: "POST",
			}),
			env,
			eventCtx(),
		);

		expect(res).toBe(upstream);
		expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1);
		const event = await firstApiPayload(env);
		expect(event.url).toBe("https://api/rpc/cognitiveRuntime/recordEvent");
		expect(event.headers.get("X-Service-Binding")).toBe("true");
		expect(event.headers.get("X-Tedix-Org-Id")).toBe("org_test");
		expect(event.headers.get("X-Tedix-Tedi-Id")).toBe("tedi_test");
		expect(event.body.json.kind).toBe("workstation.egress.allow");
		expect(event.body.json.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		);
		expect(event.body.json.tediId).toBe("tedi_test");
		expect(event.body.json.runId).toBe("kernel_run_test");
		expect(event.body.json.payload).toMatchObject({
			adapter: "cloudflare-sandbox-workstation",
			decision: "allow",
			host: "api.github.com",
			kernelRunId: "kernel_run_test",
			leaseId: "lease_test",
			loggingMode: "all",
			method: "POST",
			profileId: "general",
			protocol: "https",
			reason: "ok",
			traceBundleId: "trace_bundle_test",
			traceId: "trace_test",
			workstationId: "ws_test",
			workItemId: "work_item_test",
		});
		expect(event.body.json.runtime.metadata).toMatchObject({
			eventShapeVersion: "2026-06-28-run-context-v3",
			kernelRunId: "kernel_run_test",
			traceBundleId: "trace_bundle_test",
			traceId: "trace_test",
		});
		const serialized = JSON.stringify(event.body);
		expect(serialized).not.toContain("token=secret");
		expect(serialized).not.toContain("Authorization");
		expect(serialized).not.toContain("Bearer secret");
	});

	it("records denied decisions before returning the block response", async () => {
		const env = eventEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const res = await runEgressHandler(
			new Request("https://app.tedix.dev/rpc?token=secret"),
			env,
			eventCtx(),
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const event = await firstApiPayload(env);
		expect(event.body.json.kind).toBe("workstation.egress.deny");
		expect(event.body.json.payload).toMatchObject({
			decision: "deny",
			host: "app.tedix.dev",
			loggingMode: "all",
			method: "GET",
			protocol: "https",
			reason: "internal_service",
		});
		const serialized = JSON.stringify(event.body);
		expect(serialized).not.toContain("token=secret");
		expect(serialized).not.toContain("/rpc");
	});

	it("uses request-scoped trace headers for durable event correlation", async () => {
		const env = eventEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const res = await runEgressHandler(
			new Request("https://app.tedix.dev/rpc?token=secret", {
				headers: {
					"X-Tedix-Workstation-Trace-Id": "request_trace_test",
				},
			}),
			env,
			eventCtx({
				traceId: "stale_trace_test",
			}),
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const event = await firstApiPayload(env);
		expect(event.body.json.payload.traceId).toBe("request_trace_test");
		expect(event.body.json.runId).toBe("kernel_run_test");
		expect(event.body.json.runtime.metadata).toMatchObject({
			eventShapeVersion: "2026-06-28-run-context-v3",
			kernelRunId: "kernel_run_test",
			traceBundleId: "trace_bundle_test",
			traceId: "request_trace_test",
		});
		expect(JSON.stringify(event.body)).not.toContain("token=secret");
	});

	it("records workstation policy denials that would otherwise be SDK-gated", async () => {
		const env = eventEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const ctx = eventCtx();
		ctx.params = {
			...(ctx.params as Record<string, unknown>),
			tedixAllowedHosts: ["api.github.com"],
		};

		const res = await runEgressHandler(
			new Request("https://example.com/some/path?token=secret"),
			env,
			ctx,
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const event = await firstApiPayload(env);
		expect(event.body.json.kind).toBe("workstation.egress.deny");
		expect(event.body.json.payload).toMatchObject({
			decision: "deny",
			host: "example.com",
			reason: "blocked_host",
		});
		expect(JSON.stringify(event.body)).not.toContain("token=secret");
		expect(JSON.stringify(event.body)).not.toContain("/some/path");
	});

	it("forwards only server-side GitHub App scope and audit context", async () => {
		const brokerFetch: RouteBrokerFetchMock = vi.fn(
			async (_request: Request) => new Response("github ok"),
		);
		const env = eventEnv(200, {
			WORKSTATION_EGRESS_PROXY: { fetch: brokerFetch },
		});
		const ctx = eventCtx({
			tedixProxyRoutes: [githubRoute()],
		});

		const res = await runEgressHandler(
			new Request("https://github.com/tedix/tedix.git/info/refs", {
				headers: {
					Authorization: "container-supplied",
					"X-Tedix-Workstation-Egress-Organization-Id": "forged-org",
					"X-Tedix-Workstation-Egress-Proxy-Credential": "forged-secret",
					"X-Tedix-Workstation-Egress-Route-Credential-Header": "Authorization",
				},
			}),
			env,
			ctx,
		);

		expect(await res.text()).toBe("github ok");
		const forwarded = brokerFetch.mock.calls[0]?.[0] as Request;
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-Credential-Provider"),
		).toBe("github_app");
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-GitHub-Repository"),
		).toBe("tedix/tedix");
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-GitHub-Repository-Id"),
		).toBe("123");
		expect(
			forwarded.headers.get(
				"X-Tedix-Workstation-Egress-GitHub-Installation-Id",
			),
		).toBe("987");
		expect(forwarded.headers.get("X-Tedix-Workstation-Egress-Attempt-Id")).toBe(
			"attempt_test",
		);
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-Organization-Id"),
		).toBe("org_test");
		expect(forwarded.headers.get("X-Tedix-Workstation-Egress-Tedi-Id")).toBe(
			"tedi_test",
		);
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-Proxy-Credential"),
		).toBeNull();
		expect(
			forwarded.headers.get(
				"X-Tedix-Workstation-Egress-Route-Credential-Header",
			),
		).toBeNull();
	});

	it("forwards the exact Artifacts repository scope through the broker", async () => {
		const host = `${"a".repeat(32)}.artifacts.cloudflare.net`;
		const brokerFetch: RouteBrokerFetchMock = vi.fn(
			async () => new Response("ok"),
		);
		const env = eventEnv(200, {
			WORKSTATION_EGRESS_PROXY: { fetch: brokerFetch },
		});
		const res = await runEgressHandler(
			new Request(
				`https://${host}/git/example-namespace/sample-theme.git/info/refs?service=git-upload-pack`,
				{
					headers: {
						"X-Tedix-Workstation-Egress-Artifacts-Repository-Path":
							"/git/forged/repo.git",
					},
				},
			),
			env,
			eventCtx({
				tedixProxyRoutes: [
					{
						credentialProvider: "artifacts_token",
						artifactsRepositoryPath: "/git/example-namespace/sample-theme.git",
						hosts: [host],
						id: "artifacts-git-transport",
						ports: [443],
						proxyRef: "workstation-egress-proxy",
					},
				],
			}),
		);
		expect(res.status).toBe(200);
		const forwarded = brokerFetch.mock.calls[0]?.[0] as Request;
		expect(
			forwarded.headers.get(
				"X-Tedix-Workstation-Egress-Artifacts-Repository-Path",
			),
		).toBe("/git/example-namespace/sample-theme.git");
		expect(
			forwarded.headers.get("X-Tedix-Workstation-Egress-Credential-Provider"),
		).toBe("artifacts_token");
	});

	it("fails closed without leaking GitHub request data when the broker throws", async () => {
		const brokerFetch: RouteBrokerFetchMock = vi.fn(async () => {
			throw new Error("boom token=secret /info/refs", {
				cause: new TypeError("nested token=secret"),
			});
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = eventEnv(200, {
			WORKSTATION_EGRESS_PROXY: { fetch: brokerFetch },
		});
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const ctx = eventCtx({ tedixProxyRoutes: [githubRoute()] });
		const res = await runEgressHandler(
			new Request("https://github.com/tedix/tedix.git/info/refs?token=secret"),
			env,
			ctx,
		);
		expect(res.status).toBe(502);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] route_broker=failed",
			expect.objectContaining({
				exception: { type: "Error", cause: { type: "TypeError" } },
				route: {
					id: "github-git-transport",
					ref: "workstation-egress-proxy",
					type: "proxy",
				},
			}),
		);
		const event = await firstApiPayload(env);
		expect(event.body.json.payload).toMatchObject({
			decision: "deny",
			egressRoute: { id: "github-git-transport", type: "proxy" },
			host: "github.com",
			reason: "route_broker_failed",
		});
		const evidence = JSON.stringify([event.body, warn.mock.calls]);
		expect(evidence).not.toContain("token=secret");
		expect(evidence).not.toContain("/info/refs");
	});

	it.each([
		[403, "route_broker_denied"],
		[501, "route_broker_unimplemented"],
		[502, "route_broker_failed"],
	])("records GitHub broker status %s as denial", async (status, reason) => {
		const brokerFetch: RouteBrokerFetchMock = vi.fn(
			async () => new Response("broker denied", { status }),
		);
		const env = eventEnv(200, {
			WORKSTATION_EGRESS_PROXY: { fetch: brokerFetch },
		});
		const res = await runEgressHandler(
			new Request("https://github.com/tedix/tedix.git/info/refs"),
			env,
			eventCtx({ tedixProxyRoutes: [githubRoute()] }),
		);
		expect(res.status).toBe(status);
		const event = await firstApiPayload(env);
		expect(event.body.json.payload).toMatchObject({
			brokerStatus: status,
			decision: "deny",
			egressRoute: { id: "github-git-transport", type: "proxy" },
			host: "github.com",
			reason,
		});
	});

	it("blocks matching header injection rules when the secret is unresolved", async () => {
		const env = eventEnv();
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const ctx = eventCtx({
			tedixAllowedHosts: ["api.vendor.com"],
			tedixHeaderInjectionFailures: [
				{
					header: "X-Vendor-Key",
					hosts: ["api.vendor.com"],
					reason: "missing_secret",
					secretRef: "MISSING_VENDOR_KEY",
				},
			],
		});

		const res = await runEgressHandler(
			new Request("https://api.vendor.com/v1?token=secret"),
			env,
			ctx,
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		const event = await firstApiPayload(env);
		expect(event.body.json.kind).toBe("workstation.egress.deny");
		expect(event.body.json.payload).toMatchObject({
			blockedHeaderInjections: [
				{
					header: "X-Vendor-Key",
					reason: "missing_secret",
					secretRef: "MISSING_VENDOR_KEY",
				},
			],
			decision: "deny",
			host: "api.vendor.com",
			reason: "missing_secret",
		});
		expect(JSON.stringify(event.body)).not.toContain("token=secret");
	});

	it.each(["allowedHosts", "deniedHosts"])(
		"fails closed when retired %s params are supplied",
		async (legacyKey) => {
			const env = eventEnv();
			const fetchSpy = vi.spyOn(globalThis, "fetch");
			const ctx = eventCtx();
			ctx.params = {
				...(ctx.params as Record<string, unknown>),
				[legacyKey]: ["example.com"],
			};

			const res = await runEgressHandler(
				new Request("https://example.com/"),
				env,
				ctx,
			);

			expect(res.status).toBe(403);
			expect(fetchSpy).not.toHaveBeenCalled();
			const event = await firstApiPayload(env);
			expect(event.body.json.kind).toBe("workstation.egress.deny");
			expect(event.body.json.payload).toMatchObject({
				decision: "deny",
				host: "example.com",
				reason: "legacy_host_policy_params",
			});
		},
	);

	it("suppresses allow logs and durable allow events when logging mode is deny_only", async () => {
		const upstream = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const env = eventEnv();

		const res = await runEgressHandler(
			new Request("https://api.github.com/repos"),
			env,
			eventCtx({ tedixEgressLoggingMode: "deny_only" }),
		);

		expect(res).toBe(upstream);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(env.API_SERVICE.fetch).not.toHaveBeenCalled();
		expect(log).not.toHaveBeenCalledWith(
			expect.stringContaining("[workstation-egress] decision=allow"),
		);
	});

	it("records failed allowed responses under deny_only without leaking or consuming bytes", async () => {
		const response = new Response("private response body", {
			status: 429,
			headers: {
				"retry-after": "60",
				server: "GitHub.com",
				"x-github-request-id": "A123:B456:C789:D012:E345",
				"cf-ray": "0123456789abcdef-AMS",
				"x-ratelimit-remaining": "0",
				"set-cookie": "private-cookie",
				"x-secret": "private-header",
			},
		});
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = eventEnv();
		const returned = await runEgressHandler(
			new Request("https://github.com/private-path?token=private-query", {
				headers: { Authorization: "Bearer private-authorization" },
			}),
			env,
			eventCtx({ tedixEgressLoggingMode: "deny_only" }),
		);
		expect(returned).toBe(response);
		expect(returned.bodyUsed).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
		const { body } = await firstApiPayload(env);
		expect(body.json.kind).toBe("workstation.egress.allow");
		expect(TediRuntimeEventKindSchema.parse(body.json.kind)).toBe(
			"workstation.egress.allow",
		);
		expect(body.json.payload).toMatchObject({
			decision: "allow",
			outcome: "upstream_failed",
			upstreamStatus: 429,
			authorizationHeaderPresent: true,
			leaseId: "lease_test",
			responseHeaders: {
				"retry-after": "60",
				server: "github.com",
				"x-github-request-id": "A123:B456:C789:D012:E345",
				"cf-ray": "0123456789abcdef-AMS",
				"x-ratelimit-remaining": "0",
			},
		});
		const emitted = JSON.stringify([body, warn.mock.calls]);
		for (const secret of [
			"private response body",
			"private-cookie",
			"private-header",
			"private-path",
			"private-query",
			"private-authorization",
		])
			expect(emitted).not.toContain(secret);
	});
	it("drops arbitrary or oversized attribution values", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, {
				status: 503,
				headers: {
					"retry-after": "9999999999999999999",
					server: "secret-server",
					"x-github-request-id": "secret-id",
					"cf-ray": "secret-ray",
					"x-ratelimit-reset": "1e99",
				},
			}),
		);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = eventEnv();
		await runEgressHandler(
			new Request("https://github.com/"),
			env,
			eventCtx({ tedixEgressLoggingMode: "deny_only" }),
		);
		const { body } = await firstApiPayload(env);
		expect(body.json.payload.responseHeaders).toEqual({});
		expect(body.json.payload.authorizationHeaderPresent).toBe(false);
	});
	it("does not delay a failed response for its detached audit write", async () => {
		const response = new Response(null, { status: 429 });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let finish!: (response: Response) => void;
		const env = eventEnv();
		env.API_SERVICE.fetch.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const returned = await outboundEgressHandler(
			new Request("https://github.com/"),
			env,
			eventCtx({ tedixEgressLoggingMode: "deny_only" }),
		);
		expect(returned).toBe(response);
		await vi.waitFor(() =>
			expect(env.API_SERVICE.fetch).toHaveBeenCalledTimes(1),
		);
		finish(new Response("{}"));
		await flushEgressAuditWrites();
	});

	it("keeps deny logs and durable deny events when logging mode is deny_only", async () => {
		const env = eventEnv();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const fetchSpy = vi.spyOn(globalThis, "fetch");

		const res = await runEgressHandler(
			new Request("https://example.com/"),
			env,
			eventCtx({
				tedixAllowedHosts: ["api.github.com"],
				tedixEgressLoggingMode: "deny_only",
			}),
		);

		expect(res.status).toBe(403);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] decision=deny host=example.com reason=blocked_host",
		);
		const event = await firstApiPayload(env);
		expect(event.body.json.kind).toBe("workstation.egress.deny");
		expect(event.body.json.payload).toMatchObject({
			decision: "deny",
			host: "example.com",
			loggingMode: "deny_only",
			reason: "blocked_host",
		});
	});

	it("does not fail open allowed egress when durable event recording fails", async () => {
		const upstream = new Response("ok", { status: 200 });
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(upstream);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const env = eventEnv(500);

		const res = await runEgressHandler(
			new Request("https://api.github.com/repos"),
			env,
			eventCtx(),
		);

		expect(res).toBe(upstream);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] durable_event=failed",
			expect.objectContaining({
				decision: "allow",
				exception: expect.objectContaining({ type: "UnknownThrown" }),
			}),
		);
	});

	it("keeps failed audit-write messages and causes out of logs", async () => {
		const env = eventEnv();
		env.API_SERVICE.fetch.mockRejectedValue(
			new Error("secret authorization header", {
				cause: new TypeError("nested secret token"),
			}),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));

		const response = await runEgressHandler(
			new Request("https://api.github.com/repos"),
			env,
			eventCtx(),
		);
		expect(response.status).toBe(200);
		await flushEgressAuditWrites();
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] durable_event=failed",
			expect.objectContaining({
				exception: { type: "Error", cause: { type: "TypeError" } },
			}),
		);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
	});
});

describe("structured egress log line", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("emits decision=deny with a stable reason code on block", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		validateOutboundRequest(
			new Request("http://169.254.169.254/latest/meta-data/"),
		);
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] decision=deny host=169.254.169.254 reason=private_network",
		);
	});

	it("maps internal Tedix services to reason=internal_service", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		validateOutboundRequest(new Request("https://app.tedix.dev/x"));
		expect(warn).toHaveBeenCalledWith(
			"[workstation-egress] decision=deny host=app.tedix.dev reason=internal_service",
		);
	});

	it("emits decision=allow reason=ok on pass-through", () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		validateOutboundRequest(new Request("https://api.github.com/repos"));
		expect(log).toHaveBeenCalledWith(
			"[workstation-egress] decision=allow host=api.github.com reason=ok",
		);
	});
});
