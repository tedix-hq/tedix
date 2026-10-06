import * as z from "zod";
import { type FactoryBlueprint } from "@tedix/api-contract/schemas/factory-blueprints";
import { OsBlueprintDefinitionSchema } from "@tedix/api-contract/schemas/os-workspaces";
import {
	type CreateWorkItemInput,
	WorkAdmissionSpecificationSchema,
	WorkItemAcceptanceContractSchema,
	WorkItemKindSchema,
	WorkItemRiskLevelSchema,
} from "@tedix/api-contract/schemas/work-items";
import type { DbClient } from "@tedix/db/client";
import { getOsWorkspace } from "@tedix/db/queries/os-workspaces/workspaces";
import { getOsBlueprintRevision } from "@tedix/db/queries/os-workspaces/blueprints";
import { getWorkItemBySourceIntentId } from "@tedix/db/queries/work-items/crud";
import { canonicalDigest, canonicalJson } from "../lib/blueprint-digest";
import { createError, ErrorCodes } from "../rpc/orpc";

/** Server-derived proposal. Acceptance and admission remain Work writes. */
export const FactoryCycleRecordSchema = z
	.object({
		version: z.literal(1),
		factoryKey: z.string(),
		workspaceId: z.uuid(),
		blueprintRevisionId: z.uuid(),
		definitionDigest: z.string(),
		inputDigest: z.string(),
		cycleKey: z.string(),
		templateKey: z.string(),
		outcome: z.enum(["deliverable", "no_work"]),
		sourceRefs: z.array(
			z.object({ uri: z.string(), revision: z.string() }).strict(),
		),
		maxAttempts: z.number().int().positive(),
		execution: z
			.object({
				workKind: WorkItemKindSchema,
				riskLevel: WorkItemRiskLevelSchema,
				requiredCapabilities: z.array(z.string()),
				requiredAuthorities: z.array(z.string()),
			})
			.strict(),
		acceptanceContract: WorkItemAcceptanceContractSchema,
		admissionSpecification: WorkAdmissionSpecificationSchema,
	})
	.strict();

export function readFactoryCycle(metadata: Record<string, unknown> | null) {
	return metadata?.factoryCycle === undefined
		? null
		: FactoryCycleRecordSchema.parse(metadata.factoryCycle);
}

export async function compileFactoryCycle(input: {
	request: CreateWorkItemInput;
	factory: FactoryBlueprint;
	definitionDigest: string;
}) {
	const { request, factory, definitionDigest } = input;
	const cycle = request.factoryCycle;
	if (!cycle || !request.projectId || !request.objectiveId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Factory cycles require workspace pin, projectId, and objectiveId",
		);
	}
	const template = factory.templates.find(
		(item) => item.key === cycle.templateKey,
	);
	if (!template || cycle.sourceRefs.length > factory.intake.maxSourceRefs) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Unknown factory template or source-reference limit exceeded",
		);
	}
	// Sorting makes source order irrelevant. Revisions are explicit; no mutable latest links.
	const sourceRefs = [...cycle.sourceRefs].sort((a, b) =>
		canonicalJson(a).localeCompare(canonicalJson(b)),
	);
	if (
		new Set(sourceRefs.map((ref) => canonicalJson(ref))).size !==
		sourceRefs.length
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Factory source references must be unique",
		);
	}
	const sourceIntentId = `factory:${await canonicalDigest({ workspaceId: cycle.workspaceId, cycleKey: cycle.cycleKey })}`;
	const inputDigest = await canonicalDigest({
		cycle: { ...cycle, sourceRefs },
		definitionDigest,
		projectId: request.projectId,
		objectiveId: request.objectiveId,
		summary: request.description ?? null,
		binding: {
			parentWorkItemId: request.parentWorkItemId,
			accountableOwnerType: request.accountableOwnerType,
			accountableOwnerId: request.accountableOwnerId,
			stewardType: request.stewardType,
			stewardId: request.stewardId,
			priority: request.priority,
			dueDate: request.dueDate,
			deadline: request.deadline,
			metadata: request.metadata,
			provenance: request.provenance,
		},
	});
	const record = FactoryCycleRecordSchema.parse({
		version: 1,
		factoryKey: factory.key,
		workspaceId: cycle.workspaceId,
		blueprintRevisionId: cycle.blueprintRevisionId,
		definitionDigest,
		inputDigest,
		cycleKey: cycle.cycleKey,
		templateKey: template.key,
		outcome: template.outcome,
		sourceRefs,
		maxAttempts: factory.limits.maxAttemptsPerCycle,
		execution: {
			workKind: template.workKind,
			riskLevel: template.riskLevel,
			requiredCapabilities: template.requiredCapabilities,
			requiredAuthorities: template.requiredAuthorities,
		},
		acceptanceContract: template.acceptanceContract,
		admissionSpecification: {
			resources: [{ resourceKey: `factory:${cycle.workspaceId}`, quantity: 1 }],
			budget: {
				limitMicros: factory.limits.budgetMicrosPerCycle,
				reservationMicros: factory.limits.budgetMicrosPerCycle,
			},
		},
	});
	const prepared: CreateWorkItemInput = {
		...request,
		title: `${template.title}: ${cycle.cycleKey}`,
		description: [factory.purpose, template.procedure, request.description]
			.filter(Boolean)
			.join("\n\n"),
		workKind: template.workKind,
		riskLevel: template.riskLevel,
		requiredCapabilities: template.requiredCapabilities,
		requiredAuthorities: template.requiredAuthorities,
		sourceIntentId,
		metadata: { ...request.metadata, factoryCycle: record },
	};
	if (prepared.description && prepared.description.length > 10_000) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Factory cycle description exceeds the Work limit",
		);
	}
	if (prepared.title.length > 500)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Factory cycle title exceeds the Work limit",
		);
	return prepared;
}

