import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { LAYOUT_CATALOG_PROMPT } from "@tedix/api-contract/generated/layout-catalog-prompt";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import {
	buildEnrichmentRequest,
	invokeTediEnrichment,
	type TediEnrichmentResponse,
} from "./tedi-enrichment";

const mocks = vi.hoisted(() => ({
	transport: vi.fn(),
	error: vi.fn(),
}));

vi.mock("@tedix/api-client/internal", () => ({
	callRpc: vi.fn(),
	serviceBindingFetch: vi.fn(),
}));
vi.mock("../log", () => ({
	createMcpLogger: vi.fn(() => ({ error: mocks.error })),
}));

function context() {
	return {
		tediId: "fixture-tedi",
		appId: "fixture-app",
		toolId: "list_records",
		toolTitle: "List records",
		args: { filter: { status: "open" }, limit: 2 },
		rawResult: { records: [{ id: "record-1" }] },
		appSlug: "fixture-workspace",
		vertical: "operations",
		traceId: "fixture-trace",
		callerIdentity: {
			authType: "oauth" as const,
			userId: "fixture-user",
			scopes: ["records.read"],
		},
		policy: {
			allowedEnrichmentTools: ["memory_search"],
			blockedEnrichmentTools: ["send_message"],
			maxEnrichmentTokens: 1234,
			enrichmentTimeoutMs: 5678,
		},
	};
}

let externalFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(serviceBindingFetch).mockReturnValue(mocks.transport);
	// A bridge regression must never escape the synthetic RPC boundary.
	externalFetch = vi.fn(() => {
		throw new Error("External fetch forbidden in enrichment bridge tests");
	});
	vi.stubGlobal("fetch", externalFetch);
});

