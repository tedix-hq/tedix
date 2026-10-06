/**
 * Drizzle Relations v2: cognition domain.
 *
 * Imported directly by the composition root; do not add a barrel.
 */

import { defineRelationsPart } from "drizzle-orm";
import * as schema from "../index";

export const cognitionRelations = defineRelationsPart(schema, (r) => ({
	// COGNITIVE STACK
	// =========================================================================

	knowledgeEntries: {
		organization: r.one.organizations({
			from: r.knowledgeEntries.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.knowledgeEntries.tediId,
			to: r.tedis.id,
		}),
		domain: r.one.memoryDomains({
			from: r.knowledgeEntries.domainId,
			to: r.memoryDomains.id,
		}),
	},

	skillEntries: {
		app: r.one.apps({
			from: r.skillEntries.appId,
			to: r.apps.id,
		}),
		organization: r.one.organizations({
			from: r.skillEntries.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.skillEntries.tediId,
			to: r.tedis.id,
		}),
		domain: r.one.memoryDomains({
			from: r.skillEntries.domainId,
			to: r.memoryDomains.id,
		}),
		muscleMemory: r.many.tediMuscleMemory({
			from: r.skillEntries.id,
			to: r.tediMuscleMemory.sourceSkillId,
		}),
		runs: r.many.skillRuns({
			from: r.skillEntries.id,
			to: r.skillRuns.skillId,
		}),
	},

	skillRuns: {
		skill: r.one.skillEntries({
			from: r.skillRuns.skillId,
			to: r.skillEntries.id,
		}),
		tedi: r.one.tedis({
			from: r.skillRuns.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.skillRuns.organizationId,
			to: r.organizations.id,
		}),
		artifacts: r.many.skillRunArtifacts({
			from: r.skillRuns.id,
			to: r.skillRunArtifacts.runId,
		}),
	},

	skillRunArtifacts: {
		run: r.one.skillRuns({
			from: r.skillRunArtifacts.runId,
			to: r.skillRuns.id,
		}),
	},

	tediMuscleMemory: {
		tedi: r.one.tedis({
			from: r.tediMuscleMemory.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediMuscleMemory.organizationId,
			to: r.organizations.id,
		}),
		sourceSkill: r.one.skillEntries({
			from: r.tediMuscleMemory.sourceSkillId,
			to: r.skillEntries.id,
		}),
	},

	// =========================================================================
	// MEMORY GRAPH
	// =========================================================================

	memoryDomains: {
		organization: r.one.organizations({
			from: r.memoryDomains.organizationId,
			to: r.organizations.id,
		}),
		facts: r.many.memoryFacts({
			from: r.memoryDomains.id,
			to: r.memoryFacts.domainId,
		}),
		knowledgeEntries: r.many.knowledgeEntries({
			from: r.memoryDomains.id,
			to: r.knowledgeEntries.domainId,
		}),
		skillEntries: r.many.skillEntries({
			from: r.memoryDomains.id,
			to: r.skillEntries.domainId,
		}),
		expertise: r.many.tediExpertise({
			from: r.memoryDomains.id,
			to: r.tediExpertise.domainId,
		}),
	},

	memoryFacts: {
		organization: r.one.organizations({
			from: r.memoryFacts.organizationId,
			to: r.organizations.id,
		}),
		tedi: r.one.tedis({
			from: r.memoryFacts.tediId,
			to: r.tedis.id,
		}),
		domain: r.one.memoryDomains({
			from: r.memoryFacts.domainId,
			to: r.memoryDomains.id,
		}),
		sourceEdges: r.many.memoryEdges({
			from: r.memoryFacts.id,
			to: r.memoryEdges.sourceFactId,
			alias: "sourceEdge",
		}),
		targetEdges: r.many.memoryEdges({
			from: r.memoryFacts.id,
			to: r.memoryEdges.targetFactId,
			alias: "targetEdge",
		}),
	},

	memoryEdges: {
		sourceFact: r.one.memoryFacts({
			from: r.memoryEdges.sourceFactId,
			to: r.memoryFacts.id,
			alias: "sourceEdge",
		}),
		targetFact: r.one.memoryFacts({
			from: r.memoryEdges.targetFactId,
			to: r.memoryFacts.id,
			alias: "targetEdge",
		}),
	},

	tediExpertise: {
		tedi: r.one.tedis({
			from: r.tediExpertise.tediId,
			to: r.tedis.id,
		}),
		domain: r.one.memoryDomains({
			from: r.tediExpertise.domainId,
			to: r.memoryDomains.id,
		}),
	},

	tediCuriosityQueue: {
		tedi: r.one.tedis({
			from: r.tediCuriosityQueue.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediCuriosityQueue.organizationId,
			to: r.organizations.id,
		}),
	},

	tediOptimizationSignals: {
		tedi: r.one.tedis({
			from: r.tediOptimizationSignals.tediId,
			to: r.tedis.id,
		}),
		organization: r.one.organizations({
			from: r.tediOptimizationSignals.organizationId,
			to: r.organizations.id,
		}),
	},
}));
