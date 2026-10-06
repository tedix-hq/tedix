import { describe, expect, it, vi } from "vite-plus/test";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	callToolResultText,
	requireDestructiveToolApproval,
	stripDestructiveApprovalArgs,
	withDestructiveApprovalSchema,
} from "./governance";
import { resolveWireAnnotations } from "./tool-registration";
import type { AppTool } from "./server-context";
import type { ServerContext } from "./server-context";

function approvalContext(
	elicitInput: (params: unknown) => Promise<unknown>,
): Pick<ServerContext, "server"> {
	return {
		server: {
			server: { elicitInput },
		},
	} as unknown as Pick<ServerContext, "server">;
}

const tool = { toolId: "delete_app", title: "Delete app" };

function approvalArgumentTool(
	properties: Record<string, JsonValue>,
): Pick<AppTool, "inputSchema"> {
	return {
		inputSchema: { type: "object", properties },
	};
}

describe("destructive approval schema presentation", () => {
	it("adds optional fields without changing the original upstream contract", () => {
		const tool = approvalArgumentTool({ id: { type: "string" } });
		tool.inputSchema.required = ["id"];
		const original = structuredClone(tool.inputSchema);
		const schema = withDestructiveApprovalSchema(tool, {
			destructiveHint: true,
		});
		expect(schema.properties).toMatchObject({
			confirmDestructive: { type: "boolean" },
			reason: { type: "string" },
		});
		expect(schema.required).toEqual(["id"]);
		expect(tool.inputSchema).toEqual(original);
		expect(
			stripDestructiveApprovalArgs(tool, {
				id: "one",
				confirmDestructive: true,
				reason: "Authorized",
			}),
		).toEqual({ id: "one" });
	});
	it("preserves declared fields and leaves read-only schemas unchanged", () => {
		const tool = approvalArgumentTool({
			reason: { type: "string", enum: ["business"] },
		});
		expect(
			withDestructiveApprovalSchema(tool, { destructiveHint: true }).properties
				?.reason,
		).toEqual(tool.inputSchema.properties?.reason);
		expect(withDestructiveApprovalSchema(tool, { readOnlyHint: true })).toBe(
			tool.inputSchema,
		);
		expect(withDestructiveApprovalSchema(tool, undefined)).toBe(
			tool.inputSchema,
		);
	});
});

describe("destructive approval argument stripping", () => {
	it.each([
		{ confirmDestructive: false, reason: "Approved through elicitation" },
		{ reason: "Approved through grant" },
	])("strips undeclared fields after other approval paths: %j", (approval) => {
		expect(
			stripDestructiveApprovalArgs(
				approvalArgumentTool({ id: { type: "string" } }),
				{ id: "one", ...approval },
			),
		).toEqual({ id: "one" });
	});
	it("removes undeclared Tedix approval fields without mutating caller input", () => {
		const args = {
			presentationId: "deck-1",
			requests: [],
			confirmDestructive: true,
			reason: "Operator authorized the validation probe",
		};

		expect(
			stripDestructiveApprovalArgs(approvalArgumentTool({}), args),
		).toEqual({
			presentationId: "deck-1",
			requests: [],
		});
		expect(args).toHaveProperty("confirmDestructive", true);
		expect(args).toHaveProperty(
			"reason",
			"Operator authorized the validation probe",
		);
	});

	it("preserves approval fields that belong to the declared tool contract", () => {
		const args = {
			confirmDestructive: true,
			reason: "Operator authorized the workflow",
		};
		const declaredTool = approvalArgumentTool({
			confirmDestructive: { type: "boolean" },
			reason: { type: "string" },
		});

		expect(stripDestructiveApprovalArgs(declaredTool, args)).toBe(args);
	});

	it("preserves a declared business reason while removing only confirmation", () => {
		const args = {
			confirmDestructive: true,
			reason: "Required by the provider",
		};

		expect(
			stripDestructiveApprovalArgs(
				approvalArgumentTool({ reason: { type: "string" } }),
				args,
			),
		).toEqual({ reason: "Required by the provider" });
	});
});

