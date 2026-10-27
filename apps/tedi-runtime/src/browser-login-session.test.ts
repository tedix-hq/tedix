import { strict as assert } from "node:assert";
import {
	BROWSER_LOGIN_SESSION_KEY,
	BROWSER_LOGIN_TTL_MS,
	browserLoginFromApproval,
	browserLoginRuntimeEvent,
	browserLoginSessions,
	checkBrowserLogin,
	type BrowserLoginEvent,
} from "./browser-login-session";

const approvedAt = Date.parse("2026-10-27T09:00:00.000Z");
const row = {
	payload: JSON.stringify({
		kind: "browser_live_view_takeover",
		reason: "login",
		targets: [{ pageUrl: "https://accounts.example.com" }],
	}),
	resolvedAt: "2026-10-27T09:00:00.000Z",
	resolvedBy: "user-approver",
};
const login = browserLoginFromApproval({
	approvalRequestId: "approval-1",
	sessionId: "browser-1",
	tediId: "tedi-1",
	orgId: "org-1",
	row,
	pageUrls: ["https://app.example.com/home?code=secret", "about:blank"],
	now: approvedAt,
});

// The approval records who signed in, for which tedi, org and site.
assert.deepEqual(login, {
	approvalRequestId: "approval-1",
	sessionId: "browser-1",
	tediId: "tedi-1",
	orgId: "org-1",
	principal: "user-approver",
	reason: "login",
	siteHosts: ["app.example.com"],
	approvedAt: "2026-10-27T09:00:00.000Z",
	expiresAt: new Date(approvedAt + BROWSER_LOGIN_TTL_MS).toISOString(),
});
// Without a readable current page the requested page's host is kept.
assert.deepEqual(
	browserLoginFromApproval({
		approvalRequestId: "approval-1",
		sessionId: "browser-1",
		tediId: "tedi-1",
		orgId: "org-1",
		row,
		pageUrls: [],
		now: approvedAt,
	}).siteHosts,
	["accounts.example.com"],
);

// A login is never reused by another tedi or another organization.
const owner = { tediId: "tedi-1", orgId: "org-1", sessionId: "browser-1" };
const later = approvedAt + 60_000;
assert.deepEqual(checkBrowserLogin(login, { ...owner, now: later }), {
	action: "reuse",
});
for (const other of [
	{ ...owner, tediId: "tedi-2" },
	{ ...owner, orgId: "org-2" },
	{ ...owner, tediId: undefined },
]) {
	assert.deepEqual(checkBrowserLogin(login, { ...other, now: later }), {
		action: "end",
		reason: "owner_mismatch",
	});
}
assert.deepEqual(
	checkBrowserLogin(login, { ...owner, sessionId: "browser-2", now: later }),
	{ action: "end", reason: "session_lost" },
);
assert.deepEqual(
	checkBrowserLogin(login, {
		...owner,
		now: approvedAt + BROWSER_LOGIN_TTL_MS,
	}),
	{ action: "end", reason: "expired" },
);

// The ledger row names the login but never the Browser Run id.
{
	const event = browserLoginRuntimeEvent(
		{ kind: "ended", login, reason: "operator_end" },
		{ tediId: "tedi-1", runId: "run-1", conversationId: "conv-1" },
	);
	assert.equal(event.kind, "browser.login.ended");
	assert.equal(event.payload?.endReason, "operator_end");
	assert.equal(event.payload?.principal, "user-approver");
	assert.ok(!JSON.stringify(event).includes("browser-1"));
}

