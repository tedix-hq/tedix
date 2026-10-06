import { QueryClient } from "@tanstack/react-query";
import { skillsContract } from "@tedix/api-contract/contracts/cognitive";
import { osWorkspacesContract } from "@tedix/api-contract/contracts/os-workspaces";
import { workItemsContract } from "@tedix/api-contract/contracts/work-items";
import {
	SkillRunSchema,
	SkillRunStatusSchema,
	SkillWorkflowRevisionSchema,
	SkillWorkflowStepSchema,
} from "@tedix/api-contract/schemas/cognitive";
import { EnqueueHomeMessageInputSchema } from "@tedix/api-contract/schemas/kernel-runtime";
import { RationaleRecordSchema } from "@tedix/api-contract/schemas/rationale-records";
import {
	OsDocumentBlockSchema,
	OsDocumentPatchOpSchema,
	OsGadgetExecutionSchema,
	OsGadgetExecutionStatusSchema,
	OsGadgetManifestSchema,
	OsGadgetSchema,
	OsOutputSchema,
	OsPresentationPatchOpSchema,
	OsPresentationSlideOutlineSchema,
	OsWorkspaceSchema,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	CreateWorkItemInputSchema,
	WorkItemCommentSchema,
	WorkItemDispositionSchema,
	WorkItemKindSchema,
	WorkItemReadinessSchema,
	WorkItemSchema,
} from "@tedix/api-contract/schemas/work-items";
import type { WebMcpToolDef } from "@tedix/webmcp-core/model-context";
import { describe, expect, it } from "vite-plus/test";
import * as z from "zod";
import { buildChatWebMcpTools } from "@/components/chat-webmcp-tools";
import { buildOutputsWebMcpTools } from "@/components/outputs-webmcp-tools";
import { buildRunWebMcpTools } from "@/components/run-webmcp-tools";
import { buildSkillsWebMcpTools } from "@/components/skills-webmcp-tools";
import { buildWorkItemWebMcpTools } from "@/components/work-item-webmcp-tools";
import { buildWorkspaceWebMcpTools } from "@/components/workspace-webmcp-tools";
import { buildWorkWebMcpTools } from "@/components/work-webmcp-tools";

/**
 * Doctrine drift guard (docs/product/tedix-os.md, "One backend contract, two
 * thin adapters"). The high-value tool schemas are now DERIVED from the owning
 * zod contracts via `deriveToolSchema` (src/lib/webmcp/derive-schema.ts), so
 * the assertions that used to catch hand-written drift against the contract
 * are retired where derivation makes them true by construction — each
 * retirement is commented in place. What this suite still owns:
 *
 * - OVERLAY guards: deliberate tool strictness the contract does not share
 *   (required expectedRevision, required reason, tool-only tediSlug/confirm)
 *   must stay deliberate — and must fire if the contract catches up.
 * - Hand-written remnants: the simplified op unions, slide outlines, and
 *   zero-arg context tools stay hand-written adapters, so their parity checks
 *   stay.
 * - Wiring proofs: a spot assertion per derived family that a contract fact
 *   (an enum vocabulary, a required key) really reaches the registered
 *   schema.
 *
 * Builders are used schema-only: no execute() is ever called, so no deps
 * beyond an inert QueryClient are needed.
 */

// ── Introspection helpers ────────────────────────────────────────────────────

type JsonSchema = {
	properties?: Record<string, JsonSchema>;
	required?: readonly string[];
	items?: JsonSchema;
	oneOf?: readonly JsonSchema[];
	enum?: readonly string[];
	const?: string;
	maxLength?: number;
	maxItems?: number;
	description?: string;
};

function byName(tools: WebMcpToolDef[]): Map<string, WebMcpToolDef> {
	return new Map(tools.map((tool) => [tool.name, tool]));
}

function tool(map: Map<string, WebMcpToolDef>, name: string): WebMcpToolDef {
	const found = map.get(name);
	if (!found) throw new Error(`tool ${name} is not built`);
	return found;
}