describe("destructive tool approval", () => {
	it("skips elicitation for non-destructive tools", async () => {
		const elicitInput = vi.fn();

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: false,
			},
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("allows destructive execution after explicit accept with a reason", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "requested by owner" },
		}));

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);

		expect(result).toBeNull();
		expect(elicitInput).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "form",
				requestedSchema: expect.objectContaining({
					required: ["reason"],
				}),
			}),
		);
	});

	it("fails closed when the user declines", async () => {
		const elicitInput = vi.fn(async () => ({ action: "decline" }));

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("declined");
		expect(callToolResultText(result!)).toContain("No side effect");
	});

	it("fails closed when the user accepts without a reason", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: " " },
		}));

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("reason is required");
		expect(callToolResultText(result!)).toContain("No side effect");
	});

	it("fails closed when elicitation is unavailable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"destructive approval is unavailable",
		);
		expect(callToolResultText(result!)).toContain("No side effect");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("denied before side effect"),
		);
		warn.mockRestore();
	});

	it("points a non-elicitation client at confirmDestructive instead of a dead end", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		// The agent-native/claude.ai shape: the host refuses the prompt and the
		// serving connection carries no modern protocol marker, so neither the
		// modern-restriction regex nor servingConnectionIsModern() matches. The
		// recovery instruction must still be emitted — confirmDestructive is
		// evaluated earlier and unconditionally, so it is a legal recovery here.
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support form elicitation.");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
		);

		expect(result?.isError).toBe(true);
		const text = callToolResultText(result!);
		expect(text).toContain("destructive approval is unavailable");
		expect(text).toContain("confirmDestructive:true");
		expect(text).toContain("non-empty reason");
		expect(text).toContain("No side effect");
		warn.mockRestore();
	});

	it("allows explicit dryRun previews without destructive approval", async () => {
		const elicitInput = vi.fn(async () => {
			throw new Error("should not prompt for dryRun");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{ args: { dryRun: true } },
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("allows an explicit stateless confirmation only with a reason", async () => {
		const elicitInput = vi.fn(async () => {
			throw new Error("should not prompt after explicit confirmation");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				args: {
					confirmDestructive: true,
					reason: "operator requested cleanup",
				},
			},
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("rejects explicit stateless confirmation without a reason", async () => {
		const result = await requireDestructiveToolApproval(
			approvalContext(vi.fn()),
			tool,
			{ destructiveHint: true },
			{ args: { confirmDestructive: true, reason: " " } },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("reason is required");
	});

	it("does not treat omitted or false dryRun as a preview", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{ args: { dryRun: false } },
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"destructive approval is unavailable",
		);
		warn.mockRestore();
	});
});

// Agent caller (tedi/service identity) → synchronous MRTR, never elicitInput.
function agentApprovalContext(
	elicitInput: (params: unknown) => Promise<unknown>,
	authType: "tedi" | "service" = "tedi",
	requireExplicitApprovalPolicy = false,
): Pick<ServerContext, "server"> {
	return {
		server: { server: { elicitInput } },
		callerIdentity: { authType, tediId: "tedi-1" },
		app: { organizationId: "org-1" },
		apiClient: {
			mcpGovernance: {
				resolveAgentTransportPolicy: vi.fn(async () => ({
					requireExplicitApprovalPolicy,
				})),
			},
		},
	} as unknown as Pick<ServerContext, "server">;
}

function requiredRequestState(result: unknown): string {
	if (!result || typeof result !== "object") {
		throw new Error("missing input-required result");
	}
	const meta = (result as { _meta?: unknown })._meta;
	if (!meta || typeof meta !== "object")
		throw new Error("missing result metadata");
	const marker = (meta as Record<string, unknown>)["tedix/inputRequired"];
	if (!marker || typeof marker !== "object") {
		throw new Error("missing input-required marker");
	}
	const requestState = (marker as Record<string, unknown>).requestState;
	if (typeof requestState !== "string") {
		throw new Error("missing request state");
	}
	return requestState;
}

describe("destructive tool approval — synchronous MRTR (agent)", () => {
	it("returns input_required (not elicitInput) on first touch for an agent", async () => {
		const elicitInput = vi.fn();

		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);

		expect(elicitInput).not.toHaveBeenCalled();
		const marker = result?._meta?.["tedix/inputRequired"] as
			| { requestState?: string; inputRequests?: Record<string, unknown> }
			| undefined;
		expect(typeof marker?.requestState).toBe("string");
		expect(marker?.inputRequests).toHaveProperty("approval");
	});

	it("returns input_required for a NON-agent caller on a modern (2026-07-28) connection", async () => {
		// The repro-class case: a non-agent (human/OAuth) caller on a modern
		// serving connection where elicitInput() is illegal. The gate must route
		// to input_required instead of dying with "approval unavailable".
		const elicitInput = vi.fn();
		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					},
				},
			},
		);
		expect(elicitInput).not.toHaveBeenCalled();
		const marker = result?._meta?.["tedix/inputRequired"] as
			| { requestState?: string; inputRequests?: Record<string, unknown> }
			| undefined;
		expect(typeof marker?.requestState).toBe("string");
		expect(marker?.inputRequests).toHaveProperty("approval");
	});

	it("keeps legacy elicitInput for a non-agent caller on a legacy connection", async () => {
		// No modern _meta → not a modern connection → legacy bidirectional host
		// path is preserved unchanged.
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "ok" },
		}));
		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{
				destructiveHint: true,
			},
		);
		expect(elicitInput).toHaveBeenCalledTimes(1);
		expect(result).toBeNull();
	});

	it("proceeds on retry with a valid requestState + reason", async () => {
		const elicitInput = vi.fn();
		const ctx = agentApprovalContext(elicitInput);

		const first = await requireDestructiveToolApproval(ctx, tool, {
			destructiveHint: true,
		});
		const requestState = requiredRequestState(first);

		const retry = await requireDestructiveToolApproval(
			ctx,
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"tedix/inputResponses": {
							requestState,
							content: { reason: "approved by kernel" },
						},
					},
				},
			},
		);

		expect(retry).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("proceeds on canonical retry params adapted through metadata", async () => {
		const elicitInput = vi.fn();
		const ctx = agentApprovalContext(elicitInput);

		const first = await requireDestructiveToolApproval(ctx, tool, {
			destructiveHint: true,
		});
		const requestState = requiredRequestState(first);

		const retry = await requireDestructiveToolApproval(
			ctx,
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"tedix/inputResponses": {
							requestState,
							inputResponses: {
								approval: { content: { reason: "canonical approval" } },
							},
						},
					},
				},
			},
		);

		expect(retry).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("fails closed on a forged/invalid requestState", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn()),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"tedix/inputResponses": {
							requestState: "not.valid",
							content: { reason: "sneaky" },
						},
					},
				},
			},
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("requestState is invalid");
		expect(callToolResultText(result!)).toContain("No side effect");
	});

	it("fails closed on retry without a reason", async () => {
		const ctx = agentApprovalContext(vi.fn());
		const first = await requireDestructiveToolApproval(ctx, tool, {
			destructiveHint: true,
		});
		const requestState = requiredRequestState(first);

		const retry = await requireDestructiveToolApproval(
			ctx,
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"tedix/inputResponses": { requestState, content: { reason: "  " } },
					},
				},
			},
		);

		expect(retry?.isError).toBe(true);
		expect(callToolResultText(retry!)).toContain("reason is required");
	});

	it("rejects a requestState minted for a different tool", async () => {
		const ctx = agentApprovalContext(vi.fn());
		const first = await requireDestructiveToolApproval(ctx, tool, {
			destructiveHint: true,
		});
		const requestState = requiredRequestState(first);

		// Same state, different tool → must not open the gate.
		const retry = await requireDestructiveToolApproval(
			ctx,
			{ toolId: "drop_database", title: "Drop database" },
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						"tedix/inputResponses": {
							requestState,
							content: { reason: "wrong tool" },
						},
					},
				},
			},
		);

		expect(retry?.isError).toBe(true);
		expect(callToolResultText(retry!)).toContain("requestState is invalid");
	});

	// MRTR spec: servers MUST NOT send an inputRequests entry the client has not
	// declared support for — no declared `elicitation` capability means no
	// `elicitation/create`-typed approval inputRequest.
	const CLIENT_CAPABILITIES_META_KEY =
		"io.modelcontextprotocol/clientCapabilities";
	const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

	it("returns input_required for a tasks-capable caller that declared elicitation", async () => {
		const elicitInput = vi.fn();

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						[CLIENT_CAPABILITIES_META_KEY]: {
							elicitation: { form: {} },
							extensions: { [TASKS_EXTENSION]: {} },
						},
					},
				},
			},
		);

		expect(elicitInput).not.toHaveBeenCalled();
		const marker = result?._meta?.["tedix/inputRequired"] as
			| { requestState?: string; inputRequests?: Record<string, unknown> }
			| undefined;
		expect(typeof marker?.requestState).toBe("string");
		expect(marker?.inputRequests).toHaveProperty("approval");
	});

	it("never sends the elicitation inputRequest to a tasks-capable caller without declared elicitation", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						[CLIENT_CAPABILITIES_META_KEY]: {
							extensions: { [TASKS_EXTENSION]: {} },
						},
					},
				},
			},
		);

		expect(result?._meta?.["tedix/inputRequired"]).toBeUndefined();
		expect(elicitInput).toHaveBeenCalled();
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"destructive approval is unavailable",
		);
		expect(callToolResultText(result!)).toContain("No side effect");
		warn.mockRestore();
	});

	it("blocks the elicitation inputRequest for a tedi caller that declared capabilities without elicitation", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});

		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						[CLIENT_CAPABILITIES_META_KEY]: {
							extensions: { [TASKS_EXTENSION]: {} },
						},
					},
				},
			},
		);

		expect(result?._meta?.["tedix/inputRequired"]).toBeUndefined();
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"destructive approval is unavailable",
		);
		warn.mockRestore();
	});

	it("keeps sync-MRTR for a tedi caller that declared elicitation", async () => {
		const elicitInput = vi.fn();

		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{
				extra: {
					_meta: {
						[CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
					},
				},
			},
		);

		expect(elicitInput).not.toHaveBeenCalled();
		const marker = result?._meta?.["tedix/inputRequired"] as
			| { requestState?: string }
			| undefined;
		expect(typeof marker?.requestState).toBe("string");
	});

	it("keeps the legacy elicitInput path when sync-MRTR is disabled (Code Mode)", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "code mode" },
		}));

		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{ allowSyncMrtr: false },
		);

		expect(result).toBeNull();
		expect(elicitInput).toHaveBeenCalled();
	});
});