function harness(start = approvedAt) {
	const data = new Map<string, unknown>();
	const events: BrowserLoginEvent[] = [];
	const closed: string[] = [];
	const state = {
		now: start,
		sessionId: "browser-1" as string | undefined,
		owner: { tediId: "tedi-1", orgId: "org-1" } as {
			tediId: string | undefined;
			orgId: string | undefined;
		},
	};
	const sessions = browserLoginSessions({
		storage: {
			get: async <T>(key: string) => data.get(key) as T | undefined,
			put: async (key, value) => void data.set(key, value),
			delete: async (key) => data.delete(key),
		},
		owner: () => state.owner,
		currentSessionId: async () => state.sessionId,
		closeBrowser: async (reason) => {
			closed.push(reason);
			state.sessionId = undefined;
		},
		emit: async (event) => void events.push(event),
		now: () => state.now,
	});
	return { data, events, closed, state, sessions };
}
const kinds = (events: BrowserLoginEvent[]) =>
	events.map((e) => (e.kind === "ended" ? `ended:${e.reason}` : e.kind));

// Turns after the approval reuse the login without a new takeover, and the
// tedi and operators can see it.
{
	const h = harness();
	await h.sessions.record(login);
	for (let turn = 1; turn <= 3; turn++) {
		h.state.now = approvedAt + turn * 30 * 60_000;
		await h.sessions.ensure();
	}
	const view = await h.sessions.status();
	assert.equal(view?.principal, "user-approver");
	assert.deepEqual(view?.siteHosts, ["app.example.com"]);
	assert.ok(!JSON.stringify(view).includes("browser-1"));
	assert.deepEqual(h.closed, []);
	assert.deepEqual(kinds(h.events), ["recorded"]);
}

// An operator ends the session: the Browser Run session is closed, the login
// forgotten, and the next call has nothing to reuse.
{
	const h = harness();
	await h.sessions.record(login);
	const result = await h.sessions.end();
	assert.equal(result.ended?.approvalRequestId, "approval-1");
	assert.deepEqual(h.closed, ["operator_end"]);
	assert.equal(h.data.has(BROWSER_LOGIN_SESSION_KEY), false);
	assert.deepEqual(kinds(h.events), ["recorded", "ended:operator_end"]);
	await h.sessions.ensure();
	assert.equal(await h.sessions.status(), null);
	// Ending with no login still closes any open browser.
	assert.deepEqual((await h.sessions.end()).ended, null);
	assert.deepEqual(h.closed, ["operator_end", "operator_end"]);
}

// Expiry closes the browser, records an event and tells the tedi to ask for
// a new takeover, once.
{
	const h = harness();
	await h.sessions.record(login);
	h.state.now = approvedAt + BROWSER_LOGIN_TTL_MS + 1;
	await assert.rejects(
		h.sessions.ensure(),
		/app\.example\.com ended \(expired\).*request_browser_takeover/,
	);
	assert.deepEqual(h.closed, ["login_ended"]);
	assert.deepEqual(kinds(h.events), ["recorded", "ended:expired"]);
	await h.sessions.ensure();
}

// A browser that went away (idle keep-alive) ends the login without closing
// the fresh browser, and says so.
{
	const h = harness();
	await h.sessions.record(login);
	h.state.sessionId = "browser-2";
	await assert.rejects(h.sessions.ensure(), /session_lost/);
	assert.deepEqual(h.closed, []);
	assert.deepEqual(kinds(h.events), ["recorded", "ended:session_lost"]);
}

// A login stored under another tedi or organization is discarded, never used.
{
	const h = harness();
	await h.sessions.record(login);
	h.state.owner = { tediId: "tedi-2", orgId: "org-1" };
	await assert.rejects(h.sessions.ensure(), /owner_mismatch/);
	assert.deepEqual(h.closed, ["login_ended"]);
	await h.sessions.record(login);
	h.state.sessionId = "browser-1";
	h.state.owner = { tediId: "tedi-1", orgId: "org-2" };
	assert.equal(await h.sessions.status(), null);
	assert.equal(h.data.has(BROWSER_LOGIN_SESSION_KEY), false);
}

// The tedi closing its own browser forgets the login.
{
	const h = harness();
	await h.sessions.record(login);
	assert.equal(
		(await h.sessions.forget("tedi_request"))?.approvalRequestId,
		"approval-1",
	);
	assert.equal(await h.sessions.forget("tedi_request"), null);
	assert.deepEqual(kinds(h.events), ["recorded", "ended:tedi_request"]);
}

console.log("browser-login-session tests passed");
