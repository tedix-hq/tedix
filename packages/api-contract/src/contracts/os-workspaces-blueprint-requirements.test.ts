/**
 * Version-pinned blueprint requirements: the parse rules that make a pin a pin,
 * the strictness that keeps a credential out of a blueprint entirely, and the
 * JSON-Schema projection the MCP tool surface depends on.
 *
 * The projection assertions matter because `tool-schema-sync` converts these
 * contracts to JSON Schema at deploy time, not at test time: a shape zod cannot
 * project would surface as a broken `os_*` tool in production rather than a red
 * test.
 */

import { describe, expect, it } from "vite-plus/test";
import {
	OsBlueprintDefinitionSchema,
	OsGadgetManifestSchema,
	OsBlueprintPreflightSchema,
	OsBlueprintRequirementsSchema,
	OsBlueprintSkillRequirementSchema,
	OsWorkspaceSchema,
} from "../schemas/os-workspaces";
import {
	procedureInputSchema,
	procedureOutputSchema,
} from "../utils/procedure-schemas";
import {
	zodToStructuredOutputJsonSchema,
	zodToToolInputJsonSchema,
} from "../utils/tool-json-schema";
import { osWorkspacesContract } from "./os-workspaces";

const SKILL_ID = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const DIGEST = "a".repeat(64);

function requirements(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		skills: [],
		connections: [],
		policies: [],
		runtime: null,
		layout: null,
		outputs: [],
		...overrides,
	};
}

describe("blueprint skill pins", () => {
	it("requires an id AND a revision — a slug alone is not a pin", () => {
		expect(
			OsBlueprintSkillRequirementSchema.safeParse({
				slug: "lead-triage",
			}).success,
		).toBe(false);
		expect(
			OsBlueprintSkillRequirementSchema.safeParse({
				skillId: SKILL_ID,
				slug: "lead-triage",
			}).success,
		).toBe(false);
		const pinned = OsBlueprintSkillRequirementSchema.parse({
			skillId: SKILL_ID,
			slug: "lead-triage",
			revision: 3,
		});
		expect(pinned).toEqual({
			role: "skill",
			skillId: SKILL_ID,
			slug: "lead-triage",
			revision: 3,
			workflowSha256: null,
		});
	});

	it("makes a flow pin its workflow digest, since a flow has no revision table", () => {
		const flow = {
			role: "flow" as const,
			skillId: SKILL_ID,
			slug: "lead-triage",
			revision: 3,
		};
		expect(OsBlueprintSkillRequirementSchema.safeParse(flow).success).toBe(
			false,
		);
		expect(
			OsBlueprintSkillRequirementSchema.safeParse({
				...flow,
				workflowSha256: DIGEST,
			}).success,
		).toBe(true);
		// The digest must be a real sha-256 hex, not any string.
		expect(
			OsBlueprintSkillRequirementSchema.safeParse({
				...flow,
				workflowSha256: "not-a-digest",
			}).success,
		).toBe(false);
	});
});

