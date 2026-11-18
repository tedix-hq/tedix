import { describe, expect, it, vi } from "vite-plus/test";
import { createContext, d1SessionConstraintFor } from "./context";
import type { BaseContext } from "./context";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import "@orpc/openapi/extensions/route";
import { withD1ReadRouting } from "./d1-read-routing";

const at = (path: string) =>
	new Request(`https://api.internal${path}`, { method: "POST" });

describe("d1SessionConstraintFor", () => {
	it.each(["GET", "HEAD", "POST", "DELETE"] as const)(
		"routes POST RPC transport using the %s contract before database access",
		async (method) => {
			const withSession = vi.fn(() => ({ getBookmark: () => "after-query" }));
			const request = new Request("https://api.internal/rpc/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ json: {} }),
			});
			const context = createContext(request, {
				DB: { withSession },
			} as unknown as CloudflareEnv);
			const procedure = os
				.$context<BaseContext>()
				.route({ method })
				.handler(({ context }) => {
					void context.db;
					return "ok";
				});
			const handler = new RPCHandler(
				{ run: procedure },
				{ clientInterceptors: [withD1ReadRouting] },
			);
			const result = await handler.handle(request, { prefix: "/rpc", context });
			expect(result.response?.status).toBe(200);
			expect(withSession).toHaveBeenCalledExactlyOnceWith(
				method === "GET" || method === "HEAD"
					? "first-unconstrained"
					: "first-primary",
			);
		},
	);
	it.each([
		[true, undefined, "first-unconstrained"],
		[false, undefined, "first-primary"],
		[true, "after-write", "after-write"],
		[false, "after-write", "after-write"],
	] as const)(
		"opens one lazy session (read=%s, bookmark=%s)",
		(readOnly, bookmark, expected) => {
			const withSession = vi.fn(() => ({ getBookmark: () => "after-query" }));
			const request = new Request(
				"https://api.internal/rpc/userProfile/getMine",
				{
					method: "POST",
					headers: bookmark ? { "x-d1-bookmark": bookmark } : {},
				},
			);
			const context = createContext(request, {
				DB: { withSession },
			} as unknown as CloudflareEnv);
			expect(withSession).not.toHaveBeenCalled();
			context.dbReadOnly = readOnly;
			expect(context.dbMetrics).toEqual({
				queries: 0,
				rowsRead: 0,
				rowsWritten: 0,
				withoutMeta: 0,
			});
			const db = context.db;
			expect(context.db).toBe(db);
			expect(withSession).toHaveBeenCalledExactlyOnceWith(expected);
			expect(context.dbBookmark?.()).toBe("after-query");
		},
	);
	it("lets the grant check and discovery reads start on a replica", () => {
		expect(
			d1SessionConstraintFor(at("/rpc/organizations/verifyMultiOrgMcpGrant")),
		).toBe("first-unconstrained");
		expect(d1SessionConstraintFor(at("/rpc/apps/getBySlugsWithTools"))).toBe(
			"first-unconstrained",
		);
		expect(d1SessionConstraintFor(at("/rpc/skills/listSummariesByApps"))).toBe(
			"first-unconstrained",
		);
	});

	it("keeps every other request on the primary", () => {
		expect(d1SessionConstraintFor(at("/rpc/workItems/claim"))).toBe(
			"first-primary",
		);
		expect(
			d1SessionConstraintFor(at("/rpc/organizations/verifyMultiOrgMcpGrant/x")),
		).toBe("first-primary");
		expect(d1SessionConstraintFor(at("/v1/apps"))).toBe("first-primary");
	});
});
