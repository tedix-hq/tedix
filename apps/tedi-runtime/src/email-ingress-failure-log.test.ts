import assert from "node:assert/strict";
import { logInboundEmailPersistenceFailure } from "./email-ingress-failure-log";

const originalError = console.error;
const failures: unknown[][] = [];
console.error = (...args: unknown[]) => {
	failures.push(args);
};

try {
	const error = new Error(
		"recipient@tedix.tech sender@example.com subject body magic-link-secret",
		{ cause: new TypeError("inner login-token-secret") },
	);
	error.name = "CustomMagicLinkSecret";
	logInboundEmailPersistenceFailure(error);

	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.length, 1);
	assert.deepEqual(failures[0]?.[0], {
		component: "tedi-runtime-email",
		event: "tedi.email.inbound_persist_failed",
		exception: {
			type: "UnknownThrown",
			cause: { type: "TypeError" },
		},
	});
	const emitted = JSON.stringify(failures);
	for (const secret of [
		"recipient@tedix.tech",
		"sender@example.com",
		"subject body",
		"magic-link-secret",
		"login-token-secret",
		"CustomMagicLinkSecret",
	]) {
		assert.ok(!emitted.includes(secret), `log contained ${secret}`);
	}
} finally {
	console.error = originalError;
}