// =============================================================================
// Grant fast path (Batch 4 — isolated MCP-gateway grant layer)
// =============================================================================

function grantApprovalContext(input: {
	elicitInput: (params: unknown) => Promise<unknown>;
	resolveToolApprovalGrant?: (args: unknown) => Promise<unknown>;
	resolveWorkItemAuthorization?: (args: unknown) => Promise<unknown>;
	// Defaults to "user" (non-agent) so a fall-through in these tests exercises
	// the legacy elicitInput() path directly rather than the agent sync-MRTR
	// input_required round-trip — the grant check itself runs identically
	// before either branch, so this only affects what "fell through" looks
	// like in assertions.
	authType?: "tedi" | "service" | "user" | "external_agent" | "oauth";
	organizationId?: string | null;
	appSlug?: string | null;
	connectionLabel?: string;
}): Pick<ServerContext, "server"> {
	return {
		server: { server: { elicitInput: input.elicitInput } },
		callerIdentity: {
			authType: input.authType ?? "user",
			userId: "user-1",
			tediId: "tedi-1",
		},
		app:
			input.organizationId === null
				? {}
				: { organizationId: input.organizationId ?? "org-1" },
		appSlug: input.appSlug === null ? undefined : (input.appSlug ?? "shop"),
		connectionLabel: input.connectionLabel,
		apiClient:
			input.resolveToolApprovalGrant || input.resolveWorkItemAuthorization
				? {
						mcpGovernance: {
							resolveToolApprovalGrant:
								input.resolveToolApprovalGrant ?? vi.fn(),
							resolveWorkItemAuthorization:
								input.resolveWorkItemAuthorization ?? vi.fn(),
						},
					}
				: undefined,
	} as unknown as Pick<ServerContext, "server">;
}