describe("blueprint requirements", () => {
	it("cannot represent a credential at all", () => {
		for (const leak of [
			{
				connections: [
					{
						providerId: "gmail",
						tokenScope: "tenant",
						scopes: [],
						accessToken: "ya29.secret",
					},
				],
			},
			{ apiKey: "sk_live_secret" },
			{
				skills: [
					{
						skillId: SKILL_ID,
						slug: "lead-triage",
						revision: 1,
						bearerToken: "secret",
					},
				],
			},
		]) {
			expect(
				OsBlueprintRequirementsSchema.safeParse(requirements(leak)).success,
			).toBe(false);
		}
	});

	it("rejects duplicate declarations that would resolve to one decision", () => {
		const skill = { skillId: SKILL_ID, slug: "lead-triage", revision: 1 };
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({
					resources: [
						{
							slot: "customer_repo",
							providerId: "github",
							resourceType: "repository",
							label: "Customer repository",
						},
						{
							slot: "customer_repo",
							providerId: "github",
							resourceType: "repository",
							label: "Another repository",
						},
					],
				}),
			).success,
		).toBe(false);
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({ skills: [skill, skill] }),
			).success,
		).toBe(false);
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({
					policies: [
						{ scope: "organization", slug: "ops", version: 1 },
						{ scope: "organization", slug: "ops", version: 2 },
					],
				}),
			).success,
		).toBe(false);
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({
					outputs: [
						{ gadget: "CRM", kind: "sheet", title: "Same" },
						{ gadget: "CRM", kind: "document", title: "Same" },
					],
				}),
			).success,
		).toBe(false);
	});

	it("declares named Gadget grants without credentials or duplicate slots", () => {
		const manifest = {
			entry: "repo-review",
			resourceGrants: [
				{ slot: "customer_repo", operations: ["read", "comment"] },
			],
		};
		expect(OsGadgetManifestSchema.safeParse(manifest).success).toBe(true);
		expect(
			OsGadgetManifestSchema.safeParse({
				...manifest,
				resourceGrants: [
					{ slot: "customer_repo", operations: ["read"] },
					{ slot: "customer_repo", operations: ["write"] },
				],
			}).success,
		).toBe(false);
		expect(
			OsGadgetManifestSchema.safeParse({
				...manifest,
				resourceGrants: [
					{ slot: "customer_repo", operations: ["read"], token: "secret" },
				],
			}).success,
		).toBe(false);
	});

	it("declares unique versioned Gadget exports without URLs or secret metadata", () => {
		const descriptor = {
			version: 1 as const,
			id: "calendar",
			label: "Calendar (.ics)",
			artifactPath: "outputs/calendar.json",
			mimeType: "text/calendar",
			extension: "ics",
		};
		expect(
			OsGadgetManifestSchema.safeParse({
				entry: "calendar-builder",
				exports: [descriptor],
			}).success,
		).toBe(true);
		expect(
			OsGadgetManifestSchema.safeParse({
				entry: "calendar-builder",
				exports: [descriptor, { ...descriptor, label: "Duplicate" }],
			}).success,
		).toBe(false);
		expect(
			OsGadgetManifestSchema.safeParse({
				entry: "calendar-builder",
				exports: [
					{
						...descriptor,
						url: "https://attacker.example/export",
					},
				],
			}).success,
		).toBe(false);
	});

	it("only accepts a model ref the cognition catalog can parse", () => {
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({
					runtime: { modelRef: "azure-openai/gpt-5.6-sol" },
				}),
			).success,
		).toBe(true);
		expect(
			OsBlueprintRequirementsSchema.safeParse(
				requirements({ runtime: { modelRef: "gpt-5.6-sol" } }),
			).success,
		).toBe(false);
	});

	it("parses a pre-requirements revision as null rather than an empty declaration", () => {
		// The distinction is load-bearing: preflight reports `not_configured` for
		// null and would report `ready` for an empty object.
		expect(OsBlueprintDefinitionSchema.parse({ gadgets: [] })).toEqual({
			gadgets: [],
			requirements: null,
		});
		// Free-form requirement strings are gone; the old keys are not revived.
		const legacy = OsBlueprintDefinitionSchema.parse({
			gadgets: [],
			skills: ["lead-triage"],
			connections: ["gmail"],
			policyRequirements: ["budget"],
			layout: { grid: [1, 2] },
		});
		expect(legacy).toEqual({ gadgets: [], requirements: null });
	});
});

describe("MCP JSON-Schema projection", () => {
	it("projects the blueprint verbs that carry pins and preflight envelopes", () => {
		const blueprints = osWorkspacesContract.blueprints;
		for (const verb of [
			blueprints.preflight,
			blueprints.revise,
			blueprints.instantiate,
			blueprints.instantiateFromGallery,
		]) {
			expect(zodToToolInputJsonSchema(procedureInputSchema(verb)).type).toBe(
				"object",
			);
			expect(
				zodToStructuredOutputJsonSchema(procedureOutputSchema(verb)),
			).not.toBeNull();
		}
	});

	it("projects the workspace shape whose preflight field is a forward reference", () => {
		// `OsWorkspaceSchema.instantiationPreflight` is declared with `z.lazy`
		// because the preflight envelope is defined later in the module; the
		// projection has to survive that.
		const projected = zodToStructuredOutputJsonSchema(OsWorkspaceSchema);
		expect(projected).not.toBeNull();
		expect(
			zodToStructuredOutputJsonSchema(OsBlueprintPreflightSchema),
		).not.toBeNull();
	});

	it("round-trips a fully populated preflight envelope", () => {
		const envelope = {
			blueprintId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
			revision: 2,
			status: "blocked",
			instantiateAllowed: false,
			targetTediId: null,
			requirements: requirements({
				skills: [{ skillId: SKILL_ID, slug: "lead-triage", revision: 3 }],
			}),
			decisions: [
				{
					kind: "skill",
					subject: "skill:lead-triage",
					verdict: "incompatible",
					reason: "pinned at revision 3 but has moved to 5",
					declaredPin: { id: SKILL_ID, revision: 3, digest: null },
					resolvedPin: { id: SKILL_ID, revision: 5, digest: null },
				},
			],
			blockingReasons: ["pinned at revision 3 but has moved to 5"],
			consentReasons: [],
			configurationReasons: [],
			resolvedAt: "2026-08-17T12:00:00.000Z",
		};
		expect(OsBlueprintPreflightSchema.parse(envelope)).toMatchObject({
			status: "blocked",
			instantiateAllowed: false,
		});
	});
});
