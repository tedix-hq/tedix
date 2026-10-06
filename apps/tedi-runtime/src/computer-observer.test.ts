import assert from "node:assert/strict";
import type {
	WorkspaceAttributes,
	WorkspaceObserver,
} from "@cloudflare/computer";
import { createPrivacySafeComputerObserver } from "./computer-observer";

const spans: Array<{
	name: string;
	attributes: Record<string, boolean | number | string>;
}> = [];

const recorder: WorkspaceObserver = {
	async span(name, attributes, run) {
		const recorded = {
			name,
			attributes: Object.fromEntries(
				Object.entries(attributes).filter((entry) => entry[1] !== undefined),
			) as Record<string, boolean | number | string>,
		};
		spans.push(recorded);
		return run({
			setAttribute(key, value) {
				if (value !== undefined) recorded.attributes[key] = value;
			},
		});
	},
};

const observer = createPrivacySafeComputerObserver(recorder);
await observer.span(
	"workspace.fs.grep",
	{
		"workspace.fs.path": "/workspace/customer-secret",
		"workspace.fs.pattern": "api_key=secret",
		"workspace.fs.matches": 3,
		"workspace.sync.backend": "isolate-shell",
	} satisfies WorkspaceAttributes,
	async (span) => {
		span.setAttribute("error.message", "Bearer secret-token");
		span.setAttribute("error.name", "WorkspaceError");
		span.setAttribute("workspace.fs.entries", 7);
		return "ok";
	},
);

assert.deepEqual(spans, [
	{
		name: "workspace.fs.grep",
		attributes: {
			"workspace.fs.matches": 3,
			"workspace.sync.backend": "isolate-shell",
			"error.name": "WorkspaceError",
			"workspace.fs.entries": 7,
		},
	},
]);

await observer.span("tenant supplied / bad", {}, async () => "ok");
assert.equal(spans[1]?.name, "workspace.operation");

console.log("privacy-safe Computer observer tests passed");