describe("destructive tool approval — grant fast path", () => {
	it("skips the grant lookup entirely when approvalPolicy is absent (today's behavior)", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "no grant policy configured" },
		}));
		const resolveToolApprovalGrant = vi.fn();

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: {} },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("skips the grant lookup entirely when config is null — the actual D1 shape for the overwhelming majority of tools (`AppTool.config: Record<string, JsonValue> | null`), as opposed to an empty object", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "null config, fully wired agent context" },
		}));
		const resolveToolApprovalGrant = vi.fn();

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: null },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("skips the grant lookup entirely when approvalPolicy is 'never'", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "explicit never" },
		}));
		const resolveToolApprovalGrant = vi.fn();

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "never" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("treats a malformed approvalPolicy value as 'never' — never calls the grant lookup", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "malformed policy" },
		}));
		const resolveToolApprovalGrant = vi.fn();

		const malformedTool = {
			...tool,
			config: { approvalPolicy: "sometimes" },
		} as unknown as typeof tool & { config: Record<string, JsonValue> };
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			malformedTool,
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("'once' policy: an approved grant skips elicitation entirely", async () => {
		const elicitInput = vi.fn();
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-1",
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
		expect(resolveToolApprovalGrant).toHaveBeenCalledWith({
			organizationId: "org-1",
			subjectId: "user-1",
			appSlug: "shop",
			toolId: "delete_app",
			grantKind: "once",
		});
	});

	it("'always' policy: an approved grant skips elicitation entirely", async () => {
		const elicitInput = vi.fn();
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "grant-2",
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "always" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
		expect(resolveToolApprovalGrant).toHaveBeenCalledWith(
			expect.objectContaining({ grantKind: "always" }),
		);
	});

	it("falls through to elicitation when the resolve call returns approved:false (no matching grant)", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "fell through" },
		}));
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: false,
			grantId: null,
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("a lost consume CAS (approved:false) is NEVER treated as approval — falls through, never auto-approves", async () => {
		const elicitInput = vi.fn(async () => ({ action: "decline" }));
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: false,
			grantId: null,
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		// Fell through to elicitation, which declined — must be a denial, not
		// a silent auto-approval of the raced-away grant.
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain("declined");
	});

	it("a resolve-call network error fails closed to elicitation, never to auto-approval", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "fell through after error" },
		}));
		const resolveToolApprovalGrant = vi.fn(async () => {
			throw new Error("network down");
		});

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "always" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(elicitInput).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("skips the grant lookup (fails closed) when apiClient is unavailable — falls through to elicitation", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "no apiClient" },
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput }), // no resolveToolApprovalGrant → no apiClient
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("skips the grant lookup (fails closed) when organizationId is unavailable", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "no org" },
		}));
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "should-not-be-used",
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveToolApprovalGrant,
				organizationId: null,
			}),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("skips the grant lookup (fails closed) when appSlug is unavailable", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "no appSlug" },
		}));
		const resolveToolApprovalGrant = vi.fn(async () => ({
			approved: true,
			grantId: "should-not-be-used",
		}));

		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveToolApprovalGrant,
				appSlug: null,
			}),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);

		expect(result).toBeNull();
		expect(resolveToolApprovalGrant).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});

	it("a grant approval for one tool is scoped by toolId in the resolve call — never silently reused for another tool", async () => {
		const elicitInput = vi.fn();
		const resolveToolApprovalGrant = vi.fn(async (args: unknown) => {
			const { toolId } = args as { toolId: string };
			// Simulate the server-side exact-scope enforcement: only this exact
			// tool id is approved.
			return toolId === "delete_app"
				? { approved: true, grantId: "grant-3" }
				: { approved: false, grantId: null };
		});

		const approvedResult = await requireDestructiveToolApproval(
			grantApprovalContext({ elicitInput, resolveToolApprovalGrant }),
			{ ...tool, config: { approvalPolicy: "once" } },
			{ destructiveHint: true },
		);
		expect(approvedResult).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();

		const declineOnFallthrough = vi.fn(async () => ({ action: "decline" }));
		const deniedResult = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput: declineOnFallthrough,
				resolveToolApprovalGrant,
			}),
			{
				toolId: "drop_database",
				title: "Drop database",
				config: { approvalPolicy: "once" },
			},
			{ destructiveHint: true },
		);
		expect(deniedResult?.isError).toBe(true);
		expect(declineOnFallthrough).toHaveBeenCalled();
	});
});

