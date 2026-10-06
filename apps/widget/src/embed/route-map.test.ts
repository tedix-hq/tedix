import { describe, expect, it, vi } from "vite-plus/test";
import {
	bindHostNavigation,
	compileHostRouteMap,
	parseHostRouteRules,
} from "./route-map";

const rules = [
	{ match: "/app/dashboard", routeKey: "dashboard" },
	{
		match: "/app/orders/:orderId",
		routeKey: "order-detail",
		title: "Order :orderId",
		entity: { type: "order", id: ":orderId", label: "Order #:orderId" },
	},
	{ match: "/app/orders", routeKey: "orders" },
	{ match: "/app/settings/*", routeKey: "settings" },
];

describe("compileHostRouteMap", () => {
	it("declares nothing for an empty or malformed rule set", () => {
		expect(compileHostRouteMap(null)).toBeNull();
		expect(compileHostRouteMap([])).toBeNull();
		expect(compileHostRouteMap([{ match: "app/orders" }])).toBeNull();
		expect(compileHostRouteMap(["/app/orders"])).toBeNull();
	});

	it("matches a literal route", () => {
		const match = compileHostRouteMap(rules)!;
		expect(match("/app/dashboard")).toEqual({
			pathname: "/app/dashboard",
			routeKey: "dashboard",
		});
	});

	it("tolerates a trailing slash on both sides", () => {
		const match = compileHostRouteMap([
			{ match: "/app/orders/", routeKey: "orders" },
		])!;
		expect(match("/app/orders").routeKey).toBe("orders");
		expect(match("/app/orders/").routeKey).toBe("orders");
	});

	it("captures params and interpolates entity and title templates", () => {
		const match = compileHostRouteMap(rules)!;
		expect(match("/app/orders/4821")).toEqual({
			pathname: "/app/orders/4821",
			routeKey: "order-detail",
			title: "Order 4821",
			params: { orderId: "4821" },
			entity: { type: "order", id: "4821", label: "Order #4821" },
		});
	});

	it("keeps rule order so a literal route can precede its pattern", () => {
		const match = compileHostRouteMap([
			{ match: "/app/orders/new", routeKey: "order-new" },
			{ match: "/app/orders/:orderId", routeKey: "order-detail" },
		])!;
		expect(match("/app/orders/new").routeKey).toBe("order-new");
		expect(match("/app/orders/12").routeKey).toBe("order-detail");
	});

	it("decodes a captured segment", () => {
		const match = compileHostRouteMap([
			{ match: "/app/clients/:name", entity: { type: "client", id: ":name" } },
		])!;
		expect(match("/app/clients/Taller%20Mora").entity).toEqual({
			type: "client",
			id: "Taller Mora",
		});
	});

	it("matches a wildcard tail and its own index, but not a sibling", () => {
		const match = compileHostRouteMap(rules)!;
		expect(match("/app/settings/billing/plan").routeKey).toBe("settings");
		expect(match("/app/settings").routeKey).toBe("settings");
		expect(match("/app/setting").routeKey).toBeUndefined();
	});

	it("returns the bare pathname when nothing matches", () => {
		const match = compileHostRouteMap(rules)!;
		expect(match("/app/inventory")).toEqual({ pathname: "/app/inventory" });
	});

	it("drops a field whose template references an uncaptured param", () => {
		const match = compileHostRouteMap([
			{
				match: "/app/orders/:orderId",
				title: "Order :missing",
				entity: { type: "order", id: ":missing" },
				params: { label: "Order :orderId", broken: ":missing" },
			},
		])!;
		const result = match("/app/orders/9");
		expect(result.title).toBeUndefined();
		expect(result.entity).toBeUndefined();
		expect(result.params).toEqual({ orderId: "9", label: "Order 9" });
	});

	it("rejects an invalid param name and a partial entity", () => {
		expect(compileHostRouteMap([{ match: "/app/:1bad" }])).toBeNull();
		const match = compileHostRouteMap([
			{ match: "/app/x", entity: { type: "order" } },
		])!;
		expect(match("/app/x").entity).toBeUndefined();
	});

	it("bounds the declared rule count", () => {
		const many = Array.from({ length: 80 }, (_, index) => ({
			match: `/app/r${index}`,
			routeKey: `r${index}`,
		}));
		const match = compileHostRouteMap(many)!;
		expect(match("/app/r63").routeKey).toBe("r63");
		expect(match("/app/r64").routeKey).toBeUndefined();
	});
});

describe("parseHostRouteRules", () => {
	it("parses a JSON attribute and ignores malformed input", () => {
		expect(parseHostRouteRules('[{"match":"/a"}]')).toEqual([{ match: "/a" }]);
		expect(parseHostRouteRules("{oops")).toBeNull();
		expect(parseHostRouteRules(undefined)).toBeNull();
	});
});

describe("bindHostNavigation", () => {
	function fakeWindow() {
		const listeners = new Map<string, Set<() => void>>();
		return {
			location: { pathname: "/app/orders" },
			history: {
				pushState() {
					return "pushed";
				},
				replaceState() {
					return "replaced";
				},
			},
			addEventListener(name: string, callback: () => void) {
				(listeners.get(name) ?? listeners.set(name, new Set()).get(name)!).add(
					callback,
				);
			},
			removeEventListener(name: string, callback: () => void) {
				listeners.get(name)?.delete(callback);
			},
			dispatch(name: string) {
				for (const callback of listeners.get(name) ?? []) callback();
			},
			listeners,
		};
	}

	it("announces pushState, replaceState and popstate", () => {
		const target = fakeWindow();
		const onNavigate = vi.fn();
		bindHostNavigation(target, onNavigate);
		target.location.pathname = "/app/orders/7";
		target.history.pushState();
		target.history.replaceState();
		target.dispatch("popstate");
		expect(onNavigate).toHaveBeenCalledTimes(3);
		expect(onNavigate).toHaveBeenLastCalledWith("/app/orders/7");
	});

	it("preserves the original history return value", () => {
		const target = fakeWindow();
		bindHostNavigation(target, () => {});
		expect(target.history.pushState()).toBe("pushed");
	});

	it("restores the history methods and drops the listener on dispose", () => {
		const target = fakeWindow();
		const original = target.history.pushState;
		const onNavigate = vi.fn();
		const dispose = bindHostNavigation(target, onNavigate);
		dispose();
		expect(target.history.pushState).toBe(original);
		target.dispatch("popstate");
		expect(onNavigate).not.toHaveBeenCalled();
		expect(target.listeners.get("popstate")?.size ?? 0).toBe(0);
	});
});
