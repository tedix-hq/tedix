import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createEntrustableActivity } from "./earned-delegation/activities";
import { attestCompetencyObservation } from "./earned-delegation/attestations";
import { EarnedDelegationError } from "./earned-delegation/authority-policy";
import { certifyCompetencyObservation } from "./earned-delegation/certification";
import { decidePromotionProposal } from "./earned-delegation/decision-settlement";
import {
	getActiveDelegationEntrustmentProjections,
	getDelegationProfile,
} from "./earned-delegation/entrustments";
import { recordCompetencyObservation } from "./earned-delegation/observations";
import { createPromotionProposal } from "./earned-delegation/promotion-proposals";
import { assignInitialRoleTrack } from "./earned-delegation/role-assignments";

const ORG = "00000000-0000-4000-8000-000000000001";
const TEDI = "00000000-0000-4000-8000-000000000002";
const NOW = "2026-07-20T00:00:00.000Z";
const LATER = "2026-07-21T00:00:00.000Z";

const DDL = `
CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
CREATE TABLE harness_eval_runs (
 id TEXT PRIMARY KEY, harness_version_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
 org_id TEXT, lane TEXT NOT NULL, task_set_id TEXT NOT NULL,
 total INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL,
 mean_score REAL NOT NULL, eligible INTEGER NOT NULL, report TEXT, metadata TEXT,
 created_at TEXT NOT NULL
);
CREATE TABLE tedi_role_assignments (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
 role_template_id TEXT, role_key TEXT NOT NULL, role_name TEXT NOT NULL,
 status TEXT NOT NULL, career_stage TEXT NOT NULL, assigned_at TEXT NOT NULL,
 stage_changed_at TEXT NOT NULL, ended_at TEXT, revision INTEGER NOT NULL,
 last_decision_id TEXT, evidence_snapshot_hash TEXT, metadata TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_tedi_role_assignment_active
 ON tedi_role_assignments (organization_id, tedi_id) WHERE status = 'active';
CREATE TABLE entrustable_activities (
 id TEXT PRIMARY KEY, organization_id TEXT, key TEXT NOT NULL, version INTEGER NOT NULL,
 supersedes_id TEXT, role_template_id TEXT, name TEXT NOT NULL, description TEXT,
 status TEXT NOT NULL, task_family TEXT NOT NULL, risk_level TEXT NOT NULL,
 maximum_level TEXT NOT NULL, action_patterns TEXT NOT NULL, tool_ids TEXT NOT NULL,
 rubric TEXT NOT NULL, rubric_hash TEXT NOT NULL, evidence_policy TEXT NOT NULL,
 evidence_policy_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_activity_org_version
 ON entrustable_activities (organization_id, key, version);
CREATE UNIQUE INDEX uniq_activity_org_head
 ON entrustable_activities (organization_id, key) WHERE status = 'active';
CREATE TABLE competency_observations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
 executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, activity_id TEXT NOT NULL,
 client_observation_id TEXT NOT NULL, input_hash TEXT NOT NULL,
 execution_opportunity_id TEXT NOT NULL, work_item_id TEXT, source_kind TEXT NOT NULL,
 source_id TEXT NOT NULL, trace_bundle_id TEXT, rationale_id TEXT,
 task_family TEXT NOT NULL, risk_level TEXT NOT NULL, environment TEXT NOT NULL,
 rubric_version INTEGER NOT NULL, harness TEXT NOT NULL, harness_version TEXT NOT NULL,
 model_provider TEXT NOT NULL, model_id TEXT NOT NULL, model_version TEXT NOT NULL,
 outcome TEXT NOT NULL, complexity REAL NOT NULL, non_trivial INTEGER NOT NULL,
 held_out INTEGER NOT NULL, calibration_score REAL NOT NULL,
 escalation_quality REAL NOT NULL, learning_transfer INTEGER NOT NULL,
 evidence_refs TEXT NOT NULL, eligibility_status TEXT NOT NULL,
 evaluator_type TEXT, evaluator_id TEXT,
 classification_method TEXT NOT NULL, evaluation_run_id TEXT, proof_verified_at TEXT,
 cost_minor_units INTEGER, cost_currency TEXT, duration_ms INTEGER,
 owner_review_minutes REAL, policy_violation_severity INTEGER NOT NULL,
 confidence REAL NOT NULL, metadata TEXT, occurred_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_observation_client
 ON competency_observations (organization_id, client_observation_id);
CREATE UNIQUE INDEX uniq_observation_episode
 ON competency_observations
 (organization_id, tedi_id, execution_opportunity_id, activity_id, rubric_version, harness_version);
CREATE TABLE delegation_value_claims (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
 observation_id TEXT NOT NULL, work_item_id TEXT NOT NULL,
 evaluation_run_id TEXT NOT NULL, executor_type TEXT NOT NULL,
 executor_id TEXT NOT NULL, value_event_id TEXT NOT NULL,
 value_evidence_ref TEXT NOT NULL, value_minor_units INTEGER NOT NULL,
 currency TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_delegation_value_claim_observation
 ON delegation_value_claims (organization_id, observation_id);
CREATE UNIQUE INDEX uniq_delegation_value_claim_event
 ON delegation_value_claims (organization_id, value_event_id);
CREATE UNIQUE INDEX uniq_delegation_value_claim_evidence
 ON delegation_value_claims (organization_id, value_evidence_ref);
CREATE TABLE work_items (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
 disposition TEXT NOT NULL DEFAULT 'proposed', work_kind TEXT NOT NULL DEFAULT 'other', risk_level TEXT NOT NULL DEFAULT 'medium', acceptance_contract TEXT,
 required_capabilities TEXT NOT NULL DEFAULT '[]', required_authorities TEXT NOT NULL DEFAULT '[]', admission_spec_revision TEXT NOT NULL DEFAULT 'test-revision',
 priority TEXT NOT NULL DEFAULT 'medium', accountable_owner_type TEXT, accountable_owner_id TEXT, steward_type TEXT, steward_id TEXT, reviewer_type TEXT, reviewer_id TEXT,
 objective_id TEXT, work_class TEXT, purpose_exception_expires_at TEXT, project_id TEXT, parent_work_item_id TEXT, source_session_key TEXT, source_intent_id TEXT, due_date TEXT, deadline TEXT, start_at TEXT, duration_days INTEGER,
 provenance TEXT DEFAULT '{}', metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT, accepted_at TEXT, completed_at TEXT, cancelled_at TEXT, version INTEGER NOT NULL DEFAULT 1, UNIQUE (org_id, id)
);
CREATE TABLE work_attempts (id TEXT PRIMARY KEY, admission_id TEXT, work_item_id TEXT NOT NULL, org_id TEXT NOT NULL, executor_type TEXT NOT NULL, executor_id TEXT NOT NULL, executor_session_id TEXT, external_session_key TEXT, run_id TEXT, runtime_state TEXT NOT NULL DEFAULT 'running', outcome TEXT, attempt_number INTEGER NOT NULL DEFAULT 1, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, expires_at TEXT, finished_at TEXT, summary TEXT, version INTEGER NOT NULL DEFAULT 1, metadata TEXT NOT NULL DEFAULT '{}');

CREATE TABLE competency_observation_attestations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, observation_id TEXT NOT NULL,
 principal_type TEXT NOT NULL, principal_id TEXT NOT NULL, verdict TEXT NOT NULL,
 verification_method TEXT NOT NULL, independence_verified INTEGER NOT NULL,
 authenticated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_attestation_principal
 ON competency_observation_attestations (observation_id, principal_type, principal_id);
CREATE TABLE earned_delegation_evidence_revisions (
 organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL, revision INTEGER NOT NULL,
 updated_at TEXT NOT NULL, PRIMARY KEY (organization_id, tedi_id)
);
CREATE TABLE promotion_decisions (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, client_proposal_id TEXT NOT NULL,
 input_hash TEXT NOT NULL, tedi_id TEXT NOT NULL, role_assignment_id TEXT, activity_id TEXT,
 kind TEXT NOT NULL, status TEXT NOT NULL, from_career_stage TEXT, to_career_stage TEXT,
 from_entrustment_level TEXT, from_entrustment_status TEXT, to_entrustment_level TEXT,
 target_role_template_id TEXT, target_role_key TEXT, target_role_name TEXT,
 target_scope TEXT, target_expires_at TEXT, target_next_review_at TEXT,
 expected_role_revision INTEGER, expected_entrustment_revision INTEGER,
 evidence_observation_ids TEXT NOT NULL, evidence_refs TEXT NOT NULL,
 evidence_snapshot TEXT NOT NULL, proposed_by_type TEXT NOT NULL, proposed_by_id TEXT NOT NULL,
 decided_by_type TEXT, decided_by_id TEXT, reason TEXT, created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL, proposal_expires_at TEXT NOT NULL, decided_at TEXT, applied_at TEXT
);
CREATE UNIQUE INDEX uniq_decision_client
 ON promotion_decisions (organization_id, client_proposal_id);
CREATE TABLE promotion_decision_observations (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, decision_id TEXT NOT NULL,
 observation_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_decision_observation
 ON promotion_decision_observations (decision_id, observation_id);
CREATE TABLE tedi_entrustment_grants (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT NOT NULL,
 role_assignment_id TEXT, activity_id TEXT NOT NULL, level TEXT NOT NULL,
 status TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL,
 last_certified_at TEXT, expires_at TEXT, next_review_at TEXT NOT NULL,
 restricted_at TEXT, reason TEXT, last_decision_id TEXT NOT NULL,
 activity_version INTEGER NOT NULL, rubric_hash TEXT NOT NULL,
 evidence_policy_hash TEXT NOT NULL, evidence_snapshot_hash TEXT NOT NULL,
 granted_by_type TEXT NOT NULL, granted_by_id TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX uniq_grant_activity
 ON tedi_entrustment_grants (tedi_id, activity_id);
`;