describe("destructive tool approval — Work Item authorization", () => {
	const authorized = {
		approved: true,
		reason: "active_user_receipt",
		workItemId: "leaf-1",
		authorizationScopeWorkItemId: "campaign-1",
		authorizationCommentId: "comment-1",
		attemptId: "attempt-1",
		campaignKey: "promptwatch-repositioning",
		validUntil: "2026-08-01T12:00:00.000Z",
	};
	const publishTool = {
		toolId: "cms_landing__content_publish",
		title: "Publish content",
		config: { approvalPolicy: "work_item" as const },
	};
	const publishArgs = { collection: "posts", id: "post-1" };

	it("allows an agent only when the API resolves an active owner/admin receipt", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => authorized);
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
		expect(resolveWorkItemAuthorization).toHaveBeenCalledWith({
			organizationId: "org-1",
			subjectId: "tedi-1",
			appSlug: "tedix-unified",
			toolId: "cms_landing__content_publish",
			args: publishArgs,
		});
	});

	it("enforces the exact Tedix publish boundary even if annotations/config are stale", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "no_current_user_authorization",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			{ ...publishTool, config: {} },
			{ destructiveHint: false },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);
		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalled();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("keeps the retired blog publisher behind the gate", async () => {
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "tool_scope_mismatch",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput: vi.fn(),
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			{
				toolId: "cms_tedix__content_publish",
				title: "Retired blog",
				config: {},
			},
			{ destructiveHint: false },
			{ autoConfirmAgent: true, args: publishArgs },
		);
		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalled();
	});

	it("does not let an invented dryRun argument bypass the real publish gate", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "no_current_user_authorization",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: { ...publishArgs, dryRun: true },
			},
		);

		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				args: expect.objectContaining({ dryRun: true }),
			}),
		);
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("denies the directly addressable Tedix CMS host before agent auto-confirm", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "tool_scope_mismatch",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "cms-tedix-landing",
			}),
			{
				toolId: "cms__content_publish",
				title: "Publish Content",
				config: { _aggregateConnectionLabel: "tedix" },
			},
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				appSlug: "cms-tedix-landing",
				toolId: "cms__content_publish",
			}),
		);
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("denies the base CMS host when its inbound connection targets Tedix", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "tool_scope_mismatch",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "cms",
				connectionLabel: "tedix",
			}),
			{
				toolId: "content_publish",
				title: "Publish Content",
				config: {},
			},
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalled();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("does not impose the Tedix Work Item policy on sibling CMS tenants", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn();
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			{
				toolId: "cms-acme__content_publish",
				title: "Publish Acme content",
				config: {
					approvalPolicies: {
						"tedix-unified:cms_landing__content_publish": "work_item",
					},
				},
			},
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);
		expect(result).toBeNull();
		expect(resolveWorkItemAuthorization).not.toHaveBeenCalled();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("denies before agent auto-confirm when the receipt is absent", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "no_current_user_authorization",
			authorizationCommentId: null,
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result?.isError).toBe(true);
		// "owner/admin" dropped deliberately: an accountable non-human principal
		// may hold this authority, so a denial that still says
		// "owner/admin" would send an agent hunting for a human who is not
		// required. The denial must stay specific about what is missing.
		expect(callToolResultText(result!)).toContain(
			"no current server-attributed authorization receipt from an accountable principal",
		);
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("denies before agent auto-confirm when authorization resolution errors", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const elicitInput = vi.fn();
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization: async () => {
					throw new Error("API unavailable");
				},
				authType: "tedi",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"authorization_lookup_failed",
		);
		expect(elicitInput).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("gates a verified external agent even without declared Tasks capabilities", async () => {
		const elicitInput = vi.fn();
		const resolveWorkItemAuthorization = vi.fn(async () => ({
			...authorized,
			approved: false,
			reason: "no_active_tedi_leaf",
		}));
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "external_agent",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{
				allowSyncMrtr: false,
				autoConfirmAgent: true,
				args: publishArgs,
			},
		);

		expect(result?.isError).toBe(true);
		expect(resolveWorkItemAuthorization).toHaveBeenCalled();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("keeps the normal explicit path for a user principal", async () => {
		const elicitInput = vi.fn(async () => ({
			action: "accept",
			content: { reason: "owner publication" },
		}));
		const resolveWorkItemAuthorization = vi.fn();
		const result = await requireDestructiveToolApproval(
			grantApprovalContext({
				elicitInput,
				resolveWorkItemAuthorization,
				authType: "user",
				appSlug: "tedix-unified",
			}),
			publishTool,
			{ destructiveHint: true },
			{ args: publishArgs },
		);

		expect(result).toBeNull();
		expect(resolveWorkItemAuthorization).not.toHaveBeenCalled();
		expect(elicitInput).toHaveBeenCalled();
	});
});