export async function prepareFactoryCycle(
	db: DbClient,
	orgId: string,
	request: CreateWorkItemInput,
) {
	if (
		request.metadata?.factoryCycle !== undefined ||
		request.sourceIntentId?.startsWith("factory:")
	) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Factory provenance is server-derived; supply factoryCycle instead",
		);
	}
	if (!request.factoryCycle) return request;
	const cycle = request.factoryCycle;
	const workspace = await getOsWorkspace(db, {
		organizationId: orgId,
		workspaceId: cycle.workspaceId,
	});
	if (!workspace || workspace.status !== "active") {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Active factory workspace not found in this organization",
		);
	}
	if (workspace.sourceBlueprintRevisionId !== cycle.blueprintRevisionId) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Factory workspace revision changed; reload before proposing a cycle",
		);
	}
	const revision = await getOsBlueprintRevision(db, {
		organizationId: orgId,
		revisionId: cycle.blueprintRevisionId,
	});
	if (!revision || revision.blueprintId !== workspace.sourceBlueprintId) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Pinned factory revision is unavailable",
		);
	}
	const definition = OsBlueprintDefinitionSchema.parse(
		JSON.parse(revision.definition),
	);
	if (!definition.factory)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Workspace has no factory operating contract",
		);
	return compileFactoryCycle({
		request,
		factory: definition.factory,
		definitionDigest: await canonicalDigest(definition),
	});
}

/** Also called after a lost unique-key race; never overwrites the winner. */
export async function replayFactoryCycle(
	db: DbClient,
	orgId: string,
	input: CreateWorkItemInput,
) {
	if (!input.factoryCycle || !input.sourceIntentId) return null;
	const current = await getWorkItemBySourceIntentId(db, {
		orgId,
		sourceIntentId: input.sourceIntentId,
	});
	if (!current) return null;
	const expected = readFactoryCycle(input.metadata ?? {});
	const actual = readFactoryCycle(current.metadata);
	if (!actual || actual.inputDigest !== expected?.inputDigest) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Factory cycle key already names different inputs; inspect the existing cycle",
		);
	}
	return current;
}

export function requireFactoryAcceptance(
	metadata: Record<string, unknown> | null,
	acceptance: z.infer<typeof WorkItemAcceptanceContractSchema>,
) {
	const cycle = readFactoryCycle(metadata);
	if (
		cycle &&
		canonicalJson(cycle.acceptanceContract) !== canonicalJson(acceptance)
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Factory acceptance must match the pinned template; revise the blueprint for a different contract",
		);
	}
}

export function requireFactoryAdmission(input: {
	metadata: Record<string, unknown> | null;
	specification: z.infer<typeof WorkAdmissionSpecificationSchema>;
	attemptCount: number;
	execution?: z.infer<typeof FactoryCycleRecordSchema>["execution"];
}) {
	const cycle = readFactoryCycle(input.metadata);
	if (!cycle) return;
	if (canonicalJson(input.execution) !== canonicalJson(cycle.execution)) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Factory execution specification must match the pinned template",
		);
	}
	if (input.attemptCount >= cycle.maxAttempts) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Factory retry budget exhausted; diagnose and propose a new bounded cycle",
		);
	}
	if (
		canonicalJson(input.specification) !==
		canonicalJson(cycle.admissionSpecification)
	) {
		throw createError(
			ErrorCodes.CONFLICT,
			"Configure the factory cycle's declared resource and budget before admission",
		);
	}
}