function schemaOf(def: WebMcpToolDef): JsonSchema {
	return def.inputSchema as JsonSchema;
}

function propsOf(def: WebMcpToolDef): Record<string, JsonSchema> {
	return schemaOf(def).properties ?? {};
}

function requiredOf(def: WebMcpToolDef): readonly string[] {
	return schemaOf(def).required ?? [];
}

/** Unwrap optional/default/nullable wrappers to the underlying zod schema. */
function unwrapZod(schema: z.ZodType): z.ZodType {
	let current = schema;
	for (;;) {
		const def = current.def as { type?: string; innerType?: z.ZodType };
		if (
			(def.type === "optional" ||
				def.type === "default" ||
				def.type === "nullable") &&
			def.innerType
		) {
			current = def.innerType;
			continue;
		}
		return current;
	}
}

function asZodObject(schema: unknown): z.ZodObject<z.ZodRawShape> {
	const unwrapped = unwrapZod(schema as z.ZodType);
	if (!(unwrapped instanceof z.ZodObject)) {
		throw new Error("expected a zod object schema");
	}
	return unwrapped;
}

function shapeKeys(schema: unknown): string[] {
	return Object.keys(asZodObject(schema).shape);
}

function isOptionalKey(schema: unknown, key: string): boolean {
	const field = asZodObject(schema).shape[key];
	if (!field) throw new Error(`key ${key} is not in the contract shape`);
	return (field as z.ZodType).isOptional();
}

/** Discriminator literal values of a zod discriminated union on `op`/`type`. */
function unionDiscriminators(schema: unknown, key: string): string[] {
	const union = schema as { options: readonly unknown[] };
	return union.options.map((option) => {
		const literal = asZodObject(option).shape[key] as unknown as {
			value: string;
		};
		return literal.value;
	});
}

/** `op` consts declared by a tool's oneOf op union. */
function oneOfOpConsts(ops: JsonSchema | undefined): string[] {
	const oneOf = ops?.items?.oneOf ?? [];
	return oneOf.map((branch) => {
		const value = branch.properties?.["op"]?.const;
		if (!value) throw new Error("oneOf branch has no op const");
		return value;
	});
}

const OUTPUT_ID = "0b8b7d4e-9f2a-4c1d-8e3f-6a5b4c3d2e1f";

// ── Built tool sets (schema-only; execute is never called) ───────────────────

const inertQueryClient = new QueryClient();
const workTools = byName(
	buildWorkWebMcpTools({ queryClient: inertQueryClient }),
);
const workItemTools = byName(
	buildWorkItemWebMcpTools(OUTPUT_ID, { queryClient: inertQueryClient }),
);
const outputsTools = byName(buildOutputsWebMcpTools());
const runTools = byName(buildRunWebMcpTools(OUTPUT_ID));
const chatTools = byName(buildChatWebMcpTools());
const skillsTools = byName(buildSkillsWebMcpTools());
const workspaceTools = byName(buildWorkspaceWebMcpTools(OUTPUT_ID, () => null));

const outputsContract = osWorkspacesContract.outputs;

interface ContractProcedure {
	"~orpc": {
		inputSchemas?: readonly unknown[];
		outputSchemas?: readonly unknown[];
	};
}

function contractInput(
	procedure: ContractProcedure,
): z.ZodObject<z.ZodRawShape> {
	return asZodObject(procedure["~orpc"].inputSchemas?.[0]);
}

function contractOutput(
	procedure: ContractProcedure,
): z.ZodObject<z.ZodRawShape> {
	return asZodObject(procedure["~orpc"].outputSchemas?.[0]);
}

// ── work-webmcp-tools ────────────────────────────────────────────────────────