describe("destructive tool approval — autonomous agent auto-confirm (Code Mode)", () => {
	it("auto-approves a destructive tool for an agent caller, with no elicitation", async () => {
		const elicitInput = vi.fn(async () => {
			throw new Error(
				"must not prompt: agent auto-confirm should approve first",
			);
		});
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput, "tedi"),
			tool,
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("auto-approves for a service (kernel) agent caller too", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn(), "service"),
			tool,
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result).toBeNull();
	});

	it("denies an unconfigured external-transport write before agent auto-confirm", async () => {
		const elicitInput = vi.fn();
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput, "tedi", true),
			{ ...tool, config: { transport: "external" } },
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"external-transport tools require an explicit approval policy configured for the app",
		);
		expect(callToolResultText(result!)).toContain(
			"Home's parked approval flow",
		);
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("preserves the rollout default for an unconfigured external transport", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn(), "tedi", false),
			{ ...tool, config: { transport: "external" } },
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);

		expect(result).toBeNull();
	});

	it("denies an unconfigured third-party MCP write before agent auto-confirm", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn(), "service", true),
			{
				...tool,
				config: {
					transport: "mcp",
					mcpServerUrl: "https://mcp.provider.example/mcp",
				},
			},
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);

		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"mcp-transport tools require an explicit approval policy configured for the app",
		);
	});

	it("keeps first-party RPC and Tedix-managed MCP writes on the existing auto-confirm path", async () => {
		const configs: Array<Record<string, JsonValue>> = [
			{ transport: "rpc" },
			{
				transport: "mcp",
				mcpServerUrl: "https://cto.tedi.tedix.dev/mcp",
			},
		];
		for (const config of configs) {
			const result = await requireDestructiveToolApproval(
				agentApprovalContext(vi.fn(), "tedi"),
				{ ...tool, config },
				{ destructiveHint: true },
				{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
			);
			expect(result).toBeNull();
		}
	});

	it("lets an explicit D1 policy opt a third-party transport into the established path", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn(), "tedi", true),
			{
				...tool,
				config: { transport: "external", approvalPolicy: "never" },
			},
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);

		expect(result).toBeNull();
	});

	it("does NOT auto-approve a human operator — they fall through and fail closed", async () => {
		// approvalContext has no callerIdentity → not an agent. Even with the flag,
		// a human via Code Mode must confirm explicitly (or be denied), never
		// auto-approved.
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});
		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			tool,
			{ destructiveHint: true },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result?.isError).toBe(true);
		expect(callToolResultText(result!)).toContain(
			"destructive approval is unavailable",
		);
	});

	it("requires the flag — an agent WITHOUT autoConfirmAgent still fails closed", async () => {
		const elicitInput = vi.fn(async () => {
			throw new Error("Client does not support elicitation");
		});
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(elicitInput, "tedi"),
			tool,
			{ destructiveHint: true },
			{ allowSyncMrtr: false, args: {} },
		);
		expect(result?.isError).toBe(true);
	});

	it("still skips entirely for a non-destructive tool", async () => {
		const result = await requireDestructiveToolApproval(
			agentApprovalContext(vi.fn(), "tedi"),
			tool,
			{ destructiveHint: false },
			{ allowSyncMrtr: false, autoConfirmAgent: true, args: {} },
		);
		expect(result).toBeNull();
	});
});

