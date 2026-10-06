import assert from "node:assert/strict";
import { canManageDurableCode } from "./durable-codemode-auth";

// --- no caller / no admin scope → never an operator --------------------------
assert.equal(canManageDurableCode(undefined), false);
assert.equal(canManageDurableCode({ scopes: [] }), false);
assert.equal(canManageDurableCode({ scopes: ["tedi:cognitive.write"] }), false);

// --- a caller carrying a tedi identity is an agent, never an operator --------
assert.equal(
	canManageDurableCode({
		scopes: ["tedi:admin"],
		tediId: "tedi-1",
		email: "owner@example.com",
	}),
	false,
);
assert.equal(
	canManageDurableCode({ scopes: ["platform:admin"], tediId: "tedi-1" }),
	false,
);

// --- humans: admitted on POSITIVE proof (an email claim) ---------------------
assert.equal(
	canManageDurableCode({
		scopes: ["tedi:admin"],
		authMethod: "jwt",
		email: "owner@example.com",
	}),
	true,
);
assert.equal(
	canManageDurableCode({
		scopes: ["platform:admin"],
		authMethod: "jwt",
		email: "owner@example.com",
	}),
	true,
);

// --- an org-scoped `sk_` API key is a trusted operator credential ------------
// It is issued to the org by a human and carries NO token claims (so no email);
// it must therefore be admitted on authMethod, not on email.
assert.equal(
	canManageDurableCode({ scopes: ["tedi:admin"], authMethod: "api-key" }),
	true,
);

// --- The hole this closes ---------------------------------------------------
// A tedi ASSIGNED a peer tedi's MCP server authenticates to that peer with a
// Descope AIH client_credentials token. That token defaults to the `tedi:admin`
// connection scope, carries NO tediId claim (apps/mcp derives a tedi id from the
// Descope client's TAGS, never from a token claim), and has no human email.
// The old predicate was `(tedi:admin | platform:admin) && !tediId` → TRUE, so a PEER
// TEDI was treated as an OPERATOR and could approve / reject / roll back another
// tedi's durable code. Positive human proof closes it.
assert.equal(
	canManageDurableCode({ scopes: ["tedi:admin"], authMethod: "jwt" }),
	false,
	"peer-tedi AIH client_credentials token (tedi:admin, no tediId, no email) must NOT be an operator",
);
assert.equal(
	canManageDurableCode({
		scopes: ["tedi:admin", "platform:admin"],
		authMethod: "jwt",
	}),
	false,
	"even holding platform:admin, a machine token with no human email is not an operator",
);

// --- a gateway token is an internal machine credential, never a human --------
// (Unreachable on this surface today — the tedi runtime's auth middleware does
// not configure a gatewayToken — but fail closed for any future surface.)
assert.equal(
	canManageDurableCode({ scopes: ["tedi:admin"], authMethod: "gateway-token" }),
	false,
);

console.log("PASS: canManageDurableCode");
