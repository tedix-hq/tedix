import { issueCustodyInspectionScope } from "../../context";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { cutoverInventoryFromAdminFetch } from "./cutover-inventory";
import { agentAdminFetch } from "./crud";
import type { BaseContext } from "../../orpc";
const objectId = "a".repeat(64);
const generic = "Runtime cutover inventory unavailable";
const known = [
	"inspection_metadata_changed",
	"admission_epoch_changed",
	"inspection_owner_mismatch",
	"inspection_owner_unavailable",
	"canonical_custody_mismatch",
	"passive_inspection_unavailable",
	"verification_rejected",
];
function refusal(status: number, json: unknown) {
	try {
		cutoverInventoryFromAdminFetch({ ok: false, status, json }, objectId);
	} catch (error) {
		expect(error).toMatchObject({ code: "BAD_GATEWAY" });
		return (error as Error).message;
	}
	throw new Error("Expected refusal");
}
describe("closed inspection refusal diagnostics", () => {
	it.each(known)(
		"exposes only known code %s with bounded HTTP status",
		(rejection) => {
			expect(refusal(409, { ok: false, rejection })).toBe(
				`${generic} (runtime status 409; rejection ${rejection})`,
			);
		},
	);
	it.each([100, 200, 302, 399, 400, 503, 599])(
		"bounds valid failure status %s",
		(status) => {
			expect(refusal(status, { ok: false, rejection: known[0] })).toBe(
				`${generic} (runtime status ${status}; rejection ${known[0]})`,
			);
		},
	);
	it.each([0, -1, 99, 600, 409.5, NaN, Infinity])(
		"keeps invalid failure status %s generic",
		(status) => {
			expect(refusal(status, { ok: false, rejection: known[0] })).toBe(generic);
		},
	);
	it.each([
		"secret_provider_token",
		"nonterminal_sdk_work",
		"inspection_owner_secret",
		"inspection_metadata_changed\nPRIVATE",
		"<script>private</script>",
		"x".repeat(10000),
	])("does not trust arbitrary labels %s", (rejection) => {
		expect(refusal(503, { ok: false, rejection })).toBe(
			`${generic} (runtime status 503)`,
		);
	});
	it.each([
		null,
		"PRIVATE provider payload",
		[],
		{ ok: true, rejection: known[0] },
		{ rejection: known[0] },
		{ ok: false },
		{ ok: false, rejection: 42 },
		{ ok: false, rejection: known[0], error: "PRIVATE stored value" },
		{ ok: false, rejection: { private: "secret" } },
	])("keeps malformed or extra payload private %#", (body) => {
		expect(refusal(409, body)).toBe(`${generic} (runtime status 409)`);
	});
	it("keeps getters and hostile object exceptions private", () => {
		const body = {
			ok: false,
			get rejection() {
				throw new Error("PRIVATE getter error");
			},
		};
		expect(refusal(409, body)).toBe(`${generic} (runtime status 409)`);
		expect(
			refusal(
				409,
				new Proxy(
					{},
					{
						ownKeys() {
							throw new Error("PRIVATE proxy error");
						},
					},
				),
			),
		).toBe(`${generic} (runtime status 409)`);
	});
	it("never invokes a hostile status accessor", () => {
		let calls = 0;
		const result = {
			ok: false,
			get status() {
				calls++;
				return calls < 4 ? 409 : "PRIVATE-status";
			},
			json: { ok: false, rejection: known[0] },
		};
		expect(() =>
			cutoverInventoryFromAdminFetch(result as never, objectId),
		).toThrow(generic);
		expect(calls).toBe(0);
	});
	it.each(["symbol", "nonenumerable"])(
		"rejects extra own %s refusal fields",
		(kind) => {
			const body = { ok: false, rejection: known[0] };
			Object.defineProperty(
				body,
				kind === "symbol" ? Symbol("PRIVATE") : "private",
				{ value: "PRIVATE" },
			);
			expect(refusal(409, body)).toBe(`${generic} (runtime status 409)`);
		},
	);
	it("keeps transport errors private", () => {
		expect(() =>
			cutoverInventoryFromAdminFetch(
				{ error: "PRIVATE transport exception", failure: "transport_failure" },
				objectId,
			),
		).toThrow(`${generic} (transport transport_failure)`);
	});
	it("does not accept inherited refusal properties", () => {
		expect(
			refusal(409, Object.create({ ok: false, rejection: known[0] })),
		).toBe(`${generic} (runtime status 409)`);
	});
});