describe("work-webmcp-tools parity with workItemsContract", () => {
	const listInput = contractInput(workItemsContract.list);

	// RETIRED (schema now derived): the hand-written disposition enum equality
	// and the workKind advertised-examples parse probe are redundant —
	// list_work_items derives both filter vocabularies from the contract's
	// list input via deriveToolSchema. The wiring proof below replaces them.
	it("list_work_items filter enums are wired from the contract (derived)", () => {
		const props = propsOf(tool(workTools, "list_work_items"));
		expect(props["disposition"]?.enum).toEqual(
			WorkItemDispositionSchema.options,
		);
		// Derivation upgraded workKind from a free string to the contract enum.
		expect(props["workKind"]?.enum).toEqual(WorkItemKindSchema.options);
	});

	it("list_work_items args stay inside the contract list input shape", () => {
		const keys = shapeKeys(listInput);
		for (const arg of Object.keys(
			propsOf(tool(workTools, "list_work_items")),
		)) {
			expect(keys, `list arg "${arg}" left the contract`).toContain(arg);
		}
	});

	it("create_work_item args stay inside CreateWorkItemInputSchema", () => {
		const keys = Object.keys(CreateWorkItemInputSchema.shape);
		for (const arg of Object.keys(
			propsOf(tool(workTools, "create_work_item")),
		)) {
			expect(keys, `create arg "${arg}" left the contract`).toContain(arg);
		}
	});

	// RETIRED (schema now derived): "requires every exposed contract-required
	// key" and the workKind description-vocabulary probe are redundant —
	// create_work_item derives its required set, the workKind enum, and the
	// contract default from CreateWorkItemInputSchema. The wiring proof below
	// replaces them.
	it("create_work_item required set and workKind vocabulary are wired from the contract (derived)", () => {
		const create = tool(workTools, "create_work_item");
		expect(requiredOf(create)).toEqual(["title"]);
		const workKind = propsOf(create)["workKind"] as
			| (JsonSchema & { default?: string })
			| undefined;
		expect(workKind?.enum).toEqual(WorkItemKindSchema.options);
		expect(workKind?.default).toBe("other");
	});
});

// ── work-item-webmcp-tools (result identity) ─────────────────────────────────

describe("work-item-webmcp-tools result identity with workItemsContract", () => {
	it("get_current_work_item reads fields that exist on the getById output", () => {
		// The composite tool takes no arguments — the item id is closed over.
		const composite = tool(workItemTools, "get_current_work_item");
		expect(Object.keys(propsOf(composite))).toEqual([]);
		const output = contractOutput(workItemsContract.getById);
		expect(Object.keys(output.shape)).toEqual(
			expect.arrayContaining(["workItem", "comments"]),
		);
		// Every WorkItem field the projection reads must stay on WorkItemSchema.
		const itemKeys = Object.keys(WorkItemSchema.shape);
		for (const field of [
			"id",
			"title",
			"disposition",
			"workKind",
			"workClass",
			"acceptanceContract",
		]) {
			expect(itemKeys, `projection reads workItem.${field}`).toContain(field);
		}
		const commentKeys = Object.keys(WorkItemCommentSchema.shape);
		for (const field of ["authorType", "body", "createdAt"]) {
			expect(commentKeys, `projection reads comment.${field}`).toContain(field);
		}
	});

	it("get_current_work_item readiness projection matches the getReadiness output", () => {
		const readiness = contractOutput(workItemsContract.getReadiness);
		expect(readiness).toBe(unwrapZod(WorkItemReadinessSchema));
		const keys = Object.keys(WorkItemReadinessSchema.shape);
		for (const field of ["state", "ready", "reasons"]) {
			expect(keys, `projection reads readiness.${field}`).toContain(field);
		}
	});
});

// ── run-webmcp-tools (result identity) ───────────────────────────────────────

