import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	brokerStatusQueryOptions,
	buildOsAuthReturnUrl,
	clearSilentOsResumeAttempt,
	hasAttemptedSilentOsResume,
	markSilentOsResumeAttempted,
	OS_BROKER_STATUS_TIMEOUT_MS,
	OS_SILENT_RESUME_GUARD_KEY,
	shouldAttemptSilentOsResume,
	shouldResumeOsBroker,
	useOsBrokerSessionStatus,
} from "@/shared/session-status";

/**
 * These assert against the shapes `apps/os/src/auth/session-broker.ts` actually
 * emits, which is the whole point of the file.
 *
 * The bug this replaces: the broker signals renewal as a 401 carrying
 * `{ authenticated: false, renewalRequired: true }`, but `shouldResumeOsBroker`
 * returned early on `!authenticated` before reading `renewalRequired`. The
 * surface renders its restoring-session spinner on `renewalRequired`, so a page
 * loaded inside the renewal window showed a permanent spinner — no login, no
 * resume, no error. The previous test passed because it only ever asserted
 * `{ authenticated: true, renewalRequired: true }`, a response that code path
 * cannot produce. A test that describes a state the system cannot reach proves
 * nothing; keep these pinned to the emitted shapes.
 */
describe("shouldResumeOsBroker — against the shapes the broker emits", () => {
	/** The 401 renewal body, verbatim from auth/session-broker.ts. */
	const RENEWAL_401 = { authenticated: false, renewalRequired: true } as const;
	/** The 200 body: no renewalRequired field at all. */
	const AUTHENTICATED_200 = {
		authenticated: true,
		expiresAt: 1_800_000_000,
		tenantId: "tenant-1",
	} as const;
	/** The fetch-failure fallback the hook sets. */
	const UNAUTHENTICATED = { authenticated: false } as const;

	it("resumes on the renewal 401 the broker actually sends", () => {
		expect(shouldResumeOsBroker(RENEWAL_401, false)).toBe(true);
	});

	it("does not resume an authenticated session, which carries no renewal flag", () => {
		expect(shouldResumeOsBroker(AUTHENTICATED_200, false)).toBe(false);
	});

	it("does not resume a plain unauthenticated status — that renders login", () => {
		expect(shouldResumeOsBroker(UNAUTHENTICATED, false)).toBe(false);
	});

	it("refuses to resume after returning FROM the broker with an error", () => {
		// The loop-breaker. Without it a broker that keeps failing would bounce
		// the document forever instead of showing the login surface.
		expect(shouldResumeOsBroker(RENEWAL_401, true)).toBe(false);
	});

	it("treats renewal as the signal regardless of the authenticated flag", () => {
		// Guards the regression directly: reintroducing an `authenticated` gate
		// fails here, because the emitted renewal shape is unauthenticated.
		expect(
			shouldResumeOsBroker(
				{ authenticated: true, renewalRequired: true },
				false,
			),
		).toBe(true);
		expect(shouldResumeOsBroker(RENEWAL_401, false)).toBe(true);
	});
});

describe("shouldAttemptSilentOsResume — one unattended broker pass", () => {
	const UNAUTHENTICATED = { authenticated: false } as const;
	const RENEWAL_401 = { authenticated: false, renewalRequired: true } as const;

	it("attempts on a fresh unauthenticated status", () => {
		expect(shouldAttemptSilentOsResume(UNAUTHENTICATED, false, false)).toBe(
			true,
		);
	});

	it("never attempts twice per tab session", () => {
		expect(shouldAttemptSilentOsResume(UNAUTHENTICATED, false, true)).toBe(
			false,
		);
	});

	it("never attempts after returning FROM the broker with ?error", () => {
		expect(shouldAttemptSilentOsResume(UNAUTHENTICATED, true, false)).toBe(
			false,
		);
	});

	it("leaves the renewal 401 to shouldResumeOsBroker", () => {
		expect(shouldAttemptSilentOsResume(RENEWAL_401, false, false)).toBe(false);
	});

	it("does nothing for an authenticated status", () => {
		expect(
			shouldAttemptSilentOsResume({ authenticated: true }, false, false),
		).toBe(false);
	});
});