afterEach(() => {
	expect(externalFetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("buildEnrichmentRequest", () => {
	it("maps identity and every policy field while preserving args and raw result", () => {
		const input = context();
		const before = structuredClone(input);
		const request = buildEnrichmentRequest(input);

		expect(request).toStrictEqual({
			tediId: "fixture-tedi",
			appId: "fixture-app",
			action: "enrich-tool-call",
			traceId: "fixture-trace",
			payload: {
				toolId: "list_records",
				toolTitle: "List records",
				args: before.args,
				rawResult: before.rawResult,
				catalogPrompt: LAYOUT_CATALOG_PROMPT,
				appContext: { appSlug: "fixture-workspace", vertical: "operations" },
				callerIdentity: {
					authType: "oauth",
					userId: "fixture-user",
					scopes: ["records.read"],
				},
				tediPolicy: {
					allowedTools: ["memory_search"],
					blockedTools: ["send_message"],
					maxTokens: 1234,
					timeoutMs: 5678,
				},
			},
		});
		expect(request.payload.args).toBe(input.args);
		expect(request.payload.rawResult).toBe(input.rawResult);
		expect(input).toStrictEqual(before);
		expect(callRpc).not.toHaveBeenCalled();
	});

	it.each([undefined, { authType: "anonymous" as const }])(
		"preserves optional caller identity: %j",
		(callerIdentity) => {
			const request = buildEnrichmentRequest({
				...context(),
				callerIdentity,
				traceId: undefined,
				vertical: undefined,
			});
			expect(request.payload.callerIdentity).toBe(callerIdentity);
			expect(request.traceId).toBeUndefined();
			expect(request.payload.appContext).toStrictEqual({
				appSlug: "fixture-workspace",
				vertical: undefined,
			});
		},
	);

	it.each([false, true])("honors skipCatalogPrompt=%s", (skipCatalogPrompt) => {
		const request = buildEnrichmentRequest({ ...context(), skipCatalogPrompt });
		expect(LAYOUT_CATALOG_PROMPT.length).toBeGreaterThan(0);
		expect(request.payload.catalogPrompt).toBe(
			skipCatalogPrompt ? "" : LAYOUT_CATALOG_PROMPT,
		);
	});
});

describe("invokeTediEnrichment", () => {
	function bindingEnvironment() {
		const binding = {
			fetch: vi.fn(() => {
				throw new Error("Unexpected service binding execution");
			}),
		};
		return {
			binding,
			env: { API_SERVICE: binding } as unknown as CloudflareEnv,
		};
	}

	it.each(["fixture-trace", undefined])(
		"uses tediInvoke/enrich on the supplied binding with trace %s",
		async (traceId) => {
			const { binding, env } = bindingEnvironment();
			const request = buildEnrichmentRequest({ ...context(), traceId });
			const before = structuredClone(request);
			const response: TediEnrichmentResponse = {
				enrichedData: { records: [{ id: "record-1", summary: "Ready" }] },
				layoutSpec: { root: "root", elements: { root: { type: "Card" } } },
				textContent: "Ready",
				muscleMemoryUpdate: { pattern: "list", observation: "Use cards" },
			};
			vi.mocked(callRpc).mockResolvedValueOnce(response);

			expect(await invokeTediEnrichment(env, request)).toBe(response);
			expect(serviceBindingFetch).toHaveBeenCalledExactlyOnceWith(binding);
			expect(callRpc).toHaveBeenCalledExactlyOnceWith(
				"tediInvoke/enrich",
				{
					tediId: "fixture-tedi",
					appId: "fixture-app",
					payload: request.payload,
				},
				{
					apiUrl: "https://api",
					fetch: mocks.transport,
					headers: traceId
						? { "X-Service-Binding": "true", "X-Trace-Id": traceId }
						: { "X-Service-Binding": "true" },
				},
			);
			const rpcInput = vi.mocked(callRpc).mock.calls[0]?.[1] as {
				payload: unknown;
			};
			expect(rpcInput.payload).toBe(request.payload);
			expect(request).toStrictEqual(before);
			expect(binding.fetch).not.toHaveBeenCalled();
			expect(mocks.error).not.toHaveBeenCalled();
		},
	);

	it("returns null without constructing an RPC client when the binding is absent", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		expect(
			await invokeTediEnrichment(
				{} as CloudflareEnv,
				buildEnrichmentRequest(context()),
			),
		).toBeNull();
		expect(serviceBindingFetch).not.toHaveBeenCalled();
		expect(callRpc).not.toHaveBeenCalled();
	});

	it("returns null and logs one rejected RPC without retrying", async () => {
		const { env } = bindingEnvironment();
		const request = buildEnrichmentRequest(context());
		const error = new Error("Synthetic RPC rejection");
		vi.mocked(callRpc).mockRejectedValueOnce(error);

		expect(await invokeTediEnrichment(env, request)).toBeNull();
		expect(callRpc).toHaveBeenCalledTimes(1);
		expect(serviceBindingFetch).toHaveBeenCalledTimes(1);
		expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
			"Tedi enrichment failed",
			{
				event: "tedi_enrichment.invoke_failed",
				appId: request.appId,
				tediId: request.tediId,
				traceId: request.traceId,
				outcome: "unavailable",
				error,
			},
		);
	});

	it("returns null when the binding fetch throws synchronously without retrying", async () => {
		const { binding, env } = bindingEnvironment();
		const error = new Error("Synthetic binding fetch error");
		binding.fetch.mockImplementationOnce(() => {
			throw error;
		});
		mocks.transport.mockImplementationOnce(() => binding.fetch());
		vi.mocked(callRpc).mockImplementationOnce((_path, _input, options) =>
			options.fetch!("https://api/rpc/tediInvoke/enrich").then(() => ({})),
		);

		expect(
			await invokeTediEnrichment(env, buildEnrichmentRequest(context())),
		).toBeNull();
		expect(callRpc).toHaveBeenCalledTimes(1);
		expect(binding.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
			"Tedi enrichment failed",
			expect.objectContaining({ error, outcome: "unavailable" }),
		);
	});

	it("returns null when constructing the binding transport throws synchronously", async () => {
		const { env } = bindingEnvironment();
		const error = new Error("Synthetic binding error");
		vi.mocked(serviceBindingFetch).mockImplementationOnce(() => {
			throw error;
		});

		expect(
			await invokeTediEnrichment(env, buildEnrichmentRequest(context())),
		).toBeNull();
		expect(serviceBindingFetch).toHaveBeenCalledTimes(1);
		expect(callRpc).not.toHaveBeenCalled();
		expect(mocks.error).toHaveBeenCalledTimes(1);
		expect(mocks.error).toHaveBeenCalledWith(
			"Tedi enrichment failed",
			expect.objectContaining({ error, outcome: "unavailable" }),
		);
	});
});