describe("run-webmcp-tools result identity with skillsContract", () => {
	const inspectOutput = contractOutput(skillsContract.inspectWorkflowRun);

	it("every run tool is a no-argument read of the closed-over run", () => {
		for (const name of [
			"get_current_run",
			"list_current_run_steps",
			"explain_current_run",
		]) {
			expect(Object.keys(propsOf(tool(runTools, name))), name).toEqual([]);
		}
	});

	it("the run summary projection reads fields that exist on the inspect output", () => {
		expect(Object.keys(inspectOutput.shape)).toEqual(
			expect.arrayContaining([
				"run",
				"revision",
				"steps",
				"toolCalls",
				"warnings",
			]),
		);
		expect(inspectOutput.shape["run"]).toBe(SkillRunSchema);
		const runKeys = Object.keys(SkillRunSchema.shape);
		for (const field of [
			"id",
			"status",
			"skillId",
			"tediId",
			"createdBy",
			"workItemId",
			"executionEpoch",
			"startedAt",
			"completedAt",
			"pausedAt",
			"error",
			"costSummary",
		]) {
			expect(runKeys, `projection reads run.${field}`).toContain(field);
		}
		const revisionKeys = Object.keys(SkillWorkflowRevisionSchema.shape);
		for (const field of ["skillSlug", "revision"]) {
			expect(revisionKeys, `projection reads revision.${field}`).toContain(
				field,
			);
		}
	});

	it("get_current_run advertises exactly the SkillRunStatusSchema vocabulary", () => {
		const description = tool(runTools, "get_current_run").description ?? "";
		const listed = /Status: ([^.]+)\./.exec(description)?.[1];
		expect(listed).toBeTruthy();
		const advertised = (listed ?? "")
			.split(/,\s*/)
			.map((token) => token.replace(/^or /, ""));
		expect([...advertised].sort()).toEqual(
			[...SkillRunStatusSchema.options].sort(),
		);
	});

	it("list_current_run_steps projects fields on SkillWorkflowStepSchema and its outcome enum", () => {
		const stepKeys = Object.keys(SkillWorkflowStepSchema.shape);
		for (const field of [
			"name",
			"kind",
			"outcome",
			"status",
			"attempt",
			"durationMs",
			"executionEpoch",
			"namespace",
			"method",
		]) {
			expect(stepKeys, `projection reads step.${field}`).toContain(field);
		}
		const description =
			tool(runTools, "list_current_run_steps").description ?? "";
		const listed = /Outcome: ([^.]+)\./.exec(description)?.[1];
		expect(listed).toBeTruthy();
		const advertised = (listed ?? "")
			.split(/,\s*/)
			.map((token) => token.replace(/^or /, ""));
		expect([...advertised].sort()).toEqual(
			[...SkillWorkflowStepSchema.shape.outcome.options].sort(),
		);
	});

	it("explain_current_run rationale projection reads fields on RationaleRecordSchema", () => {
		const keys = Object.keys(RationaleRecordSchema.shape);
		// runId is the client-side execution-link filter the page itself uses.
		for (const field of [
			"runId",
			"action",
			"rationale",
			"category",
			"confidence",
			"outcomeStatus",
			"outcome",
			"createdAt",
		]) {
			expect(keys, `projection reads rationale.${field}`).toContain(field);
		}
	});

	it("explain_current_run artifact projection reads fields on the listRunArtifacts output", () => {
		const artifactsField = unwrapZod(
			contractOutput(skillsContract.listRunArtifacts).shape[
				"artifacts"
			] as z.ZodType,
		);
		if (!(artifactsField instanceof z.ZodArray)) {
			throw new Error("listRunArtifacts artifacts is not an array schema");
		}
		const keys = shapeKeys(artifactsField.element);
		for (const field of [
			"path",
			"mimeType",
			"sizeBytes",
			"outcome",
			"storage",
		]) {
			expect(keys, `projection reads artifact.${field}`).toContain(field);
		}
	});
});

// ── outputs-webmcp-tools ─────────────────────────────────────────────────────