describe("silent-resume guard storage helpers", () => {
	function memoryStorage(): Pick<
		Storage,
		"getItem" | "removeItem" | "setItem"
	> {
		const map = new Map<string, string>();
		return {
			getItem: (key) => map.get(key) ?? null,
			removeItem: (key) => void map.delete(key),
			setItem: (key, value) => void map.set(key, value),
		};
	}

	it("marks, reads, and clears the guard", () => {
		const storage = memoryStorage();
		expect(hasAttemptedSilentOsResume(storage)).toBe(false);
		markSilentOsResumeAttempted(storage);
		expect(storage.getItem(OS_SILENT_RESUME_GUARD_KEY)).toBe("1");
		expect(hasAttemptedSilentOsResume(storage)).toBe(true);
		clearSilentOsResumeAttempt(storage);
		expect(hasAttemptedSilentOsResume(storage)).toBe(false);
	});

	it("treats a throwing storage as already attempted — never a loop risk", () => {
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(hasAttemptedSilentOsResume(throwing)).toBe(true);
		expect(() => markSilentOsResumeAttempted(throwing)).not.toThrow();
		expect(() => clearSilentOsResumeAttempt(throwing)).not.toThrow();
	});
});

describe("buildOsAuthReturnUrl", () => {
	it("strips a stale broker error so the resume target cannot re-trip the guard", () => {
		expect(
			buildOsAuthReturnUrl(
				"https://tedix.os.tedix.dev/workspace/workspace-1?error=denied&a=1",
			),
		).toBe("https://tedix.os.tedix.dev/workspace/workspace-1?a=1");
	});
});

describe("useOsBrokerSessionStatus — startup prefetch", () => {
	it.each(["pending", "success", "failure"] as const)(
		"shares a %s startup request and retries only on demand",
		async (startup) => {
			(
				globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
			).IS_REACT_ACT_ENVIRONMENT = true;
			const client = new QueryClient({
				defaultOptions: { queries: { retry: 2 } },
			});
			let finish!: (response: Response) => void;
			const fetchStatus = vi
				.fn()
				.mockImplementationOnce(
					() =>
						new Promise<Response>((resolve) => {
							finish = resolve;
						}),
				)
				.mockImplementation(() =>
					Promise.resolve(
						new Response(JSON.stringify({ authenticated: true })),
					),
				);
			vi.stubGlobal("fetch", fetchStatus);
			const container = document.createElement("div");
			const root = createRoot(container);
			let session!: ReturnType<typeof useOsBrokerSessionStatus>;
			function Probe() {
				session = useOsBrokerSessionStatus("/auth/session-broker");
				return null;
			}
			const response = () =>
				new Response(JSON.stringify({ authenticated: true }), {
					status: startup === "failure" ? 503 : 200,
				});
			try {
				const prefetch = client.prefetchQuery(
					brokerStatusQueryOptions("/auth/session-broker"),
				);
				expect(fetchStatus).toHaveBeenCalledTimes(1);
				const [url, init] = fetchStatus.mock.calls[0]!;
				expect(url).toBe("/auth/session-broker/status");
				expect(init.credentials).toBe("include");
				expect(init.signal).toBeInstanceOf(AbortSignal);
				expect(init.signal.aborted).toBe(false);
				expect(OS_BROKER_STATUS_TIMEOUT_MS).toBe(15_000);
				if (startup !== "pending") {
					finish(response());
					await prefetch;
				}
				await act(async () => {
					root.render(
						createElement(
							QueryClientProvider,
							{ client },
							createElement(Probe),
						),
					);
				});
				expect(fetchStatus).toHaveBeenCalledTimes(1);
				if (startup === "pending") {
					expect(session.status).toBeNull();
					await act(async () => {
						finish(response());
						await prefetch;
					});
				}
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
				if (startup === "failure") {
					expect(session.unavailable).toBe(true);
					expect(session.status).toBeNull();
					await act(async () => {
						session.retryStatus();
						expect(fetchStatus).toHaveBeenCalledTimes(2);
					});
					await act(async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
					});
				}
				expect(session.unavailable).toBe(false);
				expect(session.status?.authenticated).toBe(true);
				expect(fetchStatus).toHaveBeenCalledTimes(
					startup === "failure" ? 2 : 1,
				);
				await client.prefetchQuery(
					brokerStatusQueryOptions("/cli/session-broker"),
				);
				expect(fetchStatus.mock.calls.at(-1)?.[0]).toBe(
					"/cli/session-broker/status",
				);
			} finally {
				await act(async () => {
					root.unmount();
				});
				client.clear();
				vi.unstubAllGlobals();
			}
		},
	);
});
