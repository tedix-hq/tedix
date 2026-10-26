import { QueryClient } from "@tanstack/react-query";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { describe, expect, it } from "vite-plus/test";
import { buildActivityFeedTools } from "./activity-feed-webmcp-tools";
import { buildApiKeysWebMcpTools } from "./api-keys-webmcp-tools";
import { buildAppEditTools } from "./app-edit-webmcp-tools";
import { buildAttentionWebMcpTools } from "./attention-webmcp-tools";
import { buildCardReviewWebMcpTools } from "./card-review-webmcp-tools";
import { buildChatWebMcpTools } from "./chat-webmcp-tools";
import { buildConnectionsWebMcpTools } from "./connections-webmcp-tools";
import { buildDecisionDeckWebMcpTools } from "./decision-deck-webmcp-tools";
import { buildOutputsWebMcpTools } from "./outputs-webmcp-tools";
import { buildRunWebMcpTools } from "./run-webmcp-tools";
import { buildSkillsWebMcpTools } from "./skills-webmcp-tools";
import { buildWorkItemWebMcpTools } from "./work-item-webmcp-tools";
import { buildWorkWebMcpTools } from "./work-webmcp-tools";
import { buildWorkspaceWebMcpTools } from "./workspace-webmcp-tools";

const unexpectedExecution = (): never => {
	throw new Error("Convention checks must not execute tools");
};
const queryClient = new QueryClient();
const groups: Record<string, WebMcpToolDef[]> = {
	"activity-feed": buildActivityFeedTools(unexpectedExecution),
	"api-keys": buildApiKeysWebMcpTools({
		context: unexpectedExecution,
		prepareCreate: unexpectedExecution,
		prepareAction: unexpectedExecution,
	}),
	"app-edit": buildAppEditTools(
		"example-workspace",
		"example-conversation",
		unexpectedExecution,
	),
	attention: buildAttentionWebMcpTools(unexpectedExecution),
	"card-review": buildCardReviewWebMcpTools(unexpectedExecution, ["mail"]),
	chat: buildChatWebMcpTools(),
	connections: buildConnectionsWebMcpTools({ scope: "organization" }),
	"decision-deck": buildDecisionDeckWebMcpTools(unexpectedExecution),
	outputs: buildOutputsWebMcpTools(),
	run: buildRunWebMcpTools("example-run"),
	skills: buildSkillsWebMcpTools(),
	"work-item": buildWorkItemWebMcpTools("example-work", { queryClient }),
	work: buildWorkWebMcpTools({ queryClient }),
	workspace: buildWorkspaceWebMcpTools("example-workspace", () => null),
};

function parameterFailures(schema: unknown, path = "input"): string[] {
	if (!schema || typeof schema !== "object") return [];
	const node = schema as Record<string, unknown>;
	const failures: string[] = [];
	for (const [key, value] of Object.entries(node.properties ?? {})) {
		const property = value as Record<string, unknown>;
		if (
			typeof property.description !== "string" ||
			!property.description.trim()
		)
			failures.push(`${path}.${key}: missing description`);
		else if (property.description.length > 150)
			failures.push(`${path}.${key}: description exceeds 150 characters`);
		if (key.length > 30)
			failures.push(`${path}.${key}: name exceeds 30 characters`);
		failures.push(...parameterFailures(property, `${path}.${key}`));
	}
	for (const [key, value] of Object.entries(node)) {
		if (key === "properties") continue;
		if (Array.isArray(value)) {
			value.forEach((entry, index) =>
				failures.push(...parameterFailures(entry, `${path}.${key}[${index}]`)),
			);
		} else if (value && typeof value === "object") {
			failures.push(...parameterFailures(value, `${path}.${key}`));
		}
	}
	return failures;
}

function conventionFailures(tool: WebMcpToolDef, appId?: string): string[] {
	const failures: string[] = [];
	const appScoped = Boolean(appId && tool.name.startsWith(`${appId}_`));
	const scopedName =
		appScoped && appId ? tool.name.slice(appId.length + 1) : tool.name;
	if (
		!/^(?:read|react|list|get|create|comment|send|delegate|respond|run|explain|preview|check|prepare|update|revise|patch|set|propose)_[a-z0-9]+(?:_[a-z0-9]+)*$/.test(
			scopedName,
		) &&
		!(
			appScoped &&
			/^(?:next|do|snooze|skip|undo|filter|pending|decide)(?:_[a-z0-9]+)*$/.test(
				scopedName,
			)
		)
	)
		failures.push("name: expected verb-first snake_case");
	if (tool.name.length > 30) failures.push("name: exceeds 30 characters");
	if (!tool.description.trim()) failures.push("description: empty");
	if (tool.description.length > 500)
		failures.push("description: exceeds 500 characters");
	if ((tool.description.match(/[.!?](?:\s|$)/g) ?? []).length > 2)
		failures.push("description: exceeds two sentences");
	if (typeof tool.annotations.readOnlyHint !== "boolean")
		failures.push("annotations: missing explicit readOnlyHint");
	if (
		tool.annotations.readOnlyHint === true &&
		tool.annotations.untrustedContentHint !== true
	)
		failures.push(
			"annotations: authored read content missing untrustedContentHint",
		);
	const writes =
		/^(?:react|prepare|update|respond|send|delegate|revise|patch|set|run|comment|create|propose)_/.test(
			scopedName,
		) ||
		(appScoped &&
			/^(?:do|snooze|skip|undo|filter|decide)(?:_|$)/.test(scopedName));
	if (writes && tool.annotations.readOnlyHint === true)
		failures.push("annotations: write marked read-only");
	if (
		(writes || tool.annotations.readOnlyHint !== true) &&
		tool.annotations.consequentialHint !== true
	)
		failures.push("annotations: write missing consequentialHint");
	return [...failures, ...parameterFailures(tool.inputSchema)];
}

const deckFindings: Record<string, string[]> = {};

describe("WebMCP tool conventions", () => {
	it("covers every component tool module", () => {
		expect(Object.keys(import.meta.glob("./*-webmcp-tools.ts")).sort()).toEqual(
			Object.keys(groups)
				.map((group) => `./${group}-webmcp-tools.ts`)
				.sort(),
		);
	});
	it("keeps names unique across scopes", () => {
		const names = Object.values(groups)
			.flat()
			.map((tool) => tool.name);
		expect(new Set(names).size).toBe(names.length);
	});
	it("checks bound skills and personal connections too", () => {
		const variants = [
			...buildSkillsWebMcpTools("00000000-0000-4000-8000-000000000001"),
			...buildConnectionsWebMcpTools({ scope: "personal" }),
		];
		for (const tool of variants)
			expect(conventionFailures(tool), tool.name).toEqual([]);
	});
	for (const [group, tools] of Object.entries(groups)) {
		for (const tool of tools) {
			it(`${group}: ${tool.name}`, () => {
				expect(
					conventionFailures(
						tool,
						group === "card-review" ? "card_review" : undefined,
					),
				).toEqual(deckFindings[tool.name] ?? []);
			});
		}
	}
});