describe("outputs-webmcp-tools parity with osWorkspacesContract.outputs", () => {
	it("patch_slides op discriminators equal OsPresentationPatchOpSchema's", () => {
		const toolOps = oneOfOpConsts(
			propsOf(tool(outputsTools, "patch_slides"))["ops"],
		);
		const contractOps = unionDiscriminators(OsPresentationPatchOpSchema, "op");
		expect([...toolOps].sort()).toEqual([...contractOps].sort());
	});

	it("patch_document op discriminators equal OsDocumentPatchOpSchema's", () => {
		const toolOps = oneOfOpConsts(
			propsOf(tool(outputsTools, "patch_document"))["ops"],
		);
		const contractOps = unionDiscriminators(OsDocumentPatchOpSchema, "op");
		expect([...toolOps].sort()).toEqual([...contractOps].sort());
	});

	it("patch_document simplified block kinds equal OsDocumentBlockSchema's", () => {
		const blockOneOf =
			propsOf(tool(outputsTools, "patch_document"))["ops"]?.items?.oneOf ?? [];
		const insertBranch = blockOneOf.find(
			(branch) => branch.properties?.["op"]?.const === "insert",
		);
		const kinds = (insertBranch?.properties?.["block"]?.oneOf ?? []).map(
			(branch) => branch.properties?.["kind"]?.const,
		);
		const contractKinds = unionDiscriminators(OsDocumentBlockSchema, "type");
		expect([...kinds].sort()).toEqual([...contractKinds].sort());
	});

	it("patch_slides slide caps match OsPresentationSlideOutlineSchema", () => {
		const opsSchema = propsOf(tool(outputsTools, "patch_slides"))["ops"];
		const insertBranch = (opsSchema?.items?.oneOf ?? []).find(
			(branch) => branch.properties?.["op"]?.const === "insert",
		);
		const slide = insertBranch?.properties?.["slide"];
		const titleMax = slide?.properties?.["title"]?.maxLength;
		const bulletsMax = slide?.properties?.["bullets"]?.maxItems;
		// Title cap: zod v4 exposes string maxLength directly.
		expect(titleMax).toBe(
			OsPresentationSlideOutlineSchema.shape.title.maxLength,
		);
		// A title one over the tool's declared cap must also fail contract parse.
		expect(
			OsPresentationSlideOutlineSchema.safeParse({
				title: "x".repeat((titleMax ?? 0) + 1),
			}).success,
		).toBe(false);
		// Bullets cap: zod array checks are not exposed as a plain property, so
		// probe by parse: the tool's declared maxItems must pass and +1 must fail.
		expect(typeof bulletsMax).toBe("number");
		expect(
			OsPresentationSlideOutlineSchema.safeParse({
				title: "t",
				bullets: Array.from({ length: bulletsMax ?? 0 }, () => "b"),
			}).success,
		).toBe(true);
		expect(
			OsPresentationSlideOutlineSchema.safeParse({
				title: "t",
				bullets: Array.from({ length: (bulletsMax ?? 0) + 1 }, () => "b"),
			}).success,
		).toBe(false);
	});

	// RETIRED (schema now derived): the parse-based probe that the tool's cell
	// rectangle caps stay inside the contract's caps is redundant —
	// set_sheet_range derives its whole `cells` schema (row cap, column cap,
	// cell string cap) from the contract input via deriveToolSchema. The
	// wiring proof below replaces it.
	it("set_sheet_range cell rectangle caps are wired from the contract (derived)", () => {
		const cells = propsOf(tool(outputsTools, "set_sheet_range"))["cells"];
		expect(typeof cells?.maxItems).toBe("number");
		expect(typeof cells?.items?.maxItems).toBe("number");
	});

	it("every CAS write tool requires expectedRevision the contract keeps optional", () => {
		const pairs: Array<[string, ContractProcedure]> = [
			["revise_output", outputsContract.revise],
			["patch_document", outputsContract.patchDocument],
			["patch_slides", outputsContract.patchSlides],
			["set_sheet_range", outputsContract.setSheetRange],
		];
		for (const [toolName, procedure] of pairs) {
			expect(
				requiredOf(tool(outputsTools, toolName)),
				`${toolName} no longer requires expectedRevision`,
			).toContain("expectedRevision");
			// The tool is DELIBERATELY stricter than the contract. If the contract
			// flips expectedRevision to required, this drift guard must fire so the
			// deliberate-strictness comment stops lying.
			expect(
				isOptionalKey(contractInput(procedure), "expectedRevision"),
				`${toolName}: contract expectedRevision is no longer optional`,
			).toBe(true);
		}
	});
});

