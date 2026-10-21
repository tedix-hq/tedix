import {
	callRpc,
	RpcCallError,
	serviceBindingFetch,
} from "@tedix/api-client/internal";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { callApiRpc } from "./rpc";

vi.mock("@tedix/api-client/internal", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tedix/api-client/internal")>();
	return { ...actual, callRpc: vi.fn(), serviceBindingFetch: vi.fn() };
});

const API_URL = "https://api.example.test/custom-prefix/";
const PATH = "kernelRuntime/readRun";
const input = { runId: "run-example" };
const binding = { fetch: vi.fn() } as unknown as Fetcher;
const bindingFetch = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.mocked(callRpc).mockReset();
	vi.mocked(serviceBindingFetch).mockReset().mockReturnValue(bindingFetch);
	bindingFetch.mockReset();
});

describe("callApiRpc transport", () => {
	it.each([
		{
			name: "default binding",
			hasBinding: true,
			serviceBinding: undefined,
			useBinding: true,
		},
		{
			name: "explicit binding",
			hasBinding: true,
			serviceBinding: true,
			useBinding: true,
		},
		{
			name: "explicit HTTPS",
			hasBinding: true,
			serviceBinding: false,
			useBinding: false,
		},
		{
			name: "absent binding",
			hasBinding: false,
			serviceBinding: undefined,
			useBinding: false,
		},
		{
			name: "requested but absent binding",
			hasBinding: false,
			serviceBinding: true,
			useBinding: false,
		},
	])(
		"preserves caller options over $name",
		async ({ hasBinding, serviceBinding, useBinding }) => {
			const headers = Object.freeze({
				Authorization: "Bearer example-caller-token",
				"X-Tedix-Org-Id": "org-example",
				"X-Tedix-Tedi-Scopes": "work:read",
				"X-Request-Id": "request-example",
			});
			const signal = new AbortController().signal;
			const data = { json: { run: input }, rows: [null, false, 0] };
			vi.mocked(callRpc).mockResolvedValueOnce(data);

			const result = await callApiRpc(
				{ API_URL, ...(hasBinding ? { API_SERVICE: binding } : {}) },
				PATH,
				input,
				{ headers, serviceBinding, timeoutMs: 4321, signal },
			);

			expect(result).toEqual({ data, status: 200 });
			expect(result.data).toBe(data);
			expect(callRpc).toHaveBeenCalledExactlyOnceWith(PATH, input, {
				apiUrl: useBinding ? "https://api" : API_URL,
				fetch: useBinding ? bindingFetch : undefined,
				headers: useBinding
					? { "X-Service-Binding": "true", ...headers }
					: headers,
				timeoutMs: 4321,
				signal,
			});
			expect(vi.mocked(callRpc).mock.calls[0]?.[1]).toBe(input);
			expect(vi.mocked(callRpc).mock.calls[0]?.[2].signal).toBe(signal);
			if (useBinding) {
				expect(serviceBindingFetch).toHaveBeenCalledExactlyOnceWith(binding);
			} else {
				expect(serviceBindingFetch).not.toHaveBeenCalled();
			}
		},
	);

	it.each([true, false])(
		"does not invent credentials or deadlines (binding: %s)",
		async (useBinding) => {
			vi.mocked(callRpc).mockResolvedValueOnce(null);

			expect(
				await callApiRpc(
					{ API_URL, ...(useBinding ? { API_SERVICE: binding } : {}) },
					PATH,
					input,
				),
			).toEqual({ data: null, status: 200 });
			expect(callRpc).toHaveBeenCalledExactlyOnceWith(PATH, input, {
				apiUrl: useBinding ? "https://api" : API_URL,
				fetch: useBinding ? bindingFetch : undefined,
				headers: useBinding ? { "X-Service-Binding": "true" } : {},
				timeoutMs: undefined,
				signal: undefined,
			});
		},
	);

	it("preserves a caller override of the service-binding header without mutating it", async () => {
		const headers = Object.freeze({ "X-Service-Binding": "caller-value" });
		vi.mocked(callRpc).mockResolvedValueOnce(false);

		expect(
			await callApiRpc({ API_URL, API_SERVICE: binding }, PATH, input, {
				headers,
			}),
		).toEqual({ data: false, status: 200 });
		expect(vi.mocked(callRpc).mock.calls[0]?.[2].headers).toEqual(headers);
		expect(serviceBindingFetch).toHaveBeenCalledExactlyOnceWith(binding);
		expect(callRpc).toHaveBeenCalledOnce();
	});
});

