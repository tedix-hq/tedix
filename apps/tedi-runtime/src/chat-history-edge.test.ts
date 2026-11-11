/**
 * The tedi DO replays conversation history on `/get-messages` and on every
 * WebSocket connect, and trusts the caller identity this Worker stamps. This
 * proves only an authenticated caller gets that identity: forged copies of the
 * stamped headers never reach the DO, on public or service-binding hops.
 */
import assert from "node:assert/strict";
import { issueGatewayBrowserToken } from "@tedix/auth/gateway-browser-token";
import { EDGE_TEDI, edgeFetch, tediRequest } from "../test/tedi-edge";

const SECRET = "chat-history-edge-secret";
const env = { SECRETS_MASTER_KEY: SECRET };

const FORGED_IDENTITY = {
	"X-Tedi-Auth-Subject": "forged-user",
	"X-Tedi-Auth-TediId": EDGE_TEDI.id,
	"X-Tedi-Auth-OrgId": EDGE_TEDI.organizationId,
	"X-Tedix-Can-Approve-Tools": "true",
	// Bun keeps the original headers when a rebuilt Request gets an empty set,
	// so carry one ordinary header, as every real request does.
	Accept: "application/json",
};
const STAMPED = Object.keys(FORGED_IDENTITY).filter(
	(name) => name !== "Accept",
);

const HISTORY_PATHS = [
	"/get-messages",
	"/get-messages?sessionKey=default",
	"/acp/get-messages",
	"/agents/tedi-agent/acme/get-messages",
];

// --- forged identity and no token: history is refused before the DO ---
for (const path of HISTORY_PATHS) {
	for (const serviceBinding of [false, true]) {
		const run = await edgeFetch(
			tediRequest(path, { headers: FORGED_IDENTITY, serviceBinding }),
			{ env },
		);
		const label = `${path} serviceBinding=${serviceBinding}`;
		assert.equal(run.response.status, 401, label);
		assert.equal(run.forwarded.length, 0, label);
	}
}

// --- a WebSocket upgrade on any path needs a token, not only `/acp` ---
for (const path of ["/acp", "/agents/tedi-agent/acme", "/internal-notes"]) {
	const run = await edgeFetch(
		tediRequest(path, {
			headers: { ...FORGED_IDENTITY, Upgrade: "websocket" },
		}),
		{ env },
	);
	assert.equal(run.response.status, 401, path);
	assert.equal(run.forwarded.length, 0, path);
}

// --- forged identity never rides an ordinary request to the DO ---
for (const serviceBinding of [false, true]) {
	const run = await edgeFetch(
		tediRequest("/internal-notes", {
			headers: FORGED_IDENTITY,
			serviceBinding,
		}),
		{ env },
	);
	assert.equal(run.response.status, 200);
	for (const name of STAMPED) {
		assert.equal(run.forwarded[0]!.headers.get(name), null, name);
	}
}

// --- a real token reads history under its own identity, not the forged one ---
{
	const token = await issueGatewayBrowserToken({
		secret: SECRET,
		tediId: EDGE_TEDI.id,
		subject: "browser-user",
		expiresAt: Math.floor(Date.now() / 1000) + 600,
	});
	const run = await edgeFetch(
		tediRequest("/get-messages?sessionKey=default", {
			headers: { ...FORGED_IDENTITY, Authorization: `Bearer ${token}` },
		}),
		{ env },
	);
	assert.equal(run.response.status, 200);
	const forwarded = run.forwarded[0]!.headers;
	assert.equal(forwarded.get("X-Tedi-Auth-Subject"), "browser-user");
	assert.equal(forwarded.get("X-Tedi-Auth-TediId"), EDGE_TEDI.id);
	assert.equal(forwarded.get("X-Tedix-Can-Approve-Tools"), "false");
}

console.log("chat-history-edge: ok");
