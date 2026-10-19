import assert from "node:assert/strict";
import { nativeToolAutonomy } from "./native-tool-autonomy";

let autonomy: unknown = { version: 1, maxRisk: "medium" };
let observedRequest: Request | undefined;
const api = {
	async fetch(request: Request) {
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
assert.equal(observedRequest?.headers.get("X-Tedix-Org-Id"), "org-example");
assert.equal(
	(await nativeToolAutonomy({ ...base, tool: "browser_execute" })).autoApprove,
	false,
);
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
console.log("native-tool-autonomy tests passed");