// ── workspace-webmcp-tools (workbench scope; read-only, hand-written args) ───

describe("workspace-webmcp-tools parity with osWorkspacesContract", () => {
	const executionsListInput = contractInput(
		osWorkspacesContract.executions.list,
	);
	const outputsListInput = contractInput(outputsContract.list);

	it("the workbench context tools are no-argument reads of the closed-over workspace", () => {
		for (const name of ["get_workspace_overview", "get_selected_gadget"]) {
			expect(Object.keys(propsOf(tool(workspaceTools, name))), name).toEqual(
				[],
			);
		}
	});

	it("list_gadget_executions args stay inside the executions.list contract input", () => {
		const keys = shapeKeys(executionsListInput);
		for (const arg of Object.keys(
			propsOf(tool(workspaceTools, "list_gadget_executions")),
		)) {
			expect(keys, `executions arg "${arg}" left the contract`).toContain(arg);
		}
	});

	it("list_gadget_executions limit cap stays inside the contract's list limit", () => {
		const declaredMax = propsOf(tool(workspaceTools, "list_gadget_executions"))[
			"limit"
		] as (JsonSchema & { maximum?: number }) | undefined;
		expect(typeof declaredMax?.maximum).toBe("number");
		// The tool's declared max must parse under the contract's limit schema.
		expect(
			executionsListInput.safeParse({
				workspaceId: OUTPUT_ID,
				gadgetId: OUTPUT_ID,
				limit: declaredMax?.maximum,
			}).success,
		).toBe(true);
	});

	it("list_gadget_executions advertises exactly the OsGadgetExecutionStatusSchema vocabulary", () => {
		const description =
			tool(workspaceTools, "list_gadget_executions").description ?? "";
		const listed = /Status: ([^.]+)\./.exec(description)?.[1];
		expect(listed).toBeTruthy();
		const advertised = (listed ?? "")
			.split(/,\s*/)
			.map((token) => token.replace(/^or /, ""));
		expect([...advertised].sort()).toEqual(
			[...OsGadgetExecutionStatusSchema.options].sort(),
		);
	});

	it("list_workspace_outputs args stay inside the outputs.list contract input", () => {
		const keys = shapeKeys(outputsListInput);
		for (const arg of Object.keys(
			propsOf(tool(workspaceTools, "list_workspace_outputs")),
		)) {
			expect(keys, `outputs arg "${arg}" left the contract`).toContain(arg);
		}
		const declaredMax = propsOf(tool(workspaceTools, "list_workspace_outputs"))[
			"limit"
		] as (JsonSchema & { maximum?: number }) | undefined;
		expect(
			outputsListInput.safeParse({
				workspaceId: OUTPUT_ID,
				limit: declaredMax?.maximum,
			}).success,
		).toBe(true);
	});

	it("the overview projection reads fields that exist on the contract schemas", () => {
		const workspaceKeys = Object.keys(OsWorkspaceSchema.shape);
		for (const field of [
			"id",
			"name",
			"description",
			"status",
			"sourceBlueprintId",
			"createdAt",
			"updatedAt",
		]) {
			expect(workspaceKeys, `projection reads workspace.${field}`).toContain(
				field,
			);
		}
		const outputKeys = Object.keys(OsOutputSchema.shape);
		for (const field of ["id", "title", "kind", "status", "updatedAt"]) {
			expect(outputKeys, `projection reads output.${field}`).toContain(field);
		}
	});

	it("the selected-gadget projection reads fields on the gadget and manifest schemas", () => {
		const gadgetKeys = Object.keys(OsGadgetSchema.shape);
		for (const field of [
			"id",
			"name",
			"description",
			"status",
			"createdAt",
			"updatedAt",
		]) {
			expect(gadgetKeys, `projection reads gadget.${field}`).toContain(field);
		}
		const manifestKeys = Object.keys(OsGadgetManifestSchema.shape);
		for (const field of ["capabilities", "entry", "skillSlug"]) {
			expect(manifestKeys, `projection reads manifest.${field}`).toContain(
				field,
			);
		}
	});

	it("the execution-receipt projection reads fields on OsGadgetExecutionSchema", () => {
		const keys = Object.keys(OsGadgetExecutionSchema.shape);
		for (const field of [
			"id",
			"status",
			"revision",
			"createdByKind",
			"createdAt",
			"completedAt",
			"error",
		]) {
			expect(keys, `projection reads execution.${field}`).toContain(field);
		}
	});
});

