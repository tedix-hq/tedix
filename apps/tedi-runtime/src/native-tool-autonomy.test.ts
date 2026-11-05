import assert from "node:assert/strict";
import { nativeToolAutonomy } from "./native-tool-autonomy";

let autonomy: unknown = { version: 1, maxRisk: "medium" };
let observedRequest: Request | undefined;
let trustedDecision: unknown = {
	trusted: false,
	reason: "untrusted recipient: stranger@example.com",
	addresses: ["stranger@example.com"],
};
const trustChecks: unknown[] = [];
const api = {
	async fetch(request: Request) {
		if (request.url.includes("resolveTrustedRecipientSend")) {
			trustChecks.push(((await request.json()) as { json: unknown }).json);
			return Response.json({ json: trustedDecision });
		}
		observedRequest = request;
		return Response.json({ json: { autonomy } });
	},
} as unknown as Fetcher;
const base = {
	api,
	organizationId: "org-example",
	tediId: "tedi-example",
	tool: "write",
	args: {
		path: "/workspace/research.md",
		content: "The paper compares three algorithms.",
	},
};

assert.equal((await nativeToolAutonomy(base)).autoApprove, true);
const credentialRead = await nativeToolAutonomy({
	...base,
	tool: "read",
	args: { path: "/workspace/.env" },
});
assert.equal(credentialRead.autoApprove, false);
assert.equal(credentialRead.critical, true);
assert.equal(observedRequest?.headers.get("X-Tedix-Org-Id"), "org-example");
assert.equal(
	(await nativeToolAutonomy({ ...base, tool: "browser_execute" })).autoApprove,
	false,
);
for (const command of [
	"send_email",
	"publish_post",
	"rm /workspace/records.json",
]) {
	const decision = await nativeToolAutonomy({
		...base,
		tool: "exec",
		args: { command },
	});
	assert.equal(decision.autoApprove, false);
	assert.equal(decision.critical, true);
}
assert.equal(
	(
		await nativeToolAutonomy({
			...base,
			tool: "exec",
			args: { command: "rm -rf /workspace/data" },
		})
	).critical,
	true,
);
assert.equal(
	(
		await nativeToolAutonomy({
			...base,
			args: { path: "/workspace/note.md", content: "Never delete user data" },
		})
	).autoApprove,
	true,
);
autonomy = undefined;
assert.equal((await nativeToolAutonomy(base)).autoApprove, false);
autonomy = { version: 1, maxRisk: "medium", askForClasses: ["native:write"] };
assert.equal((await nativeToolAutonomy(base)).autoApprove, false);

// reply_to_email is an external message: a card unless the stored list
// trusts the inbound sender the runtime recorded for this turn.
autonomy = { version: 1, maxRisk: "medium" };
const reply = {
	...base,
	tool: "reply_to_email",
	args: { text: "Thanks, we will follow up." },
};
const untrustedReply = await nativeToolAutonomy({
	...reply,
	emailRecipients: { to: ["stranger@example.com"] },
});
assert.equal(untrustedReply.autoApprove, false);
assert.equal(untrustedReply.critical, true);
assert.deepEqual(trustChecks.at(-1), {
	tediId: "tedi-example",
	actingTediId: "tedi-example",
	kind: "reply",
	to: ["stranger@example.com"],
});
const noRecipient = await nativeToolAutonomy(reply);
assert.equal(noRecipient.critical, true);
assert.equal(trustChecks.length, 1);
trustedDecision = {
	trusted: true,
	reason: "trusted recipient",
	addresses: ["partner@example.com"],
};
const trustedReply = await nativeToolAutonomy({
	...reply,
	emailRecipients: { to: ["partner@example.com"] },
});
assert.equal(trustedReply.autoApprove, true);
assert.equal(trustedReply.critical, false);
assert.equal(trustedReply.reason, "trusted recipient");
autonomy = { version: 1, maxRisk: "medium", askForClasses: ["*"] };
const askAll = await nativeToolAutonomy({
	...reply,
	emailRecipients: { to: ["partner@example.com"] },
});
assert.equal(askAll.autoApprove, false);
assert.equal(askAll.critical, true);
console.log("native-tool-autonomy tests passed");
