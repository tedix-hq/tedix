/**
 * The tedi DO serves its privileged `/__internal/*` routes by exact pathname
 * and trusts that only this Worker's own edge or a service-binding caller can
 * reach them. This proves the edge keeps that promise: an untrusted request
 * (no service-binding marker, forged identity headers, any spelling of the
 * path) never reaches a DO `/__internal/*` handler, while the trusted callers
 * that legitimately use those paths through the binding keep working.
 */
import assert from "node:assert/strict";
import { EDGE_TEDI, edgeFetch, tediRequest } from "../test/tedi-edge";

const INTERNAL_ROUTES = [
	"/__internal/inject",
	"/__internal/mesh/inject",
	"/__internal/chat/stream",
	"/__internal/chat/warm",
	"/__internal/cancel",
	"/__internal/page-tool/result",
	"/__internal/messages/read",
	"/__internal/review-capabilities",
	"/__internal/browser/takeover-status",
	"/__internal/cm-session/authorize",
	"/__internal/cm-session/revoke",
	"/__internal/repo-commit/drain",
	"/__internal/cm-executions/resume",
	"/__internal/fanout-slots",
	"/__internal/fanout-batch",
	"/__internal/voice/consult",
	"/__internal/config/refresh",
	"/__internal/cron/sync",
];

/** Spellings a caller may use for one internal path. */
function spellings(path: string): string[] {
	const rest = path.slice("/__internal".length);
	return [
		path,
		`/${path}`,
		`${path}/`,
		`/%5F%5Finternal${rest}`,
		`/_%5Finternal${rest}`,
		`/__internal/.${rest}`,
		`/__internal/x/..${rest}`,
		`/x/../__internal${rest}`,
		`/%2E%2E/__internal${rest}`,
		`/__INTERNAL${rest}`,
		`${path}?slug=${EDGE_TEDI.slug}`,
	];
}

/** Identity headers the DO and edge treat as authority when stamped internally. */
const FORGED_HEADERS = {
	"X-Tedi-Id": EDGE_TEDI.id,
	"X-Tedi-Org-Id": EDGE_TEDI.organizationId,
	"X-Tedi-Slug": EDGE_TEDI.slug,
	"X-Tedi-Auth-Subject": "forged-user",
	"X-Tedi-Auth-TediId": EDGE_TEDI.id,
	"X-Tedi-Auth-OrgId": EDGE_TEDI.organizationId,
	"X-Tedix-Admin-Token": "forged",
	"X-Tedix-Can-Approve-Tools": "true",
	"X-Tedix-Can-Manage-Durable-Code": "true",
	"Content-Type": "application/json",
};

function normalizedPathname(url: string): string {
	let pathname = new URL(url).pathname;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// keep the raw spelling
	}
	return pathname.replace(/\/{2,}/g, "/").toLowerCase();
}

// --- untrusted callers: every spelling, both methods, forged headers ---
let externalCases = 0;
for (const route of INTERNAL_ROUTES) {
	for (const path of spellings(route)) {
		for (const method of ["GET", "POST"]) {
			const run = await edgeFetch(
				tediRequest(path, {
					method,
					headers: FORGED_HEADERS,
					body: method === "POST" ? JSON.stringify({ text: "hi" }) : null,
				}),
			);
			externalCases += 1;
			const label = `${method} ${path}`;
			const reached = run.forwarded.filter((forwarded) =>
				normalizedPathname(forwarded.url).startsWith("/__internal"),
			);
			assert.equal(
				reached.length,
				0,
				`${label} reached the DO as ${reached.map((r) => new URL(r.url).pathname).join(", ")}`,
			);
			assert.ok(
				run.response.status === 403 || run.response.status === 404,
				`${label} answered ${run.response.status}, expected 403 or 404`,
			);
		}
	}
}
assert.ok(externalCases >= INTERNAL_ROUTES.length * 2 * 10);

// --- a stray marker on a public hop is not trust by itself ---
// The edge trusts only the exact service-binding marker value; a forged
// `X-Service-Binding` with any other value is still an external caller.
{
	const run = await edgeFetch(
		tediRequest("/__internal/inject", {
			method: "POST",
			headers: { ...FORGED_HEADERS, "X-Service-Binding": "1" },
			body: JSON.stringify({ text: "hi" }),
		}),
	);
	assert.equal(run.forwarded.length, 0);
	assert.ok(run.response.status === 403 || run.response.status === 404);
}

// --- trusted service-binding callers keep their raw internal paths ---
// packages/provisioning (apps/api) and apps/mcp call these through the tedi
// binding with the service-binding marker and the literal `/__internal/*` path.
for (const route of [
	"/__internal/cm-session/authorize",
	"/__internal/cm-session/revoke",
	"/__internal/repo-commit/drain",
	"/__internal/browser/takeover-status",
	"/__internal/fanout-slots?parent_run_id=run-1&limit=2",
]) {
	const run = await edgeFetch(
		tediRequest(route, {
			method: "POST",
			serviceBinding: true,
			headers: { "Content-Type": "application/json" },
			body: "{}",
		}),
	);
	assert.equal(run.response.status, 200, route);
	assert.deepEqual(run.doNames, [EDGE_TEDI.isolateAgentId]);
	const [toDo] = run.forwarded;
	assert.ok(toDo, route);
	const expected = new URL(`https://x${route}`);
	const toDoUrl = new URL(toDo.url);
	assert.equal(toDoUrl.pathname, expected.pathname);
	assert.equal(toDoUrl.search, expected.search);
	assert.equal(toDo.headers.get("X-Service-Binding"), "true");
	assert.equal(toDo.headers.get("X-Tedi-Id"), EDGE_TEDI.id);
	assert.equal(toDo.headers.get("X-Tedi-Slug"), EDGE_TEDI.slug);
}

// --- the edge's own aliases still reach their internal targets ---
{
	const run = await edgeFetch(
		tediRequest("/api/cron/sync", { method: "POST", serviceBinding: true }),
	);
	assert.equal(run.response.status, 200);
	assert.equal(
		new URL(run.forwarded[0]?.url ?? "https://x/").pathname,
		"/__internal/cron/sync",
	);
}

// --- ordinary public traffic is untouched ---
{
	const run = await edgeFetch(tediRequest("/api/status"));
	assert.equal(run.response.status, 200);
	const chat = await edgeFetch(
		tediRequest("/internal-notes", { headers: FORGED_HEADERS }),
	);
	assert.equal(chat.response.status, 200);
	assert.equal(new URL(chat.forwarded[0]!.url).pathname, "/internal-notes");
}