/**
 * The gate must consume the declared capability, not the raw column.
 *
 * `resolveWireAnnotations` existed and was correct, and the discovery path used
 * it — but the Code Mode EXECUTION path passed `tool.annotations` straight
 * through. So `discover.search()` advertised a declared-destructive tool as
 * `destructiveHint: true` while the executor ran it with no approval and no
 * elicitation: discovery and enforcement disagreed inside one file.
 *
 * That row shape — `annotations: null`, `writeCapability: "destructive"` — is
 * the PRIMARY PRODUCT of declared capability. `updateAppTool` writes the
 * declaration while deliberately leaving `annotations` untouched, because the
 * whole point is the third-party tools whose upstream never sends annotations.
 * The declaration was therefore inert on the one path tedis actually execute
 * on, which is the gateway-native default.
 *
 * Nothing bound the gate to the projection, which is why a correct helper and a
 * green suite coexisted with a live bypass. This binds them.
 */
describe("declared capability reaches the destructive gate", () => {
	const declaredDestructive = {
		toolId: "cms_provision_service_key",
		title: "Provision service key",
		annotations: null,
		writeCapability: "destructive",
	} as unknown as AppTool;

	it("gates a declared-destructive tool that carries no upstream annotations", async () => {
		const elicitInput = vi.fn(async () => ({ action: "decline" }));

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			declaredDestructive,
			resolveWireAnnotations(declaredDestructive),
		);

		// A refusal object means the gate engaged. `null` means it ran ungated.
		expect(result).not.toBeNull();
		expect(elicitInput).toHaveBeenCalledTimes(1);
	});

	it("shows the raw column is NOT sufficient — the projection is what gates", async () => {
		// The exact pre-fix call. Pinned so the regression is visible as a
		// contrast rather than only as an absence.
		const elicitInput = vi.fn(async () => ({ action: "decline" }));

		const result = await requireDestructiveToolApproval(
			approvalContext(elicitInput),
			declaredDestructive,
			declaredDestructive.annotations as never,
		);

		expect(result).toBeNull();
		expect(elicitInput).not.toHaveBeenCalled();
	});

	it("leaves an undeclared tool's annotations untouched", () => {
		const undeclared = {
			toolId: "createJiraIssue",
			annotations: null,
			writeCapability: null,
		} as unknown as AppTool;
		expect(resolveWireAnnotations(undeclared)).toBeUndefined();
	});
});