// ── skills-webmcp-tools ──────────────────────────────────────────────────────

describe("skills-webmcp-tools parity with skillsContract.runWorkflow", () => {
	const runInput = contractInput(skillsContract.runWorkflow);
	const runTool = () => tool(skillsTools, "run_skill_workflow");

	it("run_skill_workflow requires reason with the contract's 4000 cap", () => {
		expect(requiredOf(runTool())).toContain("reason");
		const toolMax = propsOf(runTool())["reason"]?.maxLength;
		const contractReason = unwrapZod(
			runInput.shape["reason"] as z.ZodType,
		) as z.ZodString;
		expect(toolMax).toBe(contractReason.maxLength);
		// Deliberate strictness: the contract keeps reason optional. A contract
		// flip to required must fire this guard.
		expect(isOptionalKey(runInput, "reason")).toBe(true);
	});

	it("run_skill_workflow tediSlug is tool-only; the contract requires tediId", () => {
		expect(Object.keys(runInput.shape)).not.toContain("tediSlug");
		expect(Object.keys(runInput.shape)).toContain("tediId");
		expect(isOptionalKey(runInput, "tediId")).toBe(false);
	});

	it("run_skill_workflow confirm maps to the contract key confirmDestructive", () => {
		expect(Object.keys(propsOf(runTool()))).toContain("confirm");
		expect(Object.keys(runInput.shape)).toContain("confirmDestructive");
	});
});

// ── chat-webmcp-tools ────────────────────────────────────────────────────────

describe("chat-webmcp-tools parity with EnqueueHomeMessageInputSchema", () => {
	it("send_chat_message args stay inside the enqueue contract shape", () => {
		const keys = Object.keys(EnqueueHomeMessageInputSchema.shape);
		for (const arg of Object.keys(
			propsOf(tool(chatTools, "send_chat_message")),
		)) {
			expect(keys, `send arg "${arg}" left the contract`).toContain(arg);
		}
		expect(keys).toContain("delegateToTediId");
	});

	// RETIRED (schema now derived): the both-sides required check for content
	// is redundant — send_chat_message derives its required set from
	// EnqueueHomeMessageInputSchema, so a contract flip propagates by
	// construction. The wiring proof below replaces it.
	it("send_chat_message required set is wired from the contract (derived)", () => {
		expect(requiredOf(tool(chatTools, "send_chat_message"))).toEqual([
			"content",
		]);
	});

	it("delegate_task_to_tedi requires task and maps onto the enqueue contract", () => {
		const required = requiredOf(tool(chatTools, "delegate_task_to_tedi"));
		expect(required).toContain("task");
		expect(required).toContain("tediSlug");
		// tediSlug is tool-only sugar; the contract field it resolves into.
		expect(Object.keys(EnqueueHomeMessageInputSchema.shape)).toContain(
			"delegateToTediId",
		);
		expect(Object.keys(EnqueueHomeMessageInputSchema.shape)).not.toContain(
			"tediSlug",
		);
	});
});
