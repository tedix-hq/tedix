/**
 * Seeds the sample company (apps/os/dev/demo-pack) into the isolated local D1
 * for `bun run-local --demo`: projects, Feed events, a saved Today digest and
 * Deck cards with their decided history. Dates are relative to now. Responses are
 * immutable in D1, so seeding is insert-or-ignore; run-local rebuilds the demo
 * state directory when it is older than a week. Nothing here reads a tenant, and the demo API runs
 * with sending switched off (TEDIX_DEMO_SENDING_OFF).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	demoDecisionEnvelope,
	demoPackCards,
	demoPackFeed,
	demoFeedPolicy,
	demoTodayConfig,
	demoTodayContent,
	demoTodayId,
	demoPackPresentations,
	demoPackWorkspaces,
	groupOf,
	uid,
} from "../apps/os/dev/demo-pack";
import opportunityCardsApp from "../apps/os/dev/demo-pack/opportunity-cards-app.json";
import opportunityCardsManifest from "../apps/os/dev/demo-pack/opportunity-cards-manifest.json";
import cards from "../apps/os/dev/demo-pack/cards.json";
import memoryFacts from "../apps/os/dev/demo-pack/memory-facts.json";
import blueprint from "../apps/api/src/services/default-work-blueprint.json";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-000000000002";
const TEDI = "00000000-0000-4000-8000-000000000004";
const WORKSPACE = "00000000-0000-4000-8000-0000000000a0";
const PROJECT_KEYS = ["REDDIT", "FINANCE", "ONCALL"];
const DAY_MS = 86_400_000;

const q = (value: unknown): string =>
	value === null || value === undefined
		? "NULL"
		: typeof value === "number"
			? String(value)
			: `'${String(value).replaceAll("'", "''")}'`;
const json = (value: unknown): string => q(JSON.stringify(value));

export function demoPackSeedSql(nowMs: number = Date.now()): string {
	const at = (ms: number) => new Date(ms).toISOString();
	const now = at(nowMs);
	const sql: string[] = [
		`UPDATE organizations SET metadata = json_set(coalesce(metadata, '{}'), '$.decisionLearning', json(${json({ enabled: false, focusFeed: demoFeedPolicy, timezone: "Europe/Berlin" })})) WHERE id = ${q(ORG)};`,
	];
	demoPackWorkspaces.forEach((space, i) => {
		sql.push(
			`INSERT OR IGNORE INTO projects (id, org_id, key, name, description, status, lead_tedi_id, created_at, updated_at) VALUES (${q(uid(118, i + 1))}, ${q(ORG)}, ${q(PROJECT_KEYS[i])}, ${q(space.name)}, ${q(space.description)}, 'active', ${q(TEDI)}, ${q(now)}, ${q(now)});`,
		);
	});
	sql.push(
		`INSERT OR IGNORE INTO os_workspaces (id, organization_id, name, description, status, visibility, created_by_kind, created_by_id, created_at, updated_at) VALUES (${q(WORKSPACE)}, ${q(ORG)}, 'Work', 'Feed and Deck for the sample company.', 'active', 'org', 'user', 'local-demo-owner', ${q(now)}, ${q(now)});`,
	);
	const appWorkspace = uid(48, 1);
	const appId = uid(49, 14);
	const appRevision = uid(50, 14);
	const sheetId = uid(64, 20);
	const sheetRevision = uid(65, 20);
	const sheet = {
		kind: "sheet",
		columns: ["#", "Source (link)", "Who", "Why (rule)", "Draft", "Useful?"],
		rows: cards
			.filter((card) => card.category === "Reddit")
			.slice(0, 8)
			.map((card, index) => [
				index + 1,
				`https://reddit.example/r/BuyItForLife/fable-${String(index + 1).padStart(2, "0")}`,
				card.agent,
				card.title,
				card.story,
				card.status === "decided" ? "yes" : "",
			]),
	};
	sql.push(
		`INSERT OR IGNORE INTO os_workspaces (id, organization_id, name, description, created_by_kind, created_by_id) VALUES (${q(appWorkspace)}, ${q(ORG)}, ${q(demoPackWorkspaces[0]!.name)}, ${q(demoPackWorkspaces[0]!.description)}, 'user', 'local-demo-owner');`,
		`INSERT OR IGNORE INTO os_gadgets (id, organization_id, workspace_id, name, current_revision_id, created_by_kind, created_by_id) VALUES (${q(appId)}, ${q(ORG)}, ${q(appWorkspace)}, 'Opportunity cards', ${q(appRevision)}, 'user', 'local-demo-owner');`,
		`INSERT OR IGNORE INTO os_gadget_revisions (id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id) VALUES (${q(appRevision)}, ${q(ORG)}, ${q(appId)}, 1, ${json(opportunityCardsManifest)}, 'user', 'local-demo-owner');`,
		`INSERT OR IGNORE INTO os_gadget_code (revision_id, organization_id, gadget_id, files, code_length) VALUES (${q(appRevision)}, ${q(ORG)}, ${q(appId)}, ${json(opportunityCardsApp)}, ${q(Object.values(opportunityCardsApp).reduce((sum, source) => sum + source.length, 0))});`,
		`INSERT OR IGNORE INTO os_outputs (id, organization_id, workspace_id, kind, title, current_revision_id, created_by_kind, created_by_id) VALUES (${q(sheetId)}, ${q(ORG)}, ${q(appWorkspace)}, 'sheet', 'Opportunities', ${q(sheetRevision)}, 'user', 'local-demo-owner');`,
		`INSERT OR IGNORE INTO os_output_revisions (id, organization_id, output_id, revision, content, access_envelope, created_by_kind, created_by_id) VALUES (${q(sheetRevision)}, ${q(ORG)}, ${q(sheetId)}, 1, ${json(sheet)}, ${json({ version: 1, sources: [] })}, 'user', 'local-demo-owner');`,
		`INSERT OR IGNORE INTO os_workspace_resources (id, organization_id, workspace_id, slot, provider_id, connection_scope, resource_type, provider_resource_id, name, created_by_kind, created_by_id) VALUES (${q(uid(70, 1))}, ${q(ORG)}, ${q(appWorkspace)}, 'opportunities', 'tedix', 'tenant', 'output', ${q(sheetId)}, 'Opportunities sheet', 'user', 'local-demo-owner');`,
	);
	blueprint.gadgets.forEach((gadget, i) => {
		const id = uid(49, 10 + i);
		const revision = uid(50, 10 + i);
		sql.push(
			`INSERT OR IGNORE INTO os_gadgets (id, organization_id, workspace_id, name, status, current_revision_id, created_by_kind, created_by_id, created_at, updated_at) VALUES (${q(id)}, ${q(ORG)}, ${q(WORKSPACE)}, ${q(gadget.name)}, 'active', ${q(revision)}, 'user', 'local-demo-owner', ${q(now)}, ${q(now)});`,
			`INSERT OR IGNORE INTO os_gadget_revisions (id, organization_id, gadget_id, revision, manifest, created_by_kind, created_by_id, created_at) VALUES (${q(revision)}, ${q(ORG)}, ${q(id)}, 1, ${json(gadget.name === "Feed" ? { ...gadget.manifest, config: { ...gadget.manifest.config, today: demoTodayConfig(TEDI, USER) } } : gadget.manifest)}, 'user', 'local-demo-owner', ${q(now)});`,
		);
	});
	sql.push(
		`INSERT OR IGNORE INTO os_outputs (id, organization_id, workspace_id, kind, title, status, current_revision_id, created_by_kind, created_by_id, created_at, updated_at) VALUES (${q(demoTodayId)}, ${q(ORG)}, ${q(WORKSPACE)}, 'document', 'PricePilot Today', 'active', ${q(uid(177, 1))}, 'user', 'local-demo-owner', ${q(now)}, ${q(now)});`,
		`INSERT OR IGNORE INTO os_output_revisions (id, organization_id, output_id, revision, content, access_envelope, created_by_kind, created_by_id, created_at) VALUES (${q(uid(177, 1))}, ${q(ORG)}, ${q(demoTodayId)}, 1, ${json(demoTodayContent(nowMs))}, ${json({ version: 1, sources: [] })}, 'user', 'local-demo-owner', ${q(now)});`,
	);
	for (const [i, event] of demoPackFeed(nowMs).entries()) {
		const group =
			event.agent === "Reconciler" ? 1 : event.agent === "On-call" ? 2 : 0;
		sql.push(
			`INSERT OR IGNORE INTO work_items (id, org_id, project_id, title, description, disposition, created_at, completed_at, admission_spec_revision, metadata) VALUES (${q(uid(172, i + 1))}, ${q(ORG)}, ${q(uid(118, group + 1))}, ${q(event.title)}, ${q(event.detail)}, 'completed', ${q(event.createdAt)}, ${q(event.createdAt)}, 'sample-pack-v1', ${json({ sampleData: true })});`,
			`INSERT OR IGNORE INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at) VALUES (${q(uid(171, i + 1))}, ${q(ORG)}, ${q(uid(172, i + 1))}, 'work.completed', 'tedi', ${q(TEDI)}, ${json({ summary: event.body, sampleData: true })}, ${q(event.createdAt)});`,
		);
	}
	for (const { card, requestedAt } of demoPackCards(nowMs)) {
		const group = groupOf(card);
		const [, lesson] = memoryFacts[group === 0 ? 1 : group === 1 ? 5 : 6]!;
		const decision = demoDecisionEnvelope(card, group, {
			id: `fact-${group}`,
			text: lesson,
		});
		const resolved = card.status === "decided";
		const resolvedAt = at(Date.parse(requestedAt) + 40 * 60_000);
		const fence = uid(166, Number.parseInt(card.id.slice(-12), 16));
		sql.push(
			`INSERT OR IGNORE INTO work_interactions (id, org_id, project_id, kind, status, subject, prompt, creator_type, creator_id, target_type, target_id, resolution_fence, created_at, resolved_at, version, metadata) VALUES (${q(card.id)}, ${q(ORG)}, ${q(uid(118, group + 1))}, 'question', 'open', ${q(card.title)}, ${q(`${card.evidence}\n\n${card.story}`)}, 'tedi', ${q(TEDI)}, 'user', ${q(USER)}, NULL, ${q(requestedAt)}, NULL, 1, ${json({ decisionDeck: decision, cardContent: card.story, sampleData: true, sourceLabel: card.evidence })});`,
			`INSERT OR IGNORE INTO work_interaction_attention (org_id, interaction_id, kind, need, asks, decided_at) VALUES (${q(ORG)}, ${q(card.id)}, 'needs_you', ${q(card.title)}, 0.9, ${q(requestedAt)});`,
		);
		const presentation = demoPackPresentations[card.id];
		if (presentation)
			sql.push(
				`INSERT OR IGNORE INTO work_interaction_card_presentations (org_id, interaction_id, person_id, request_version, presentation, updated_at) VALUES (${q(ORG)}, ${q(card.id)}, ${q(USER)}, 1, ${json(presentation)}, ${q(now)});`,
			);
		if (resolved)
			sql.push(
				`INSERT INTO work_interaction_responses (id, org_id, interaction_id, resolved_request_version, resolution_fence, responder_type, responder_id, body, response_kind, resolves_request, metadata, responded_at) SELECT ${q(uid(168, Number.parseInt(card.id.slice(-12), 16)))}, ${q(ORG)}, ${q(card.id)}, 2, ${q(fence)}, 'user', ${q(USER)}, ${q(card.decision ?? "Useful")}, 'answer', 1, ${json({ sampleData: true })}, ${q(resolvedAt)} WHERE NOT EXISTS (SELECT 1 FROM work_interaction_responses WHERE interaction_id = ${q(card.id)});`,
			);
	}
	return `${sql.join("\n")}\n`;
}

if (import.meta.main) {
	const file = join(
		mkdtempSync(join(tmpdir(), "tedix-demo-pack-")),
		"seed.sql",
	);
	writeFileSync(file, demoPackSeedSql());
	const run = spawnSync(
		"bun",
		[
			"../../scripts/dev-local.ts",
			"--",
			"wrangler",
			"d1",
			"execute",
			"DB",
			"--file",
			file,
		],
		{ cwd: resolve(import.meta.dirname, "../apps/api"), stdio: "inherit" },
	);
	if (run.status !== 0) process.exit(run.status ?? 1);
}