describe.each([400, 401, 403, 429, 503])("callApiRpc HTTP %s", (status) => {
	it.each([
		{
			name: "raw JSON",
			detail: '{"code":"DENIED","nested":{"retry":false},"rows":[0,null]}',
			data: { code: "DENIED", nested: { retry: false }, rows: [0, null] },
		},
		{
			name: "JSON envelope",
			detail:
				'{"json":{"code":"DENIED","nested":{"retry":false},"rows":[0,null]},"meta":{"ignored":true}}',
			data: { code: "DENIED", nested: { retry: false }, rows: [0, null] },
		},
		{
			name: "non-JSON detail",
			detail: "upstream unavailable\n<html>retry later</html>",
			data: "upstream unavailable\n<html>retry later</html>",
		},
	])(
		"preserves status and $name without retrying",
		async ({ detail, data }) => {
			vi.mocked(callRpc).mockRejectedValueOnce(
				new RpcCallError(PATH, status, detail, "Failure", undefined),
			);
			const signal = new AbortController().signal;
			const headers = { "X-Tedix-Org-Id": "org-example" };

			expect(
				await callApiRpc({ API_URL }, PATH, input, {
					headers,
					signal,
					timeoutMs: 1234,
				}),
			).toEqual({ data, status });
			expect(callRpc).toHaveBeenCalledExactlyOnceWith(PATH, input, {
				apiUrl: API_URL,
				fetch: undefined,
				headers,
				timeoutMs: 1234,
				signal,
			});
			expect(serviceBindingFetch).not.toHaveBeenCalled();
		},
	);
});

describe("callApiRpc error values", () => {
	it.each([
		{ detail: "null", data: null },
		{ detail: "false", data: false },
		{ detail: "0", data: 0 },
		{ detail: '["problem",null]', data: ["problem", null] },
		{ detail: '"problem"', data: "problem" },
		{ detail: '{"json":null}', data: null },
		{ detail: '{"json":false}', data: false },
		{ detail: '{"json":0}', data: 0 },
		{
			detail: '{"json":{"json":{"message":"nested"}}}',
			data: { json: { message: "nested" } },
		},
		{ detail: "", data: "" },
		{ detail: '{"json":', data: '{"json":' },
	])(
		"decodes $detail without losing falsy values or unwrapping twice",
		async ({ detail, data }) => {
			vi.mocked(callRpc).mockRejectedValueOnce(
				new RpcCallError(PATH, 400, detail, "Bad Request", undefined),
			);

			expect(await callApiRpc({ API_URL }, PATH, input)).toEqual({
				data,
				status: 400,
			});
			expect(callRpc).toHaveBeenCalledOnce();
		},
	);

	it.each([
		new Error("unrelated transport failure"),
		new DOMException("cancelled", "AbortError"),
		{ name: "RpcCallError", status: 503, detail: '{"message":"lookalike"}' },
		"non-Error rejection",
	])(
		"rethrows unrelated rejection %# by identity without retrying",
		async (error) => {
			const controller = new AbortController();
			controller.abort(error);
			vi.mocked(callRpc).mockRejectedValueOnce(error);

			await expect(
				callApiRpc({ API_URL, API_SERVICE: binding }, PATH, input, {
					signal: controller.signal,
					timeoutMs: 987,
				}),
			).rejects.toBe(error);
			expect(callRpc).toHaveBeenCalledExactlyOnceWith(PATH, input, {
				apiUrl: "https://api",
				fetch: bindingFetch,
				headers: { "X-Service-Binding": "true" },
				timeoutMs: 987,
				signal: controller.signal,
			});
			expect(serviceBindingFetch).toHaveBeenCalledExactlyOnceWith(binding);
		},
	);
});
