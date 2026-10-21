import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	ProtocolError,
	SdkError,
	SdkErrorCode,
	SdkHttpError,
	UnsupportedProtocolVersionError,
} from "@modelcontextprotocol/client";
import {
	FirstPartyMcpError,
	type FirstPartyMcpConnection,
	requestFirstPartyMcp,
	withFirstPartyMcp,
} from "./first-party-mcp";

const fixture = vi.hoisted(() => ({
	construct: vi.fn(),
	transport: vi.fn<(url: URL, options: { fetch: typeof fetch }) => void>(),
	connect: vi.fn(),
	request: vi.fn(),
	close: vi.fn(),
}));

// Keep the SDK's real error hierarchy; replace only the connection machinery.
vi.mock("./mcp-client-sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("./mcp-client-sdk")>()),
	Client: class {
		constructor(...args: unknown[]) {
			fixture.construct(...args);
		}
		connect = fixture.connect;
		request = fixture.request;
		close = fixture.close;
	},
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: { fetch: typeof fetch }) {
			fixture.transport(url, options);
		}
	},
}));

let connection: FirstPartyMcpConnection;

beforeEach(() => {
	vi.resetAllMocks();
	fixture.connect.mockResolvedValue(undefined);
	fixture.request.mockResolvedValue({ resultType: "complete", tools: [] });
	fixture.close.mockResolvedValue(undefined);
	connection = {
		url: "https://mcp.example.test/mcp",
		clientName: "test-first-party",
		headers: { "X-Tedix-Host": "acme.example.test" },
		fetch: vi.fn().mockRejectedValue(new Error("Unexpected transport request")),
	};
});

