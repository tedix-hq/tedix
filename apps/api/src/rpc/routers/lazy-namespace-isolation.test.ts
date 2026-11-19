/**
 * Guards the per-namespace laziness of the router tree.
 *
 * `src/index.ts` keeps the router graph off *script* startup (the 1s limit,
 * error 10021) by importing `./worker-app` dynamically. That never removed the
 * work — it moved it to the first request of every isolate, and under load
 * concurrent requests land on fresh isolates and each pays it again. Most of
 * the eager tree's evaluation cost is `@tedix/api-contract` schemas +
 * contracts.
 *
 * `apiRouter` therefore holds a `Lazy` per namespace, so a request materialises
 * only the branch it routes into. Contract parity checks the complete router
 * tree. This suite checks that all namespaces are deferred and that the
 * matcher can resolve a branch without loading its siblings.
 */

import { Lazy, os } from "@orpc/server";
import { RPCMatcher } from "@orpc/server/standard";
import { describe, expect, it } from "vite-plus/test";
import { apiRouter } from "./index";

describe("lazy namespace isolation", () => {
	it("defers every namespace", () => {
		const eager = Object.entries(apiRouter)
			.filter(([, router]) => !(router instanceof Lazy))
			.map(([key]) => key);

		expect(eager).toEqual([]);
	});

	it("resolves a procedure from the lazy API tree through the matcher", async () => {
		const matcher = new RPCMatcher(apiRouter as never);

		await expect(
			matcher.match("POST", "/audit/search", undefined),
		).resolves.toMatchObject({ path: ["audit", "search"] });
	});

	/**
	 * Pins the oRPC behaviour the fix depends on, using the exact `Lazy` shape
	 * `apiRouter` is built from. If a future `@orpc/server` indexes lazy children
	 * eagerly, every other assertion here still passes while the CPU win is
	 * silently gone — this is the only test that fails.
	 */
	it("unlazies only the namespace a request routes into", async () => {
		const loaded: string[] = [];
		const lazyNamespace = (name: string, router: unknown) =>
			new Lazy({
				meta: {},
				loader: async () => {
					loaded.push(name);
					return { default: router };
				},
			});

		const build = () => ({ ping: os.handler(() => "pong") });

		const matcher = new RPCMatcher({
			alpha: lazyNamespace("alpha", build()),
			beta: lazyNamespace("beta", build()),
		} as never);

		expect(loaded).toEqual([]);

		await expect(
			matcher.match("POST", "/alpha/ping", undefined),
		).resolves.toMatchObject({
			path: ["alpha", "ping"],
		});
		expect(loaded).toEqual(["alpha"]);

		await expect(
			matcher.match("POST", "/beta/ping", undefined),
		).resolves.toMatchObject({
			path: ["beta", "ping"],
		});
		expect(loaded).toEqual(["alpha", "beta"]);
	});
});
