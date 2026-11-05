import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { handleKernelVoiceInput } from "./voice-input-route";
import { mintKernelWsToken } from "./ws-token";
const ORG = "11111111-2222-3333-4444-555555555555",
	KEY = "test-key";
const URL = "https://api.tedix.dev/kernel/voice/input";
afterEach(() => vi.unstubAllGlobals());
function capturingEnv(upgrade = false) {
	const captured: { request?: Request; name?: string } = {};
	const fetch = vi.fn(async (request: Request) => {
		captured.request = request;
		const response = new Response(null);
		if (upgrade) {
			Object.defineProperty(response, "status", { value: 101 });
			Object.defineProperty(response, "webSocket", { value: {} });
		}
		return response;
	});
	const env = {
		PLATFORM_SERVICE_TOKEN: KEY,
		KERNEL_VOICE_INPUT: {
			idFromName: (name: string) => {
				captured.name = name;
				return name;
			},
			get: () => ({ fetch }),
		},
	} as unknown as CloudflareEnv;
	return { env, captured, fetch };
}
describe("handleKernelVoiceInput", () => {
	it("keeps unauthenticated capability probes", async () => {
		expect(
			(await handleKernelVoiceInput(new Request(URL), {} as CloudflareEnv))
				.status,
		).toBe(200);
	});
	it("reports missing bindings", async () => {
		expect(
			(
				await handleKernelVoiceInput(
					new Request(URL, { headers: { Upgrade: "websocket" } }),
					{} as CloudflareEnv,
				)
			).status,
		).toBe(503);
	});
	it.each(["", "?jwt=secret", "?token=secret"])(
		"does not forward before authentication: %s",
		async (suffix) => {
			const { env, fetch, captured } = capturingEnv();
			expect(
				(
					await handleKernelVoiceInput(
						new Request(URL + suffix, {
							headers: {
								Upgrade: "websocket",
								"X-Kernel-Organization-Id": ORG,
								"X-Kernel-Descope-User-Id": "spoofed",
							},
						}),
						env,
					)
				).status,
			).toBe(401);
			expect(fetch).not.toHaveBeenCalled();
			expect(captured.name).toBeUndefined();
		},
	);
	it("forwards the canonical identity and replaces spoofed headers", async () => {
		const { env, fetch, captured } = capturingEnv();
		const { token } = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: "user",
			platformServiceToken: KEY,
		});
		await handleKernelVoiceInput(
			new Request(URL, {
				headers: {
					Upgrade: "websocket",
					Authorization: `Bearer ${token}`,
					"X-Kernel-Organization-Id": "spoofed-org",
					"X-Kernel-Descope-User-Id": "spoofed-user",
				},
			}),
			env,
		);
		expect(fetch).toHaveBeenCalledOnce();
		expect(captured.name).toBe(ORG + ":dictation");
		expect(captured.request?.headers.get("X-Kernel-Organization-Id")).toBe(ORG);
		expect(captured.request?.headers.get("X-Kernel-Descope-User-Id")).toBe(
			"user",
		);
		expect(
			new globalThis.URL(captured.request!.url).searchParams.get(
				"organization",
			),
		).toBe(ORG);
	});
	it("echoes the offered protocol on a successful upgrade", async () => {
		// Node's Response rejects 101; emulate only Workers' upgrade constructor.
		const NativeResponse = Response;
		class UpgradeResponse extends NativeResponse {
			constructor(
				body?: BodyInit | null,
				init?: ResponseInit & { webSocket?: unknown },
			) {
				super(body, init?.status === 101 ? { ...init, status: 200 } : init);
				if (init?.status === 101) {
					Object.defineProperty(this, "status", { value: 101 });
					Object.defineProperty(this, "webSocket", { value: init.webSocket });
				}
			}
		}
		vi.stubGlobal("Response", UpgradeResponse);
		const { env } = capturingEnv(true);
		const { token } = await mintKernelWsToken({
			organizationId: ORG,
			descopeUserId: "user",
			platformServiceToken: KEY,
		});
		const response = await handleKernelVoiceInput(
			new Request(URL, {
				headers: {
					Upgrade: "websocket",
					"Sec-WebSocket-Protocol": `bearer-${token}`,
				},
			}),
			env,
		);
		expect(response.status).toBe(101);
		expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(
			`bearer-${token}`,
		);
	});
});

it("does not forward a scoped token to a different organization", async () => {
	const { env, fetch, captured } = capturingEnv();
	const { token } = await mintKernelWsToken({
		organizationId: ORG,
		descopeUserId: "user",
		platformServiceToken: KEY,
	});
	const response = await handleKernelVoiceInput(
		new Request(URL + "?organization=other", {
			headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` },
		}),
		env,
	);
	expect(response.status).toBe(403);
	expect(fetch).not.toHaveBeenCalled();
	expect(captured.name).toBeUndefined();
});