afterEach(() => vi.useRealTimers());
function adminContext(
	fetcher?: typeof fetch,
	secret: string | null = "PRIVATE-master",
) {
	return {
		env: {
			ENVIRONMENT: "production",
			SECRETS_MASTER_KEY: secret,
			...(fetcher ? { TEDI_SERVICE: { fetch: fetcher } } : {}),
		},
	} as unknown as BaseContext;
}
const options = {
	method: "GET",
	requireServiceBinding: true,
	timeoutMs: 10,
} as const;
describe("source-owned admin transport failure provenance", () => {
	it("tags the actual setup branches before dispatch", async () => {
		const fetcher = vi.fn<typeof fetch>();
		expect(
			await agentAdminFetch(
				adminContext(fetcher),
				{ slug: null },
				"/__admin/pi-state-cutover",
				options,
			),
		).toEqual({
			error: "no_provisioning_config",
			failure: "no_provisioning_config",
		});
		expect(
			await agentAdminFetch(
				adminContext(),
				{ slug: "fixture" },
				"/__admin/pi-state-cutover",
				options,
			),
		).toEqual({
			error: "service_binding_unavailable",
			failure: "service_binding_unavailable",
		});
		expect(
			await agentAdminFetch(
				adminContext(fetcher, null),
				{ slug: "fixture" },
				"/__admin/pi-state-cutover",
				options,
			),
		).toEqual({
			error: "secrets_master_key_unavailable",
			failure: "secrets_master_key_unavailable",
		});
		expect(fetcher).not.toHaveBeenCalled();
	});
	it.each([
		"no_provisioning_config",
		"service_binding_unavailable",
		"secrets_master_key_unavailable",
		"timeout_after_10ms",
	])("does not trust exception text/name/category %s", async (message) => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw Object.assign(new Error(message), {
				name: "AbortError",
				category: "timeout",
			});
		});
		const result = await agentAdminFetch(
			adminContext(fetcher),
			{ slug: "fixture" },
			"/__admin/pi-state-cutover",
			options,
		);
		expect(result).toMatchObject({ failure: "transport_failure" });
		expect(() => cutoverInventoryFromAdminFetch(result, objectId)).toThrow(
			`${generic} (transport transport_failure)`,
		);
	});
	it.each(["fetch", "body", "body-abort"])(
		"owned deadline wins after %s await",
		async (stage) => {
			vi.useFakeTimers();
			const fetcher = vi.fn<typeof fetch>(async () => {
				if (stage === "fetch")
					await new Promise((resolve) => setTimeout(resolve, 20));
				return new Response(
					new ReadableStream({
						async start(controller) {
							if (stage !== "fetch")
								await new Promise((resolve) => setTimeout(resolve, 20));
							if (stage === "body-abort")
								controller.error(new DOMException("PRIVATE", "AbortError"));
							else {
								controller.enqueue(new TextEncoder().encode("{}"));
								controller.close();
							}
						},
					}),
				);
			});
			const result = agentAdminFetch(
				adminContext(fetcher),
				{ slug: "fixture" },
				"/__admin/pi-state-cutover",
				options,
			);
			await vi.advanceTimersByTimeAsync(30);
			expect(await result).toEqual({
				error: "timeout_after_10ms",
				failure: "timeout",
			});
		},
	);
	it("retains non-JSON response status without disclosing its body", async () => {
		const result = await agentAdminFetch(
			adminContext(async () => new Response("PRIVATE-token", { status: 403 })),
			{ slug: "fixture" },
			"/__admin/pi-state-cutover",
			options,
		);
		expect(result).toEqual({ ok: false, status: 403, json: null });
		expect(() => cutoverInventoryFromAdminFetch(result, objectId)).toThrow(
			`${generic} (runtime status 403)`,
		);
	});
});

describe("original selected custody transport scope", () => {
	it.each(["fetch", "body"])(
		"bounds abort-ignoring pending %s and initiates owned cancellation",
		async (stage) => {
			vi.useFakeTimers();
			const caller = new AbortController();
			const scope = issueCustodyInspectionScope(caller.signal);
			let cancelCalls = 0;
			let resolveFetch!: (value: Response) => void;
			let ownedSignal: AbortSignal | undefined;
			const response = new Response(
				new ReadableStream<Uint8Array>({
					cancel() {
						cancelCalls++;
						return new Promise<void>(() => {});
					},
				}),
			);
			const fetcher = vi.fn<typeof fetch>((_url, init) => {
				ownedSignal = init?.signal as AbortSignal;
				return stage === "fetch"
					? new Promise<Response>((r) => {
							resolveFetch = r;
						})
					: Promise.resolve(response);
			});
			const p = agentAdminFetch(
				adminContext(fetcher),
				{ slug: "fixture" },
				"/__admin/pi-state-cutover",
				{
					method: "POST",
					requireServiceBinding: true,
					timeoutMs: 30_000,
					body: { command: "inspect_custody_coverage" },
					custodyInspectionScope: scope,
				},
			);
			const checked = expect(p).resolves.toMatchObject({ failure: "timeout" });
			await vi.advanceTimersByTimeAsync(30_000);
			await checked;
			expect(ownedSignal?.aborted).toBe(true);
			if (stage === "body") expect(cancelCalls).toBe(1);
			else {
				resolveFetch(response);
				await Promise.resolve();
			}
			expect(() => scope.guard()).toThrow();
		},
	);
	it("requires a real context-issued scope before selected service dispatch", async () => {
		const fetcher = vi.fn<typeof fetch>();
		await expect(
			agentAdminFetch(
				adminContext(fetcher),
				{ slug: "fixture" },
				"/__admin/pi-state-cutover",
				{
					method: "POST",
					requireServiceBinding: true,
					timeoutMs: 30_000,
					body: { command: "inspect_custody_coverage" },
				},
			),
		).rejects.toThrow("scope unavailable");
		expect(fetcher).not.toHaveBeenCalled();
	});
});