describe("withFirstPartyMcp lifecycle", () => {
	it("constructs one pinned client, returns the operation value and closes once", async () => {
		const value = { finished: true };
		const operation = vi.fn(async (_request, client) => {
			expect(fixture.connect).toHaveBeenCalledOnce();
			expect(fixture.close).not.toHaveBeenCalled();
			expect(client.close).toBe(fixture.close);
			return value;
		});
		await expect(withFirstPartyMcp(connection, operation)).resolves.toBe(value);
		expect(operation).toHaveBeenCalledOnce();
		expect(fixture.construct).toHaveBeenCalledExactlyOnceWith(
			{ name: "test-first-party", version: "1.0.0" },
			{
				capabilities: {},
				versionNegotiation: { mode: { pin: "2026-07-28" } },
				inputRequired: { autoFulfill: false },
			},
		);
		expect(fixture.transport).toHaveBeenCalledOnce();
		expect(fixture.transport.mock.calls[0][0].href).toBe(connection.url);
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it("closes after connect failure without invoking the operation", async () => {
		const error = new TypeError("Connection dropped");
		fixture.connect.mockRejectedValueOnce(error);
		const operation = vi.fn();
		await expect(withFirstPartyMcp(connection, operation)).rejects.toBe(error);
		expect(fixture.construct).toHaveBeenCalledOnce();
		expect(fixture.connect).toHaveBeenCalledOnce();
		expect(operation).not.toHaveBeenCalled();
		expect(fixture.request).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it.each(["request", "operation"])(
		"preserves a non-SDK %s failure by identity and closes once",
		async (phase) => {
			const error = new TypeError("Network unavailable");
			if (phase === "request") fixture.request.mockRejectedValueOnce(error);
			await expect(
				withFirstPartyMcp(connection, async (request) => {
					if (phase === "operation") throw error;
					return request("tools/list");
				}),
			).rejects.toBe(error);
			expect(fixture.close).toHaveBeenCalledOnce();
		},
	);

	it("ignores close failure after a successful operation", async () => {
		fixture.close.mockRejectedValueOnce(new Error("Close failed"));
		await expect(withFirstPartyMcp(connection, async () => 42)).resolves.toBe(
			42,
		);
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it.each(["connect", "request", "operation"])(
		"does not let close failure replace the original %s failure",
		async (phase) => {
			const original = new Error("Original failure");
			fixture.close.mockRejectedValueOnce(new Error("Close failed"));
			if (phase === "connect") fixture.connect.mockRejectedValueOnce(original);
			if (phase === "request") fixture.request.mockRejectedValueOnce(original);
			await expect(
				withFirstPartyMcp(connection, async (request) => {
					if (phase === "operation") throw original;
					return request("tools/list");
				}),
			).rejects.toBe(original);
			expect(fixture.close).toHaveBeenCalledOnce();
		},
	);
});

describe("connection and request boundaries", () => {
	it.each([undefined, 1234])(
		"forwards finite timeout %s to connect and every request",
		async (timeoutMs) => {
			connection.timeoutMs = timeoutMs;
			const timeout = timeoutMs ?? 300_000;
			await withFirstPartyMcp(connection, async (request) => {
				await request("tools/list");
				await request("resources/list", { cursor: "next" });
			});
			expect(Number.isFinite(timeout)).toBe(true);
			expect(fixture.connect.mock.calls[0][1]).toEqual({
				timeout,
				prior: {
					kind: "modern",
					discover: { supportedVersions: ["2026-07-28"], capabilities: {} },
				},
			});
			expect(
				fixture.request.mock.calls.map(([message, , options]) => ({
					message,
					options,
				})),
			).toEqual([
				{
					message: { method: "tools/list", params: {} },
					options: { timeout, allowInputRequired: true },
				},
				{
					message: { method: "resources/list", params: { cursor: "next" } },
					options: { timeout, allowInputRequired: true },
				},
			]);
		},
	);

	it("omits the prior verdict for a probe and forwards client capabilities", async () => {
		connection.probe = true;
		connection.clientCapabilities = { sampling: {} };
		await withFirstPartyMcp(connection, async () => undefined);
		expect(fixture.connect.mock.calls[0][1]).toEqual({ timeout: 300_000 });
		expect(fixture.construct.mock.calls[0][1].capabilities).toEqual({
			sampling: {},
		});
	});

	it("answers GET listen attempts with 405 without touching the supplied fetch", async () => {
		await withFirstPartyMcp(connection, async () => {
			const transportFetch = fixture.transport.mock.calls[0][1].fetch;
			const response = await transportFetch(connection.url, { method: "GET" });
			expect(response.status).toBe(405);
			expect(await response.text()).toBe("");
		});
		expect(connection.fetch).not.toHaveBeenCalled();
	});

	it("preserves a supplied fetch exception and still closes the client", async () => {
		const error = new TypeError("Binding unavailable");
		connection.fetch = vi.fn().mockRejectedValueOnce(error);
		await expect(
			withFirstPartyMcp(connection, async () => {
				const transportFetch = fixture.transport.mock.calls[0][1].fetch;
				return transportFetch(connection.url, { method: "POST" });
			}),
		).rejects.toBe(error);
		expect(connection.fetch).toHaveBeenCalledOnce();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it("merges caller headers over SDK headers and invokes fetch without a receiver", async () => {
		const response = new Response(null, { status: 202 });
		connection.fetch = vi.fn(async function (this: unknown, _url, _init) {
			expect(this).toBeUndefined();
			return response;
		});
		await withFirstPartyMcp(connection, async () => {
			const transportFetch = fixture.transport.mock.calls[0][1].fetch;
			const headers = new Headers({
				"X-Tedix-Host": "sdk-value",
				"Mcp-Method": "tools/list",
			});
			await expect(
				transportFetch(new URL(connection.url), {
					method: "POST",
					headers,
					body: "fixture",
				}),
			).resolves.toBe(response);
			expect(headers.get("X-Tedix-Host")).toBe("sdk-value");
		});
		expect(connection.fetch).toHaveBeenCalledOnce();
		const [url, init] = vi.mocked(connection.fetch).mock.calls[0];
		expect(url).toBe(connection.url);
		expect(init.method).toBe("POST");
		expect(init.body).toBe("fixture");
		expect(Object.fromEntries(new Headers(init.headers))).toEqual({
			"mcp-method": "tools/list",
			"x-tedix-host": "acme.example.test",
		});
	});

	it("returns input-required data unchanged without issuing fulfillment requests", async () => {
		const result = {
			resultType: "input_required",
			inputRequests: [{ type: "elicitation", message: "Choose a value" }],
		};
		fixture.request.mockResolvedValueOnce(result);
		await expect(
			requestFirstPartyMcp(connection, "tools/call", { name: "local_fixture" }),
		).resolves.toBe(result);
		expect(fixture.request).toHaveBeenCalledOnce();
		expect(fixture.request.mock.calls[0][2].allowInputRequired).toBe(true);
		expect(fixture.construct.mock.calls[0][1].inputRequired).toEqual({
			autoFulfill: false,
		});
		expect(connection.fetch).not.toHaveBeenCalled();
		expect(fixture.close).toHaveBeenCalledOnce();
	});

	it("supplies a result schema accepting only non-array objects", async () => {
		await requestFirstPartyMcp(connection, "tools/list");
		const schema = fixture.request.mock.calls[0][1]["~standard"];
		const result = { resultType: "complete" };
		expect(schema.validate(result)).toEqual({ value: result });
		for (const value of [null, [], "text", 42, false, undefined]) {
			expect(schema.validate(value)).toEqual({
				issues: [{ message: "Expected a JSON-RPC result object" }],
			});
		}
	});
});

describe("first-party error taxonomy", () => {
	const protocolData = { retryable: false };
	const cases = [
		{
			name: "HTTP with bounded body",
			error: new SdkHttpError(SdkErrorCode.SendFailed, "private SDK detail", {
				status: 503,
				text: "x".repeat(900),
				headers: { private: "hidden" },
			}),
			kind: "http",
			status: 503,
			body: "x".repeat(800),
			message: "MCP host answered HTTP 503",
		},
		{
			name: "HTTP with non-text body",
			error: new SdkHttpError(SdkErrorCode.SendFailed, "HTTP failure", {
				status: 401,
				text: { private: true },
			}),
			kind: "http",
			status: 401,
			message: "MCP host answered HTTP 401",
		},
		{
			name: "unsupported protocol subclass",
			error: new UnsupportedProtocolVersionError({
				supported: ["2025-11-25"],
				requested: "2026-07-28",
			}),
			kind: "unsupported_protocol",
		},
		{
			name: "protocol with data",
			error: new ProtocolError(-32602, "Invalid params", protocolData),
			kind: "protocol",
			rpcData: protocolData,
		},
		{
			name: "protocol without data",
			error: new ProtocolError(-32601, "Unknown method"),
			kind: "protocol",
		},
		{
			name: "protocol with null data",
			error: new ProtocolError(-32603, "Internal error", null),
			kind: "protocol",
			rpcData: null,
		},
		{
			name: "SDK timeout",
			error: new SdkError(SdkErrorCode.RequestTimeout, "Timed out", {
				private: true,
			}),
			kind: "timeout",
		},
		{
			name: "abort",
			error: Object.assign(new Error("Aborted"), { name: "AbortError" }),
			kind: "timeout",
		},
		{
			name: "era negotiation",
			error: new SdkError(
				SdkErrorCode.EraNegotiationFailed,
				"No supported revision",
				{ private: true },
			),
			kind: "unsupported_protocol",
		},
		{
			name: "other SDK failure",
			error: new SdkError(
				SdkErrorCode.InvalidResult,
				"Invalid result",
				{ private: true },
				{ cause: new Error("Private underlying failure") },
			),
			kind: "invalid_response",
		},
	];

	for (const phase of ["connect", "request"] as const) {
		it.each(cases)(
			`classifies $name during ${phase} with only intended fields`,
			async (entry) => {
				fixture[phase].mockRejectedValueOnce(entry.error);
				const failure = await requestFirstPartyMcp(
					connection,
					"tools/list",
				).catch((error: unknown) => error);
				expect(failure).toBeInstanceOf(FirstPartyMcpError);
				expect(Object.getOwnPropertyNames(failure).sort()).toEqual(
					[
						"stack",
						"message",
						"name",
						"kind",
						"status",
						"body",
						"rpcError",
					].sort(),
				);
				const rpcError =
					entry.kind === "protocol"
						? {
								code: (entry.error as ProtocolError).code,
								message: entry.error.message,
								...("rpcData" in entry ? { data: entry.rpcData } : {}),
							}
						: undefined;
				expect({ ...(failure as FirstPartyMcpError) }).toEqual({
					name: "FirstPartyMcpError",
					kind: entry.kind,
					status: "status" in entry ? entry.status : undefined,
					body: "body" in entry ? entry.body : undefined,
					rpcError,
				});
				expect((failure as Error).message).toBe(
					"message" in entry ? entry.message : entry.error.message,
				);
				expect(fixture.close).toHaveBeenCalledOnce();
			},
		);
	}

	it("uses the actual protocol subclass hierarchy", () => {
		expect(
			cases.find((entry) => entry.name === "unsupported protocol subclass")
				?.error,
		).toBeInstanceOf(ProtocolError);
	});
});
