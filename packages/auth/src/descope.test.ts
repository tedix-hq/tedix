import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDescopeClient } from "./descope";
import {
	activateTediIdentity,
	deactivateTediIdentity,
	deleteTediIdentity,
} from "./tedi-identity";
import { deleteConnectionTokens } from "./connections";
import {
	deleteConnectionProvider,
	deleteTenantTokens,
} from "./connection-providers.ts";

const env = {
	DESCOPE_PROJECT_ID: "P3fictional",
	DESCOPE_MANAGEMENT_KEY: "fictional-key",
	DESCOPE_BASE_URL: "https://identity.example.com",
};
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function installTransport(
	transport: (
		input: RequestInfo | URL,
		init?: RequestInit,
	) => Promise<Response>,
) {
	vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
		String(input).includes("/license")
			? Promise.resolve(new Response("{}"))
			: transport(input, init),
	);
}

describe("Descope SDK transport", () => {
	it("patches only the tenant name", async () => {
		const transport = vi
			.fn()
			.mockImplementation(async () => new Response("{}"));
		installTransport(transport);
		const result = await createDescopeClient(env).management.tenant.patchTenant(
			"tenant-example",
			{ name: "Example Studio" },
		);
		expect(result.ok).toBe(true);
		expect(transport).toHaveBeenCalledOnce();
		const [url, init] = transport.mock.calls[0]!;
		expect(String(url)).toBe(
			"https://identity.example.com/v1/mgmt/tenant/patch",
		);
		expect(init.method).toBe("PATCH");
		expect(JSON.parse(init.body)).toEqual({
			id: "tenant-example",
			name: "Example Studio",
		});
	});
	it("retries 429 after Retry-After", async () => {
		vi.useFakeTimers();
		const transport = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", { status: 429, headers: { "Retry-After": "2" } }),
			)
			.mockResolvedValueOnce(new Response("{}"));
		installTransport(transport);
		const pending =
			createDescopeClient(env).management.user.delete("tedi:example");
		await vi.advanceTimersByTimeAsync(1999);
		expect(transport).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).ok).toBe(true);
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it("honours an HTTP-date Retry-After", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-16T12:00:00Z"));
		const transport = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 429,
					headers: { "Retry-After": "Fri, 16 Oct 2026 12:00:03 GMT" },
				}),
			)
			.mockResolvedValueOnce(new Response("{}"));
		installTransport(transport);
		const pending =
			createDescopeClient(env).management.user.delete("tedi:example");
		await vi.advanceTimersByTimeAsync(2999);
		expect(transport).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await pending).ok).toBe(true);
	});
	it("returns 429 instead of retrying before a long Retry-After", async () => {
		const transport = vi
			.fn()
			.mockImplementation(
				async () =>
					new Response("{}", { status: 429, headers: { "Retry-After": "60" } }),
			);
		installTransport(transport);
		expect(
			(await createDescopeClient(env).management.user.delete("tedi:example"))
				.ok,
		).toBe(false);
		expect(transport).toHaveBeenCalledOnce();
	});

	it("does not retry a mutation after 503", async () => {
		const transport = vi
			.fn()
			.mockImplementation(async () => new Response("{}", { status: 503 }));
		installTransport(transport);
		expect(
			(await createDescopeClient(env).management.user.delete("tedi:example"))
				.ok,
		).toBe(false);
		expect(transport).toHaveBeenCalledOnce();
	});
	it("aborts a stalled request after ten seconds without retrying", async () => {
		vi.useFakeTimers();
		const transport = vi.fn(
			(_url, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) =>
					init!.signal!.addEventListener("abort", () =>
						reject(new Error("timed out")),
					),
				),
		);
		installTransport(transport);
		const pending =
			createDescopeClient(env).management.user.delete("tedi:example");
		const assertion = expect(pending).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(10000);
		await assertion;
		expect(transport).toHaveBeenCalledOnce();
	});
});

describe("Descope mutation results", () => {
	const failure = {
		ok: false,
		error: { errorCode: "E_TEST", errorDescription: "provider unavailable" },
	};
	it.each([activateTediIdentity, deactivateTediIdentity, deleteTediIdentity])(
		"rejects failed identity lifecycle calls",
		async (operation) => {
			const client = {
				management: {
					user: {
						activate: vi.fn().mockResolvedValue(failure),
						deactivate: vi.fn().mockResolvedValue(failure),
						delete: vi.fn().mockResolvedValue(failure),
					},
				},
			};
			await expect(operation(client as never, "tedi:example")).rejects.toThrow(
				"E_TEST",
			);
		},
	);
	it.each([deleteConnectionProvider, deleteConnectionTokens])(
		"rejects failed connection deletion",
		async (operation) => {
			const client = {
				management: {
					outboundApplication: {
						deleteApplication: vi.fn().mockResolvedValue(failure),
						deleteUserTokens: vi.fn().mockResolvedValue(failure),
					},
				},
			};
			await expect(
				operation(client as never, "provider-example"),
			).rejects.toThrow("E_TEST");
		},
	);
	it("does not delete tokens after a failed lookup and surfaces a failed delete", async () => {
		const remove = vi.fn().mockResolvedValue(failure);
		const lookup = vi.fn().mockResolvedValue(failure);
		const client = {
			management: {
				outboundApplication: {
					fetchTenantToken: lookup,
					deleteTokenById: remove,
				},
			},
		};
		await expect(
			deleteTenantTokens(client as never, "provider-example", "tenant-example"),
		).rejects.toThrow("E_TEST");
		expect(remove).not.toHaveBeenCalled();
		lookup.mockResolvedValue({ ok: true, data: { id: "token-example" } });
		await expect(
			deleteTenantTokens(client as never, "provider-example", "tenant-example"),
		).rejects.toThrow("E_TEST");
		expect(remove).toHaveBeenCalledWith("token-example");
	});
});
