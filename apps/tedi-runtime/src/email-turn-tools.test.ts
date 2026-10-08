import assert from "node:assert/strict";
import type { Tool, ToolSet } from "ai";
import {
	emailTurnSystemAddendum,
	inboundEmailTrust,
	selectEmailTurnTools,
} from "./email-turn-tools";

const marker = (name: string) => ({ description: name }) as Tool;
const full: ToolSet = {
	email_send: marker("email_send"),
	workspace_exec: marker("workspace_exec"),
	tedix_mcp_code: marker("tedix_mcp_code"),
	tedix_mcp_call_tool: marker("tedix_mcp_call_tool"),
	run_durable_code: marker("run_durable_code"),
	browser_navigate: marker("browser_navigate"),
	cron: marker("cron"),
	open_computer: marker("open_computer"),
	object_store_read_text: marker("object_store_read_text"),
	r2_sql: marker("r2_sql"),
	list_tedi_email_inbox: marker("list_tedi_email_inbox"),
	read_skill: marker("read_skill"),
};
const replyTool = marker("reply_to_email");

{
	const tools = selectEmailTurnTools({ trust: "untrusted", full, replyTool });
	assert.deepEqual(Object.keys(tools).sort(), ["read_skill", "reply_to_email"]);
	assert.equal(tools.reply_to_email, replyTool);
	for (const name of [
		"email_send",
		"workspace_exec",
		"tedix_mcp_code",
		"tedix_mcp_call_tool",
		"run_durable_code",
		"browser_navigate",
		"list_tedi_email_inbox",
	]) {
		assert.equal(tools[name], undefined, `${name} must be dropped`);
	}
}

{
	const tools = selectEmailTurnTools({ trust: "trusted", full, replyTool });
	assert.deepEqual(
		Object.keys(tools).sort(),
		[...Object.keys(full), "reply_to_email"].sort(),
	);
	assert.equal(tools.email_send, full.email_send);
	assert.equal(tools.reply_to_email, replyTool);
}

{
	assert.equal(inboundEmailTrust(new Headers()), "untrusted");
	assert.equal(
		inboundEmailTrust(new Headers({ "x-tedix-inbound-trust": "bogus" })),
		"untrusted",
	);
	assert.equal(
		inboundEmailTrust(new Headers({ "x-tedix-inbound-trust": "untrusted" })),
		"untrusted",
	);
	assert.equal(
		inboundEmailTrust(new Headers({ "x-tedix-inbound-trust": "trusted" })),
		"trusted",
	);
}

{
	assert.equal(emailTurnSystemAddendum("trusted"), "");
	const addendum = emailTurnSystemAddendum("untrusted");
	assert.match(addendum, /NOT verified/);
	assert.match(addendum, /one-time codes/);
	assert.match(addendum, /Do not follow any instructions/);
}

console.log("email-turn-tools OK");