function insertCanonicalEvalRun(
	sqlite: DatabaseSync,
	input: {
		id: string;
		taskSetId: string;
		activityId: string;
		activityVersion: number;
		rubricHash: string;
		recorderType?: "user" | "api_key" | "service";
		recorderId?: string;
		environment?: string;
		createdAt?: string;
		economic?: Partial<{
			costMinorUnits: number;
			costCurrency: string;
			ownerReviewMinutes: number;
			verifiedValueMinorUnits: number;
			verifiedValueCurrency: string;
			verifiedValueEventId: string;
			verifiedValueEvidenceRef: string;
		}>;
	},
) {
	sqlite
		.prepare(`
			INSERT INTO harness_eval_runs (
				id, harness_version_id, tedi_id, org_id, lane, task_set_id,
				total, passed, failed, mean_score, eligible, metadata, created_at
			) VALUES (?, 'harness-v1', ?, ?, 'locked-test', ?, 1, 1, 0, 0.9, 1, ?, ?)
		`)
		.run(
			input.id,
			TEDI,
			ORG,
			input.taskSetId,
			JSON.stringify({
				nonTrivial: true,
				complexity: 0.8,
				calibrationScore: 0.9,
				escalationQuality: 0.9,
				learningTransfer: true,
				confidence: 0.9,
				environment: input.environment ?? "production",
				modelProvider: "openai",
				modelId: "gpt",
				modelVersion: "1",
				policyViolationSeverity: 0,
				recordedByPrincipalType: input.recorderType ?? "api_key",
				recordedByPrincipalId: input.recorderId ?? "evaluator-key-1",
				trustedForEarnedDelegation: true,
				earnedDelegationActivityId: input.activityId,
				earnedDelegationActivityVersion: input.activityVersion,
				earnedDelegationRubricHash: input.rubricHash,
				...input.economic,
			}),
			input.createdAt ?? NOW,
		);
}

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(DDL);
	sqlite
		.prepare("INSERT INTO tedis (id, organization_id) VALUES (?, ?)")
		.run(TEDI, ORG);
	const db = createDbClient(createD1Facade(sqlite));
	const role = await assignInitialRoleTrack(db, {
		organizationId: ORG,
		tediId: TEDI,
		roleKey: "cto",
		roleName: "Chief Technology Officer",
		now: NOW,
	});
	const activity = await createEntrustableActivity(db, {
		organizationId: ORG,
		key: "engineering.delivery",
		version: 1,
		name: "Engineering delivery",
		taskFamily: "engineering",
		riskLevel: "medium",
		maximumLevel: "autonomous",
		actionPatterns: ["code.change"],
		toolIds: ["repo_commit"],
		rubric: { version: 1 },
		evidencePolicy: {
			minimumVerifiedObservations: 5,
			minimumDistinctVerifierPrincipals: 2,
			maximumFailureRate: 0.2,
			maximumPolicyViolationSeverity: 0,
			maximumEvidenceAgeDays: 90,
			requireNonTrivialWork: true,
			minimumReliabilityLowerBound: 0.5,
			minimumMeanComplexity: 0.25,
			minimumTaskFamilies: 2,
			minimumCalibrationScore: 0.7,
			minimumEscalationQuality: 0.7,
			requireLearningTransfer: false,
		},
		now: NOW,
	});
	const reviewActivity = await createEntrustableActivity(db, {
		organizationId: ORG,
		key: "engineering.review",
		version: 1,
		name: "Engineering review",
		taskFamily: "review",
		riskLevel: "medium",
		maximumLevel: "autonomous",
		actionPatterns: ["code.review"],
		toolIds: ["repo_read"],
		rubric: { version: 1 },
		evidencePolicy: activity.evidencePolicy,
		now: NOW,
	});
	for (let index = 1; index <= 5; index += 1) {
		const observedActivity = index % 2 === 0 ? reviewActivity : activity;
		insertCanonicalEvalRun(sqlite, {
			id: `eval-${index}`,
			taskSetId: `task-set-${index}`,
			activityId: observedActivity.id,
			activityVersion: observedActivity.version,
			rubricHash: observedActivity.rubricHash,
			createdAt: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
		});
		const observation = await recordCompetencyObservation(db, {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi",
			executorId: TEDI,
			evaluatorType: "api_key",
			evaluatorId: "evaluator-key-1",
			activityId: observedActivity.id,
			clientObservationId: `observation-${index}`,
			executionOpportunityId: `episode-${index}`,
			sourceKind: "held_out_eval",
			sourceId: `eval-${index}`,
			environment: "production",
			harness: "certifier",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success",
			complexity: 0.8,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 0.9,
			escalationQuality: 0.9,
			learningTransfer: true,
			evidenceRefs: [`artifact://eval/${index}`],
			classificationMethod: "server-rubric",
			evaluationRunId: `eval-${index}`,
			proofVerifiedAt: NOW,
			confidence: 0.9,
			occurredAt: `2026-07-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
			now: NOW,
		});
		for (const reviewer of ["reviewer-1", "reviewer-2"]) {
			await attestCompetencyObservation(db, {
				organizationId: ORG,
				observationId: observation.id,
				principalType: "user",
				principalId: reviewer,
				verdict: "supports",
				verificationMethod: "independent-review",
				authenticatedAt: NOW,
				now: NOW,
			});
		}
	}
	return { activity, db, reviewActivity, role, sqlite };
}

function insertRoleBoundGrant(
	sqlite: DatabaseSync,
	input: { activityId: string; roleAssignmentId: string },
) {
	sqlite
		.prepare(`
			INSERT INTO tedi_entrustment_grants (
				id, organization_id, tedi_id, role_assignment_id, activity_id,
				level, status, scope, revision, last_certified_at, expires_at,
				next_review_at, restricted_at, reason, last_decision_id,
				activity_version, rubric_hash, evidence_policy_hash,
				evidence_snapshot_hash, granted_by_type, granted_by_id,
				created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, 'autonomous', 'active', ?, 1, ?, ?, ?, NULL,
				NULL, ?, 1, 'rubric-hash', 'policy-hash', 'snapshot-hash',
				'user', 'owner-1', ?, ?)
		`)
		.run(
			"grant-1",
			ORG,
			TEDI,
			input.roleAssignmentId,
			input.activityId,
			JSON.stringify({
				actions: ["code.change"],
				toolIds: ["repo_commit"],
				environments: ["production"],
				spendPermission: "none",
				budgetPolicyId: null,
				constraints: {},
			}),
			NOW,
			"2026-08-20T00:00:00.000Z",
			"2026-08-01T00:00:00.000Z",
			"00000000-0000-4000-8000-000000000099",
			NOW,
			NOW,
		);
}

function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
		.join(",")}}`;
}

function snapshotHash(value: unknown): string {
	return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function simulateCrashAfterApprovalLatch(
	sqlite: DatabaseSync,
	decisionId: string,
) {
	sqlite
		.prepare(`
			UPDATE promotion_decisions
			SET status = 'approved', decided_by_type = 'user',
				decided_by_id = 'owner-1', decided_at = ?, updated_at = ?
			WHERE id = ? AND status = 'proposed'
		`)
		.run("2026-07-20T00:30:00.000Z", "2026-07-20T00:30:00.000Z", decisionId);
}

async function createSingleObservationActivity(
	db: Awaited<ReturnType<typeof fixture>>["db"],
	sqlite: DatabaseSync,
	key: string,
) {
	const activity = await createEntrustableActivity(db, {
		organizationId: ORG,
		key,
		version: 1,
		name: "Production authority",
		taskFamily: "engineering",
		riskLevel: "high",
		maximumLevel: "autonomous",
		actionPatterns: ["release.deploy"],
		toolIds: ["deploy_production"],
		rubric: { version: 1 },
		evidencePolicy: {
			minimumVerifiedObservations: 1,
			minimumDistinctVerifierPrincipals: 1,
			maximumFailureRate: 0,
			maximumPolicyViolationSeverity: 0,
			maximumEvidenceAgeDays: 90,
			requireNonTrivialWork: true,
			minimumReliabilityLowerBound: 0,
			minimumMeanComplexity: 0,
			minimumTaskFamilies: 1,
			minimumCalibrationScore: 0,
			minimumEscalationQuality: 0,
			requireLearningTransfer: false,
		},
		now: NOW,
	});
	insertCanonicalEvalRun(sqlite, {
		id: `${key}-eval`,
		taskSetId: `${key}-task-set`,
		activityId: activity.id,
		activityVersion: activity.version,
		rubricHash: activity.rubricHash,
		createdAt: "2026-07-19T00:00:00.000Z",
	});
	const observation = await recordCompetencyObservation(db, {
		organizationId: ORG,
		tediId: TEDI,
		executorType: "tedi",
		executorId: TEDI,
		evaluatorType: "api_key",
		evaluatorId: "evaluator-key-1",
		activityId: activity.id,
		clientObservationId: `${key}-observation`,
		executionOpportunityId: `${key}-opportunity`,
		sourceKind: "held_out_eval",
		sourceId: `${key}-eval`,
		environment: "production",
		harness: "certifier",
		harnessVersion: "1",
		modelProvider: "openai",
		modelId: "gpt",
		modelVersion: "1",
		outcome: "success",
		complexity: 0.8,
		nonTrivial: true,
		heldOut: true,
		calibrationScore: 0.9,
		escalationQuality: 0.9,
		learningTransfer: false,
		evidenceRefs: [`artifact://${key}/eval`],
		classificationMethod: "server-rubric",
		evaluationRunId: `${key}-eval`,
		proofVerifiedAt: NOW,
		confidence: 0.9,
		occurredAt: "2026-07-19T00:00:00.000Z",
		now: NOW,
	});
	await attestCompetencyObservation(db, {
		organizationId: ORG,
		observationId: observation.id,
		principalType: "user",
		principalId: "reviewer-1",
		verdict: "supports",
		verificationMethod: "independent-review",
		authenticatedAt: NOW,
		now: NOW,
	});
	return { activity, observation };
}

describe("earned delegation D1 settlement", () => {
	it("loads active entrustments through relation filters with D1-safe aliases", async () => {
		const { activity, db, role, sqlite } = await fixture();
		sqlite
			.prepare(`
				INSERT INTO promotion_decisions (
					id, organization_id, client_proposal_id, input_hash, tedi_id,
					kind, status, evidence_observation_ids, evidence_refs,
					evidence_snapshot, proposed_by_type, proposed_by_id,
					created_at, updated_at, proposal_expires_at
				) VALUES (?, ?, 'active-grant', 'hash', ?, 'grant', 'applied',
					'[]', '[]', '{}', 'user', 'owner-1', ?, ?, ?)
			`)
			.run("00000000-0000-4000-8000-000000000099", ORG, TEDI, NOW, NOW, LATER);
		insertRoleBoundGrant(sqlite, {
			activityId: activity.id,
			roleAssignmentId: role.id,
		});

		await expect(
			getActiveDelegationEntrustmentProjections(db, {
				organizationId: ORG,
				tediIds: [TEDI],
				now: NOW,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				grantId: "grant-1",
				activityId: activity.id,
				tediId: TEDI,
				taskFamily: activity.taskFamily,
				actionPatterns: activity.actionPatterns,
				activityToolIds: activity.toolIds,
			}),
		]);

		sqlite
			.prepare("UPDATE tedi_role_assignments SET status = 'ended' WHERE id = ?")
			.run(role.id);
		await expect(
			getActiveDelegationEntrustmentProjections(db, {
				organizationId: ORG,
				tediIds: [TEDI],
				now: NOW,
			}),
		).resolves.toEqual([]);
	});

	it("binds economic value to the proof-certified tedi executor and one org-wide event", async () => {
		const { activity, db, sqlite } = await fixture();
		const economic = {
			costMinorUnits: 100,
			costCurrency: "USD",
			ownerReviewMinutes: 30,
			verifiedValueMinorUnits: 12_000,
			verifiedValueCurrency: "USD",
			verifiedValueEventId: "invoice-2026-001",
			verifiedValueEvidenceRef: "ledger://invoice-2026-001",
		};
		const insertWork = sqlite.prepare(
			"INSERT INTO work_items (id, org_id, title, disposition, metadata, created_at, completed_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)",
		);
		insertWork.run(
			"work-economic-1",
			ORG,
			"Economic work 1",
			JSON.stringify({ proof: "artifact://work-1", proofCertifiedAt: NOW }),
			NOW,
			NOW,
		);
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id, work_item_id, org_id, executor_type, executor_id, executor_session_id, runtime_state, outcome, attempt_number, started_at, heartbeat_at, finished_at, metadata) VALUES ('checkout-external', 'work-economic-1', ?, 'external_agent', 'codex', 'session-1', 'finished', 'succeeded', 1, ?, ?, ?, '{}')",
			)
			.run(ORG, NOW, NOW, NOW);
		insertCanonicalEvalRun(sqlite, {
			id: "economic-eval-1",
			taskSetId: "economic-task-set-1",
			activityId: activity.id,
			activityVersion: activity.version,
			rubricHash: activity.rubricHash,
			economic,
		});
		const observationInput = {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi" as const,
			executorId: TEDI,
			evaluatorType: "api_key" as const,
			evaluatorId: "evaluator-key-1",
			activityId: activity.id,
			clientObservationId: "economic-observation-1",
			executionOpportunityId: "caller-economic-opportunity",
			workItemId: "work-economic-1",
			sourceKind: "caller-claim",
			sourceId: "economic-eval-1",
			environment: "production",
			harness: "caller-harness",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success" as const,
			complexity: 1,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 1,
			escalationQuality: 1,
			learningTransfer: true,
			evidenceRefs: ["artifact://caller-claim"],
			classificationMethod: "self-declared",
			evaluationRunId: "economic-eval-1",
			confidence: 1,
			occurredAt: NOW,
			now: NOW,
		};
		await expect(
			recordCompetencyObservation(db, observationInput),
		).rejects.toMatchObject({
			reason: "ineligible",
		});

		sqlite
			.prepare("DELETE FROM work_attempts WHERE id = 'checkout-external'")
			.run();
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id, work_item_id, org_id, executor_type, executor_id, runtime_state, outcome, attempt_number, started_at, heartbeat_at, finished_at, metadata) VALUES ('checkout-tedi', 'work-economic-1', ?, 'tedi', ?, 'finished', 'succeeded', 1, ?, ?, ?, '{}')",
			)
			.run(ORG, TEDI, NOW, NOW, NOW);
		const observation = await recordCompetencyObservation(db, observationInput);
		for (const reviewer of ["value-reviewer-1", "value-reviewer-2"]) {
			await attestCompetencyObservation(db, {
				organizationId: ORG,
				observationId: observation.id,
				principalType: "user",
				principalId: reviewer,
				verdict: "supports",
				verificationMethod: "accounting-and-work-review",
				authenticatedAt: NOW,
				now: NOW,
			});
		}
		expect(
			sqlite
				.prepare(
					"SELECT executor_type, executor_id FROM delegation_value_claims",
				)
				.get(),
		).toMatchObject({ executor_type: "tedi", executor_id: TEDI });
		const profile = await getDelegationProfile(db, {
			organizationId: ORG,
			tediId: TEDI,
			now: NOW,
		});
		expect(profile.delegationYield).toMatchObject({
			measurementStatus: "measured",
			issuedOpportunities: 1,
			valueCertifiedOpportunities: 1,
			ownerReviewMinutes: 30,
		});
		expect(profile.delegationYield.valueByCurrency[0]).toMatchObject({
			verifiedValueMinorUnits: 12_000,
			valuePerOwnerReviewHourMinorUnits: 24_000,
		});

		// A proof-certified opportunity with review time and cost but no value
		// claim must remain in the denominator. Otherwise selectively recording
		// only successful claims could manufacture a measured positive rate.
		insertWork.run(
			"work-unvalued",
			ORG,
			"Unvalued work",
			JSON.stringify({
				proof: "artifact://work-unvalued",
				proofCertifiedAt: NOW,
			}),
			NOW,
			NOW,
		);
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id, work_item_id, org_id, executor_type, executor_id, runtime_state, outcome, attempt_number, started_at, heartbeat_at, finished_at, metadata) VALUES ('checkout-tedi-unvalued', 'work-unvalued', ?, 'tedi', ?, 'finished', 'succeeded', 1, ?, ?, ?, '{}')",
			)
			.run(ORG, TEDI, NOW, NOW, NOW);
		insertCanonicalEvalRun(sqlite, {
			id: "unvalued-eval",
			taskSetId: "unvalued-task-set",
			activityId: activity.id,
			activityVersion: activity.version,
			rubricHash: activity.rubricHash,
			economic: {
				costMinorUnits: 300,
				costCurrency: "USD",
				ownerReviewMinutes: 15,
			},
		});
		const unvaluedObservation = await recordCompetencyObservation(db, {
			...observationInput,
			clientObservationId: "unvalued-observation",
			workItemId: "work-unvalued",
			sourceId: "unvalued-eval",
			evaluationRunId: "unvalued-eval",
		});
		for (const reviewer of ["unvalued-reviewer-1", "unvalued-reviewer-2"]) {
			await attestCompetencyObservation(db, {
				organizationId: ORG,
				observationId: unvaluedObservation.id,
				principalType: "user",
				principalId: reviewer,
				verdict: "supports",
				verificationMethod: "accounting-and-work-review",
				authenticatedAt: NOW,
				now: NOW,
			});
		}
		const partialProfile = await getDelegationProfile(db, {
			organizationId: ORG,
			tediId: TEDI,
			now: NOW,
		});
		expect(partialProfile.delegationYield).toMatchObject({
			measurementStatus: "partial",
			issuedOpportunities: 2,
			reviewedOpportunities: 2,
			valueCertifiedOpportunities: 1,
			ownerReviewMinutes: 45,
		});
		expect(partialProfile.delegationYield.costByCurrency).toContainEqual({
			currency: "USD",
			costMinorUnits: 400,
		});
		expect(
			partialProfile.delegationYield.valueByCurrency[0]
				?.valuePerOwnerReviewHourMinorUnits,
		).toBeNull();

		insertWork.run(
			"work-economic-2",
			ORG,
			"Economic work 2",
			JSON.stringify({ proof: "artifact://work-2", proofCertifiedAt: NOW }),
			NOW,
			NOW,
		);
		sqlite
			.prepare(
				"INSERT INTO work_attempts (id, work_item_id, org_id, executor_type, executor_id, runtime_state, outcome, attempt_number, started_at, heartbeat_at, finished_at, metadata) VALUES ('checkout-tedi-2', 'work-economic-2', ?, 'tedi', ?, 'finished', 'succeeded', 1, ?, ?, ?, '{}')",
			)
			.run(ORG, TEDI, NOW, NOW, NOW);
		insertCanonicalEvalRun(sqlite, {
			id: "economic-eval-2",
			taskSetId: "economic-task-set-2",
			activityId: activity.id,
			activityVersion: activity.version,
			rubricHash: activity.rubricHash,
			economic,
		});
		await expect(
			recordCompetencyObservation(db, {
				...observationInput,
				clientObservationId: "economic-observation-2",
				workItemId: "work-economic-2",
				sourceId: "economic-eval-2",
				evaluationRunId: "economic-eval-2",
			}),
		).rejects.toMatchObject({ reason: "conflict" });
	});

	it("rejects observations without a canonical evaluation run for the scoped tedi", async () => {
		const { activity, db } = await fixture();
		await expect(
			recordCompetencyObservation(db, {
				organizationId: ORG,
				tediId: TEDI,
				executorType: "tedi",
				executorId: TEDI,
				evaluatorType: "api_key",
				evaluatorId: "evaluator-key-1",
				activityId: activity.id,
				clientObservationId: "missing-canonical-evaluation",
				executionOpportunityId: "caller-claimed-opportunity",
				sourceKind: "caller_claim",
				sourceId: "missing-eval",
				environment: "production",
				harness: "caller-harness",
				harnessVersion: "1",
				modelProvider: "openai",
				modelId: "gpt",
				modelVersion: "1",
				outcome: "success",
				complexity: 1,
				nonTrivial: true,
				heldOut: true,
				calibrationScore: 1,
				escalationQuality: 1,
				learningTransfer: true,
				evidenceRefs: ["artifact://caller-claim"],
				classificationMethod: "self-declared",
				evaluationRunId: "missing-eval",
				proofVerifiedAt: NOW,
				confidence: 1,
				occurredAt: NOW,
				now: NOW,
			}),
		).rejects.toMatchObject({
			reason: "out_of_scope",
		});
	});

	it("rejects self-recorded runs and reuse across unrelated activity rubrics", async () => {
		const { activity, db, reviewActivity, sqlite } = await fixture();
		const baseInput = {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi" as const,
			executorId: TEDI,
			evaluatorType: "api_key" as const,
			evaluatorId: "evaluator-key-1",
			executionOpportunityId: "caller-claimed-opportunity",
			sourceKind: "caller_claim",
			sourceId: "eval-1",
			environment: "production",
			harness: "caller-harness",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success" as const,
			complexity: 1,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 1,
			escalationQuality: 1,
			learningTransfer: true,
			evidenceRefs: ["artifact://caller-claim"],
			classificationMethod: "self-declared",
			evaluationRunId: "eval-1",
			proofVerifiedAt: NOW,
			confidence: 1,
			occurredAt: NOW,
			now: NOW,
		};
		await expect(
			recordCompetencyObservation(db, {
				...baseInput,
				activityId: reviewActivity.id,
				clientObservationId: "cross-activity-reuse",
			}),
		).rejects.toMatchObject({ reason: "out_of_scope" });

		const row = sqlite
			.prepare("SELECT metadata FROM harness_eval_runs WHERE id = 'eval-1'")
			.get() as { metadata: string };
		const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
		sqlite
			.prepare("UPDATE harness_eval_runs SET metadata = ? WHERE id = 'eval-1'")
			.run(
				JSON.stringify({
					...metadata,
					recordedByPrincipalType: "tedi",
					recordedByPrincipalId: TEDI,
					trustedForEarnedDelegation: false,
				}),
			);
		await expect(
			recordCompetencyObservation(db, {
				...baseInput,
				activityId: activity.id,
				clientObservationId: "self-recorded-run",
			}),
		).rejects.toMatchObject({ reason: "invalid_transition" });
	});

	it("treats the canonical run recorder, not its API-key registrar, as the evaluator", async () => {
		const { activity, db, sqlite } = await fixture();
		insertCanonicalEvalRun(sqlite, {
			id: "user-recorded-eval",
			taskSetId: "user-recorded-task-set",
			activityId: activity.id,
			activityVersion: activity.version,
			rubricHash: activity.rubricHash,
			recorderType: "user",
			recorderId: "source-author",
		});
		const observation = await recordCompetencyObservation(db, {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi",
			executorId: TEDI,
			evaluatorType: "api_key",
			evaluatorId: "registrar-key",
			activityId: activity.id,
			clientObservationId: "user-recorded-observation",
			executionOpportunityId: "caller-opportunity",
			sourceKind: "caller-source",
			sourceId: "caller-source-id",
			environment: "production",
			harness: "caller-harness",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success",
			complexity: 1,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 1,
			escalationQuality: 1,
			learningTransfer: true,
			evidenceRefs: ["artifact://caller"],
			classificationMethod: "caller",
			evaluationRunId: "user-recorded-eval",
			confidence: 1,
			occurredAt: NOW,
			now: NOW,
		});
		expect(observation).toMatchObject({
			evaluatorType: "user",
			evaluatorId: "source-author",
		});
		const sourceAuthorAttestation = await attestCompetencyObservation(db, {
			organizationId: ORG,
			observationId: observation.id,
			principalType: "user",
			principalId: "source-author",
			verdict: "supports",
			verificationMethod: "source-self-review",
			authenticatedAt: NOW,
			now: NOW,
		});
		expect(sourceAuthorAttestation?.independenceVerified).toBe(false);
	});

	it("certifies only the canonical harness plus proof-gated Work Item pair", async () => {
		const { activity, db, sqlite } = await fixture();
		const observation = sqlite
			.prepare(
				"SELECT id FROM competency_observations WHERE client_observation_id = 'observation-1'",
			)
			.get() as { id: string };
		const childRunId = "tedi-child-run-1";
		sqlite
			.prepare(
				"INSERT INTO work_items (id, org_id, title, disposition, metadata, created_at, completed_at) VALUES (?, ?, 'Proof work', 'completed', ?, ?, ?)",
			)
			.run(
				"work-proof-1",
				ORG,
				JSON.stringify({
					delegatedTediId: TEDI,
					childRunId,
					proof: `child-run:${childRunId}`,
					proofCertifiedAt: NOW,
					hasProof: true,
					evidenceState: "verified",
					childRunStatus: "completed",
					earnedDelegationPilot: {
						activityId: activity.id,
						activityVersion: activity.version,
						heldOut: true,
						environment: "production",
					},
				}),
				NOW,
				NOW,
			);
		sqlite
			.prepare(
				"UPDATE competency_observations SET work_item_id = 'work-proof-1' WHERE id = ?",
			)
			.run(observation.id);

		const result = await certifyCompetencyObservation(db, {
			organizationId: ORG,
			observationId: observation.id,
			now: NOW,
		});
		expect(result.checks).toEqual({
			canonicalHarnessEvidence: true,
			proofGatedWorkItem: true,
		});
		expect(result.attestation).toMatchObject({
			principalType: "certification_service",
			principalId: "earned-delegation-proof-certifier:v1",
			verdict: "supports",
			independenceVerified: true,
		});
	});

	it("records a rejecting certification when terminal Work Item proof is incomplete", async () => {
		const { activity, db, sqlite } = await fixture();
		const observation = sqlite
			.prepare(
				"SELECT id FROM competency_observations WHERE client_observation_id = 'observation-1'",
			)
			.get() as { id: string };
		sqlite
			.prepare(
				"INSERT INTO work_items (id, org_id, title, disposition, metadata, created_at, completed_at) VALUES (?, ?, 'Incomplete proof work', 'completed', ?, ?, ?)",
			)
			.run(
				"work-incomplete-proof",
				ORG,
				JSON.stringify({
					delegatedTediId: TEDI,
					childRunId: "child-without-certified-proof",
					hasProof: false,
					evidenceState: "unverified",
					childRunStatus: "completed",
					earnedDelegationPilot: {
						activityId: activity.id,
						activityVersion: activity.version,
						heldOut: true,
						environment: "production",
					},
				}),
				NOW,
				NOW,
			);
		sqlite
			.prepare(
				"UPDATE competency_observations SET work_item_id = 'work-incomplete-proof' WHERE id = ?",
			)
			.run(observation.id);

		const result = await certifyCompetencyObservation(db, {
			organizationId: ORG,
			observationId: observation.id,
			now: NOW,
		});
		expect(result.checks).toEqual({
			canonicalHarnessEvidence: true,
			proofGatedWorkItem: false,
		});
		expect(result.attestation).toMatchObject({
			principalType: "certification_service",
			verdict: "rejects",
			independenceVerified: true,
		});
	});

	it("derives opportunity identity server-side and rejects evaluator self-attestation as independent", async () => {
		const { activity, db, sqlite } = await fixture();
		const existing = sqlite
			.prepare(
				"SELECT id, execution_opportunity_id, source_kind, source_id, outcome, complexity, held_out, classification_method FROM competency_observations WHERE client_observation_id = 'observation-1'",
			)
			.get() as {
			id: string;
			execution_opportunity_id: string;
			source_kind: string;
			source_id: string;
			outcome: string;
			complexity: number;
			held_out: number;
			classification_method: string;
		};
		expect(existing.execution_opportunity_id).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(existing.execution_opportunity_id).not.toBe("episode-1");
		expect(existing).toMatchObject({
			source_kind: "harness_eval_run",
			source_id: "eval-1",
			outcome: "success",
			complexity: 0.8,
			held_out: 1,
			classification_method: "canonical_harness_eval_run:locked-test",
		});

		const replay = await recordCompetencyObservation(db, {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi",
			executorId: TEDI,
			evaluatorType: "api_key",
			evaluatorId: "evaluator-key-1",
			activityId: activity.id,
			clientObservationId: "observation-1",
			executionOpportunityId: "forged-new-client-opportunity",
			sourceKind: "forged-source-kind",
			sourceId: "forged-source-id",
			environment: "forged-environment",
			harness: "forged-harness",
			harnessVersion: "forged-version",
			modelProvider: "forged-provider",
			modelId: "forged-model",
			modelVersion: "forged-model-version",
			outcome: "failure",
			complexity: 0,
			nonTrivial: false,
			heldOut: false,
			calibrationScore: 0,
			escalationQuality: 0,
			learningTransfer: false,
			evidenceRefs: [],
			classificationMethod: "self-declared",
			evaluationRunId: "eval-1",
			confidence: 0,
			occurredAt: "2026-07-25T00:00:00.000Z",
			now: NOW,
		});
		expect(replay.id).toBe(existing.id);

		const selfAttestation = await attestCompetencyObservation(db, {
			organizationId: ORG,
			observationId: existing.id,
			principalType: "api_key",
			principalId: `organization:${ORG}`,
			verdict: "supports",
			verificationMethod: "self-review-attempt",
			authenticatedAt: NOW,
			now: NOW,
		});
		expect(selfAttestation?.independenceVerified).toBe(false);
		const profile = await getDelegationProfile(db, {
			organizationId: ORG,
			tediId: TEDI,
			now: NOW,
		});
		expect(profile.validatedExperience).toMatchObject({
			descriptiveOnly: true,
			authorityEffect: "none",
			provisional: true,
			truncated: false,
			creditedOpportunities: 5,
		});
		expect(profile.validatedExperience.points).toBeGreaterThan(0);
	});

	it("reports deterministic scan truncation beyond one thousand observations", async () => {
		const { db, sqlite } = await fixture();
		const seed = sqlite
			.prepare(
				"SELECT * FROM competency_observations WHERE client_observation_id = 'observation-1'",
			)
			.get() as Record<string, null | number | bigint | string | Uint8Array>;
		const columns = Object.keys(seed);
		const insert = sqlite.prepare(
			`INSERT INTO competency_observations (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		);
		sqlite.exec("BEGIN");
		try {
			for (let index = 1; index <= 1_001; index += 1) {
				const suffix = String(index).padStart(4, "0");
				const row = {
					...seed,
					id: `bulk-${suffix}`,
					client_observation_id: `bulk-client-${suffix}`,
					input_hash: `bulk-hash-${suffix}`,
					execution_opportunity_id: `bulk-opportunity-${suffix}`,
					source_id: `bulk-eval-${suffix}`,
					evaluation_run_id: `bulk-eval-${suffix}`,
					outcome: "failure",
					metadata: JSON.stringify({
						experienceClusterId: `bulk-cluster-${suffix}`,
					}),
					occurred_at: NOW,
					created_at: NOW,
				};
				insert.run(...columns.map((column) => row[column] ?? null));
			}
			sqlite.exec("COMMIT");
		} catch (error) {
			sqlite.exec("ROLLBACK");
			throw error;
		}

		const profile = await getDelegationProfile(db, {
			organizationId: ORG,
			tediId: TEDI,
			now: NOW,
		});
		expect(profile.validatedExperience).toMatchObject({
			truncated: true,
			observationsEvaluated: 1_000,
			negativeOpportunities: 1_000,
			standing: "contested",
		});
		expect(profile.validatedExperience.limitations).toContain(
			"Only the most recent bounded evidence window was scanned.",
		);
	});

	it("resumes a latched approval with the exact current evidence snapshot used by authority", async () => {
		const { db, role, sqlite } = await fixture();
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "promotion-resume-current-snapshot",
			tediId: TEDI,
			kind: "promote",
			targetCareerStage: "apprentice",
			evidenceRefs: ["artifact://promotion/resume"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		simulateCrashAfterApprovalLatch(sqlite, proposal.id);
		const observationId = (
			sqlite
				.prepare("SELECT id FROM competency_observations ORDER BY id LIMIT 1")
				.get() as {
				id: string;
			}
		).id;
		await attestCompetencyObservation(db, {
			organizationId: ORG,
			observationId,
			principalType: "user",
			principalId: "late-supporter",
			verdict: "supports",
			verificationMethod: "late-independent-review",
			authenticatedAt: "2026-07-20T00:45:00.000Z",
			now: "2026-07-20T00:45:00.000Z",
		});

		const applied = await decidePromotionProposal(db, {
			organizationId: ORG,
			decisionId: proposal.id,
			approved: true,
			decidedByType: "user",
			decidedById: "owner-1",
			now: "2026-07-20T01:00:00.000Z",
		});
		const revision = sqlite
			.prepare(
				"SELECT revision FROM earned_delegation_evidence_revisions WHERE organization_id = ? AND tedi_id = ?",
			)
			.get(ORG, TEDI) as { revision: number };
		expect(applied.status).toBe("applied");
		expect(applied.evidenceSnapshot.appliedEvidenceRevision).toBe(
			revision.revision,
		);
		expect(
			sqlite
				.prepare(
					"SELECT evidence_snapshot_hash FROM tedi_role_assignments WHERE id = ?",
				)
				.get(role.id),
		).toMatchObject({
			evidence_snapshot_hash: snapshotHash(applied.evidenceSnapshot),
		});
	});

	it("cancels a latched approval when resumed evidence regresses", async () => {
		const { db, role, sqlite } = await fixture();
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "promotion-resume-regressed",
			tediId: TEDI,
			kind: "promote",
			targetCareerStage: "apprentice",
			evidenceRefs: ["artifact://promotion/regressed-resume"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		simulateCrashAfterApprovalLatch(sqlite, proposal.id);
		const observationId = (
			sqlite
				.prepare("SELECT id FROM competency_observations ORDER BY id LIMIT 1")
				.get() as {
				id: string;
			}
		).id;
		await attestCompetencyObservation(db, {
			organizationId: ORG,
			observationId,
			principalType: "user",
			principalId: "late-rejecter",
			verdict: "rejects",
			verificationMethod: "late-independent-review",
			authenticatedAt: "2026-07-20T00:45:00.000Z",
			now: "2026-07-20T00:45:00.000Z",
		});

		await expect(
			decidePromotionProposal(db, {
				organizationId: ORG,
				decisionId: proposal.id,
				approved: true,
				decidedByType: "user",
				decidedById: "owner-1",
				now: "2026-07-20T01:00:00.000Z",
			}),
		).rejects.toMatchObject({ reason: "ineligible" });
		expect(
			sqlite
				.prepare("SELECT status FROM promotion_decisions WHERE id = ?")
				.get(proposal.id),
		).toMatchObject({ status: "cancelled" });
		expect(
			sqlite
				.prepare("SELECT career_stage FROM tedi_role_assignments WHERE id = ?")
				.get(role.id),
		).toMatchObject({ career_stage: "shadow" });
	});

	it("fails the final CAS when a rejecting attestation lands after the approval latch", async () => {
		let rejectedObservationId = "";
		const { db, role, sqlite } = await fixture();
		const appendLateRejection = () => {
			sqlite
				.prepare(`
						INSERT INTO competency_observation_attestations (
							id, organization_id, observation_id, principal_type,
							principal_id, verdict, verification_method,
							independence_verified, authenticated_at, created_at
						) VALUES (?, ?, ?, 'user', 'late-reviewer', 'rejects',
							'late-independent-review', 1, ?, ?)
					`)
				.run(crypto.randomUUID(), ORG, rejectedObservationId, NOW, NOW);
			sqlite
				.prepare(`
						UPDATE earned_delegation_evidence_revisions
						SET revision = revision + 1, updated_at = ?
						WHERE organization_id = ? AND tedi_id = ?
					`)
				.run(NOW, ORG, TEDI);
		};
		rejectedObservationId = (
			sqlite
				.prepare("SELECT id FROM competency_observations ORDER BY id LIMIT 1")
				.get() as {
				id: string;
			}
		).id;
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "promotion-raced-attestation",
			tediId: TEDI,
			kind: "promote",
			targetCareerStage: "apprentice",
			evidenceRefs: ["artifact://promotion/race"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		await expect(
			decidePromotionProposal(
				db,
				{
					organizationId: ORG,
					decisionId: proposal.id,
					approved: true,
					decidedByType: "user",
					decidedById: "owner-1",
					now: "2026-07-20T01:00:00.000Z",
				},
				{ beforeApplicationBatch: appendLateRejection },
			),
		).rejects.toMatchObject({ reason: "conflict" });
		expect(
			sqlite
				.prepare("SELECT career_stage FROM tedi_role_assignments WHERE id = ?")
				.get(role.id),
		).toMatchObject({ career_stage: "shadow" });
		expect(
			sqlite
				.prepare("SELECT status FROM promotion_decisions WHERE id = ?")
				.get(proposal.id),
		).toMatchObject({ status: "cancelled" });
	});

	it("fails the final CAS when the activity is superseded after the approval latch", async () => {
		let supersededActivityId = "";
		const { db, sqlite } = await fixture();
		const supersedeAfterLatch = () => {
			sqlite
				.prepare(
					"UPDATE entrustable_activities SET status = 'retired', updated_at = ? WHERE id = ?",
				)
				.run(NOW, supersededActivityId);
			sqlite
				.prepare(`
						INSERT INTO entrustable_activities (
							id, organization_id, key, version, supersedes_id,
							role_template_id, name, description, status, task_family,
							risk_level, maximum_level, action_patterns, tool_ids,
							rubric, rubric_hash, evidence_policy, evidence_policy_hash,
							created_at, updated_at
						)
						SELECT ?, organization_id, key, version + 1, id,
							role_template_id, name, description, 'active', task_family,
							risk_level, maximum_level, action_patterns, tool_ids,
							rubric, rubric_hash || '-v2', evidence_policy,
							evidence_policy_hash, ?, ?
						FROM entrustable_activities WHERE id = ?
					`)
				.run(crypto.randomUUID(), NOW, NOW, supersededActivityId);
		};
		const { activity } = await createSingleObservationActivity(
			db,
			sqlite,
			"engineering.raced-release",
		);
		supersededActivityId = activity.id;
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "grant-raced-activity",
			tediId: TEDI,
			kind: "grant",
			activityId: activity.id,
			targetEntrustmentLevel: "recommend",
			targetScope: {
				actions: ["release.deploy"],
				toolIds: ["deploy_production"],
				environments: ["production"],
				spendPermission: "none",
				budgetPolicyId: null,
				constraints: {},
			},
			targetExpiresAt: "2026-08-20T00:00:00.000Z",
			targetNextReviewAt: "2026-08-01T00:00:00.000Z",
			evidenceRefs: ["artifact://activity/race"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		await expect(
			decidePromotionProposal(
				db,
				{
					organizationId: ORG,
					decisionId: proposal.id,
					approved: true,
					decidedByType: "user",
					decidedById: "owner-1",
					now: "2026-07-20T01:00:00.000Z",
				},
				{ beforeApplicationBatch: supersedeAfterLatch },
			),
		).rejects.toMatchObject({ reason: "conflict" });
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM tedi_entrustment_grants")
				.get(),
		).toMatchObject({ count: 0 });
		expect(
			sqlite
				.prepare("SELECT status FROM promotion_decisions WHERE id = ?")
				.get(proposal.id),
		).toMatchObject({ status: "cancelled" });
	});

	it("requires target-environment evidence at proposal and settlement", async () => {
		const { db, sqlite } = await fixture();
		const activity = await createEntrustableActivity(db, {
			organizationId: ORG,
			key: "engineering.production-release",
			version: 1,
			name: "Production release",
			taskFamily: "engineering",
			riskLevel: "high",
			maximumLevel: "autonomous",
			actionPatterns: ["release.deploy"],
			toolIds: ["deploy_production"],
			rubric: { version: 1 },
			evidencePolicy: {
				minimumVerifiedObservations: 1,
				minimumDistinctVerifierPrincipals: 1,
				maximumFailureRate: 0,
				maximumPolicyViolationSeverity: 0,
				maximumEvidenceAgeDays: 90,
				requireNonTrivialWork: true,
				minimumReliabilityLowerBound: 0,
				minimumMeanComplexity: 0,
				minimumTaskFamilies: 1,
				minimumCalibrationScore: 0,
				minimumEscalationQuality: 0,
				requireLearningTransfer: false,
			},
			now: NOW,
		});
		insertCanonicalEvalRun(sqlite, {
			id: "production-eval",
			taskSetId: "production-release-task-set",
			activityId: activity.id,
			activityVersion: activity.version,
			rubricHash: activity.rubricHash,
			environment: "production",
			createdAt: "2026-07-19T00:00:00.000Z",
		});
		const observation = await recordCompetencyObservation(db, {
			organizationId: ORG,
			tediId: TEDI,
			executorType: "tedi",
			executorId: TEDI,
			evaluatorType: "api_key",
			evaluatorId: "evaluator-key-1",
			activityId: activity.id,
			clientObservationId: "production-observation",
			executionOpportunityId: "production-opportunity",
			sourceKind: "held_out_eval",
			sourceId: "production-eval",
			environment: "production",
			harness: "certifier",
			harnessVersion: "1",
			modelProvider: "openai",
			modelId: "gpt",
			modelVersion: "1",
			outcome: "success",
			complexity: 0.8,
			nonTrivial: true,
			heldOut: true,
			calibrationScore: 0.9,
			escalationQuality: 0.9,
			learningTransfer: false,
			evidenceRefs: ["artifact://production/eval"],
			classificationMethod: "server-rubric",
			evaluationRunId: "production-eval",
			proofVerifiedAt: NOW,
			confidence: 0.9,
			occurredAt: "2026-07-19T00:00:00.000Z",
			now: NOW,
		});
		await attestCompetencyObservation(db, {
			organizationId: ORG,
			observationId: observation.id,
			principalType: "user",
			principalId: "reviewer-1",
			verdict: "supports",
			verificationMethod: "independent-review",
			authenticatedAt: NOW,
			now: NOW,
		});
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "production-grant",
			tediId: TEDI,
			kind: "grant",
			activityId: activity.id,
			targetEntrustmentLevel: "recommend",
			targetScope: {
				actions: ["release.deploy"],
				toolIds: ["deploy_production"],
				environments: ["production"],
				spendPermission: "none",
				budgetPolicyId: null,
				constraints: {},
			},
			targetExpiresAt: "2026-08-20T00:00:00.000Z",
			targetNextReviewAt: "2026-08-01T00:00:00.000Z",
			evidenceRefs: ["artifact://production/proposal"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});

		sqlite
			.prepare(
				"UPDATE competency_observations SET environment = 'staging' WHERE id = ?",
			)
			.run(observation.id);
		await expect(
			createPromotionProposal(db, {
				organizationId: ORG,
				clientProposalId: "production-grant-after-regression",
				tediId: TEDI,
				kind: "grant",
				activityId: activity.id,
				targetEntrustmentLevel: "recommend",
				targetScope: {
					actions: ["release.deploy"],
					toolIds: ["deploy_production"],
					environments: ["production"],
					spendPermission: "none",
					budgetPolicyId: null,
					constraints: {},
				},
				targetExpiresAt: "2026-08-20T00:00:00.000Z",
				targetNextReviewAt: "2026-08-01T00:00:00.000Z",
				evidenceRefs: ["artifact://production/regressed"],
				proposedByType: "tedi",
				proposedById: TEDI,
				now: NOW,
				proposalExpiresAt: LATER,
			}),
		).rejects.toMatchObject({ reason: "ineligible" });
		await expect(
			decidePromotionProposal(db, {
				organizationId: ORG,
				decisionId: proposal.id,
				approved: true,
				decidedByType: "user",
				decidedById: "owner-1",
				now: "2026-07-20T01:00:00.000Z",
			}),
		).rejects.toMatchObject({ reason: "ineligible" });
	});

	it("requires a predecessor and atomically stales grants when publishing a new activity head", async () => {
		const { activity, db, role, sqlite } = await fixture();
		insertRoleBoundGrant(sqlite, {
			activityId: activity.id,
			roleAssignmentId: role.id,
		});

		await expect(
			createEntrustableActivity(db, {
				organizationId: ORG,
				key: activity.key,
				version: 2,
				name: activity.name,
				taskFamily: activity.taskFamily,
				riskLevel: activity.riskLevel,
				maximumLevel: activity.maximumLevel,
				actionPatterns: activity.actionPatterns,
				toolIds: activity.toolIds,
				rubric: { version: 2 },
				evidencePolicy: activity.evidencePolicy,
				now: LATER,
			}),
		).rejects.toMatchObject({ reason: "invalid_transition" });

		const successor = await createEntrustableActivity(db, {
			organizationId: ORG,
			key: activity.key,
			version: 2,
			supersedesId: activity.id,
			name: activity.name,
			taskFamily: activity.taskFamily,
			riskLevel: activity.riskLevel,
			maximumLevel: activity.maximumLevel,
			actionPatterns: activity.actionPatterns,
			toolIds: activity.toolIds,
			rubric: { version: 2 },
			evidencePolicy: activity.evidencePolicy,
			now: LATER,
		});
		expect(successor.supersedesId).toBe(activity.id);
		expect(
			sqlite
				.prepare("SELECT status FROM entrustable_activities WHERE id = ?")
				.get(activity.id),
		).toMatchObject({ status: "retired" });
		expect(
			sqlite
				.prepare(
					"SELECT status, revision, restricted_at FROM tedi_entrustment_grants WHERE id = 'grant-1'",
				)
				.get(),
		).toMatchObject({
			status: "restricted",
			revision: 2,
			restricted_at: LATER,
		});
	});

	it("revokes role-bound grants atomically with a role change", async () => {
		const { activity, db, role, sqlite } = await fixture();
		insertRoleBoundGrant(sqlite, {
			activityId: activity.id,
			roleAssignmentId: role.id,
		});
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "role-change-1",
			tediId: TEDI,
			kind: "role_change",
			targetRoleKey: "cmo",
			targetRoleName: "Chief Marketing Officer",
			evidenceRefs: ["artifact://role-change/1"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		const applied = await decidePromotionProposal(db, {
			organizationId: ORG,
			decisionId: proposal.id,
			approved: true,
			decidedByType: "user",
			decidedById: "owner-1",
			now: "2026-07-20T01:00:00.000Z",
		});
		expect(applied.status).toBe("applied");
		expect(
			sqlite
				.prepare(
					"SELECT status, last_decision_id FROM tedi_entrustment_grants WHERE id = 'grant-1'",
				)
				.get(),
		).toMatchObject({ status: "revoked", last_decision_id: proposal.id });
		expect(
			sqlite
				.prepare(
					"SELECT role_key, career_stage FROM tedi_role_assignments WHERE status = 'active'",
				)
				.get(),
		).toMatchObject({ role_key: "cmo", career_stage: "shadow" });
	});

	it("applies a promotion through D1 batch without interactive transactions", async () => {
		const { db, sqlite, role } = await fixture();
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "promote-1",
			tediId: TEDI,
			kind: "promote",
			targetCareerStage: "apprentice",
			evidenceRefs: ["artifact://promotion/1"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		expect(proposal.expectedRoleRevision).toBe(role.revision);

		const applied = await decidePromotionProposal(db, {
			organizationId: ORG,
			decisionId: proposal.id,
			approved: true,
			decidedByType: "user",
			decidedById: "owner-1",
			now: "2026-07-20T01:00:00.000Z",
		});
		expect(applied.status).toBe("applied");
		const persisted = sqlite
			.prepare(
				"SELECT career_stage, last_decision_id FROM tedi_role_assignments WHERE id = ?",
			)
			.get(role.id) as Record<string, unknown>;
		expect(persisted).toMatchObject({
			career_stage: "apprentice",
			last_decision_id: proposal.id,
		});
	});

	it("cancels safely when the role revision changes after proposal", async () => {
		const { db, sqlite, role } = await fixture();
		const proposal = await createPromotionProposal(db, {
			organizationId: ORG,
			clientProposalId: "promote-stale",
			tediId: TEDI,
			kind: "promote",
			targetCareerStage: "apprentice",
			evidenceRefs: ["artifact://promotion/stale"],
			proposedByType: "tedi",
			proposedById: TEDI,
			now: NOW,
			proposalExpiresAt: LATER,
		});
		sqlite
			.prepare(
				"UPDATE tedi_role_assignments SET revision = revision + 1 WHERE id = ?",
			)
			.run(role.id);

		await expect(
			decidePromotionProposal(db, {
				organizationId: ORG,
				decisionId: proposal.id,
				approved: true,
				decidedByType: "user",
				decidedById: "owner-1",
				now: "2026-07-20T01:00:00.000Z",
			}),
		).rejects.toBeInstanceOf(EarnedDelegationError);
		expect(
			sqlite
				.prepare("SELECT status FROM promotion_decisions WHERE id = ?")
				.get(proposal.id),
		).toMatchObject({ status: "cancelled" });
		expect(
			sqlite
				.prepare("SELECT career_stage FROM tedi_role_assignments WHERE id = ?")
				.get(role.id),
		).toMatchObject({ career_stage: "shadow" });
	});
});
