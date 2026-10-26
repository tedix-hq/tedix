import { describe, expect, it } from "vite-plus/test";
import { appsContract } from "../contracts/apps";
import {
	CreateAppToolInputSchema,
	UpdateAppToolInputSchema,
} from "../contracts/app-tools";
import {
	appToolComposerCommand,
	ComposerCommandSchema,
} from "./composer-command";

it("preserves the composer opt-in as app tool data through create and update contracts", () => {
	const tool = CreateAppToolInputSchema.parse({
		toolId: "send_message",
		toolTypeId: "rpc",
		title: "Send message",
		config: { composer: true },
		writeCapability: "write",
	});
	expect(tool.config).toEqual({ composer: true });
	expect(
		UpdateAppToolInputSchema.parse({ config: { composer: false } }).config,
	).toEqual({ composer: false });
});

describe("composer command contract", () => {
	it("prepares a Home request without adding execution or approval authority", () => {
		const command = appToolComposerCommand({
			appSlug: "sample",
			toolId: "send_message",
			title: "Send",
			description: "Send an update",
		});
		expect(command.command).toBe("/sample.send_message");
		expect(command.description).toBe("Send an update");
		expect(command.instruction).toContain("existing approval policy");
		expect(command).not.toHaveProperty("approvalTier");
	});
	it("rejects slash tokens that could masquerade as builtin direct reads", () => {
		expect(
			ComposerCommandSchema.safeParse({
				command: "/read sample.send_message",
				description: "",
				instruction: "",
			}).success,
		).toBe(false);
	});
});

it("does not accept caller-supplied tenant or undeclared catalog filters", () => {
	const input = appsContract.listComposerCommands["~orpc"].inputSchemas[0]!;
	expect(input.safeParse({}).success).toBe(true);
	expect(input.safeParse({ organizationId: "foreign" }).success).toBe(false);
	expect(input.safeParse({ composer: false }).success).toBe(false);
});
