import assert from "node:assert/strict";
import {
	TEDIX_CONSOLE_SIGN_IN_HOSTNAMES,
	ToolPolicySchema,
} from "@tedix/api-contract/schemas/tedi";
import {
	browserEgressDecision,
	persistentBrowserEgress,
} from "./browser-egress-policy";
import { browserSessionSignature } from "./browser-session";

const policy = ToolPolicySchema.parse({
	browserEgress: { presets: ["tedix-console-sign-in"] },
}).browserEgress!;
for (const hostname of TEDIX_CONSOLE_SIGN_IN_HOSTNAMES) {
	assert.equal(
		browserEgressDecision(`https://${hostname.replace("*", "example")}/login`, [
			policy,
		]).decision,
		"allow",
	);
}
assert.equal(
	browserEgressDecision("https://os.tedix.dev.attacker.example/", [policy])
		.decision,
	"deny",
);
assert.equal(
	browserEgressDecision("https://auth.tedix.dev/", [
		{ ...policy, deniedHostnames: ["auth.tedix.dev"] },
	]).decision,
	"deny",
);
assert.equal(
	browserEgressDecision("https://auth.tedix.dev/", [
		policy,
		{ allowedHostnames: ["example.com"], deniedHostnames: [] },
	]).decision,
	"deny",
);
assert.deepEqual(persistentBrowserEgress([policy]), {
	enforceable: true,
	allowedDomains: [...TEDIX_CONSOLE_SIGN_IN_HOSTNAMES].sort(),
});
const session = {
	mode: "persistent" as const,
	name: "console",
	keepAliveMs: 300_000,
};
assert.notEqual(
	browserSessionSignature(session, [policy]),
	browserSessionSignature(session, [{ ...policy, presets: [] }]),
);
console.log("browser console sign-in egress passed");
