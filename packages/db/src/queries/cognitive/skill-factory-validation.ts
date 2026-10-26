import { parse as parseSource } from "@babel/parser";
import { parse as parseYaml } from "yaml";

/**
 * Factory setup checks for validate_skills. Each one names a mistake that
 * otherwise surfaces only when the factory first dispatches: a workflow that
 * files its Work under another factory's slug or owner, a tedi-turn step whose
 * timeout the MCP bridge can never honour, and a scheduled turn asked to do
 * GitHub or workstation work it has no Work Attempt for.
 */

export interface FactoryValidationIssue {
	code: string;
	message: string;
	path?: string;
}

/** The `const FACTORY = {…}` header written by create_factory. */
export interface FactoryConstants {
	slug: string | null;
	ownerTediId: string | null;
}

/** Above this a run_tedi_turn call is cut by the dispatch shim (BRIDGE_CALL_TIMEOUT_MS). */
export const TEDI_TURN_STEP_CAP_MS = 240_000;
/** The MCP bridge's own abort for one call (apps/skill-runtime MCP_BRIDGE_TIMEOUT_MS). */
const MCP_BRIDGE_CALL_TIMEOUT_MS = 180_000;
const WORKFLOW_PATH = 'files["scripts/workflow.ts"]';
const WORK_SCOPED_SURFACE_RE = /\bgithub\b|\bworkstations?\b/i;

type Node = { type: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { type?: unknown }).type === "string"
	);
}

function children(node: Node): Node[] {
	const out: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "loc" || key === "start" || key === "end") continue;
		if (Array.isArray(value)) out.push(...value.filter(isNode));
		else if (isNode(value)) out.push(value);
	}
	return out;
}

function walk(node: Node, visit: (node: Node) => void) {
	visit(node);
	for (const child of children(node)) walk(child, visit);
}

function parseProgram(source: string): Node[] {
	try {
		const file = parseSource(source, {
			sourceType: "module",
			plugins: ["typescript"],
			errorRecovery: true,
		});
		const body = (file.program as unknown as { body?: unknown }).body;
		return Array.isArray(body) ? body.filter(isNode) : [];
	} catch {
		return [];
	}
}

function topLevelConsts(body: Node[]): Map<string, Node> {
	const out = new Map<string, Node>();
	for (const stmt of body) {
		if (stmt.type !== "VariableDeclaration") continue;
		for (const decl of (stmt.declarations as unknown[]) ?? []) {
			if (!isNode(decl) || !isNode(decl.id) || !isNode(decl.init)) continue;
			if (decl.id.type === "Identifier")
				out.set(decl.id.name as string, decl.init);
		}
	}
	return out;
}

function memberName(member: Node): string | null {
	if (member.computed === true || !isNode(member.key)) return null;
	if (member.key.type === "Identifier") return member.key.name as string;
	if (member.key.type === "StringLiteral") return member.key.value as string;
	return null;
}

function objectProperty(object: Node, name: string): Node | null {
	for (const member of (object.properties as unknown[]) ?? []) {
		if (isNode(member) && member.type === "ObjectProperty") {
			if (memberName(member) === name && isNode(member.value))
				return member.value;
		}
	}
	return null;
}

function stringValue(node: Node | null): string | null {
	if (!node) return null;
	if (node.type === "StringLiteral") return node.value as string;
	if (
		node.type === "TemplateLiteral" &&
		((node.expressions as unknown[]) ?? []).length === 0
	) {
		const quasi = (node.quasis as Array<{ value?: { cooked?: string } }>)[0];
		return quasi?.value?.cooked ?? null;
	}
	return null;
}

/** Read the create_factory header; null when the workflow has none. */
export function readFactoryConstants(source: string): FactoryConstants | null {
	const factory = topLevelConsts(parseProgram(source)).get("FACTORY");
	if (!factory || factory.type !== "ObjectExpression") return null;
	return {
		slug: stringValue(objectProperty(factory, "slug")),
		ownerTediId: stringValue(objectProperty(factory, "ownerTediId")),
	};
}

/** Milliseconds for a Workflows step timeout ("240 seconds", "2 minutes", 90000). */
export function stepTimeoutMs(value: string | number): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const match = value
		.trim()
		.match(
			/^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hours?)$/i,
		);
	if (!match) return null;
	const amount = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	if (unit.startsWith("ms") || unit.startsWith("milli")) return amount;
	if (unit.startsWith("s")) return amount * 1_000;
	if (unit.startsWith("m")) return amount * 60_000;
	return amount * 3_600_000;
}

function callsRunTediTurn(node: Node): boolean {
	let found = false;
	walk(node, (child) => {
		if (found || child.type !== "CallExpression" || !isNode(child.callee))
			return;
		const callee = child.callee;
		if (
			(callee.type === "MemberExpression" ||
				callee.type === "OptionalMemberExpression") &&
			isNode(callee.property) &&
			((callee.property.type === "Identifier" &&
				callee.property.name === "run_tedi_turn") ||
				(callee.property.type === "StringLiteral" &&
					callee.property.value === "run_tedi_turn"))
		)
			found = true;
	});
	return found;
}

/** `step.do(name, config, fn)` calls whose callback starts a tedi turn. */
function tediTurnSteps(body: Node[]) {
	const consts = topLevelConsts(body);
	const steps: Array<{ name: string; timeoutMs: number | null }> = [];
	for (const stmt of body)
		walk(stmt, (node) => {
			if (node.type !== "CallExpression" || !isNode(node.callee)) return;
			const callee = node.callee;
			if (
				callee.type !== "MemberExpression" ||
				!isNode(callee.property) ||
				callee.property.name !== "do"
			)
				return;
			const args = ((node.arguments as unknown[]) ?? []).filter(isNode);
			const callback = args.at(-1);
			if (args.length < 3 || !callback || !callsRunTediTurn(callback)) return;
			let config: Node | undefined = args[1];
			if (config?.type === "Identifier")
				config = consts.get(config.name as string);
			const timeout =
				config?.type === "ObjectExpression"
					? objectProperty(config, "timeout")
					: null;
			const raw =
				timeout?.type === "NumericLiteral"
					? (timeout.value as number)
					: stringValue(timeout);
			steps.push({
				name: stringValue(args[0] ?? null) ?? "(dynamic)",
				timeoutMs: raw === null ? null : stepTimeoutMs(raw),
			});
		});
	return steps;
}

function frontmatterName(content: string): string | null {
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
	if (frontmatter === undefined) return null;
	try {
		const parsed = parseYaml(frontmatter) as { name?: unknown } | null;
		return typeof parsed?.name === "string" ? parsed.name.trim() : null;
	} catch {
		return null;
	}
}

/**
 * Factory checks over SKILL.md plus scripts/workflow.ts. `skillSlug` and
 * `ownerTediId` describe the stored skill when one exists; a draft falls back
 * to its frontmatter name and has no owner to compare.
 */
export function lintFactoryWorkflow(input: {
	source: string;
	content: string;
	skillSlug?: string | null;
	ownerTediId?: string | null;
}): { errors: FactoryValidationIssue[]; warnings: FactoryValidationIssue[] } {
	const errors: FactoryValidationIssue[] = [];
	const warnings: FactoryValidationIssue[] = [];
	const body = parseProgram(input.source);
	if (!body.length) return { errors, warnings };

	const factory = readFactoryConstants(input.source);
	const expectedSlug =
		input.skillSlug?.trim() || frontmatterName(input.content);
	if (factory?.slug && expectedSlug && factory.slug !== expectedSlug)
		errors.push({
			code: "SKILL_FACTORY_SLUG_MISMATCH",
			message: `scripts/workflow.ts reads FACTORY.slug "${factory.slug}", but this skill is "${expectedSlug}". Cycle keys, health comments and proposal dedupe would be filed under the wrong factory. Fix: set FACTORY.slug to "${expectedSlug}" or re-render the workflow with create_factory.`,
			path: WORKFLOW_PATH,
		});
	if (
		factory?.ownerTediId &&
		input.ownerTediId &&
		factory.ownerTediId !== input.ownerTediId
	)
		errors.push({
			code: "SKILL_FACTORY_OWNER_MISMATCH",
			message: `scripts/workflow.ts names owner tedi ${factory.ownerTediId}, but the skill is owned by ${input.ownerTediId}. Scheduled runs execute as the skill's owner, so proposals would name an owner that never ran them. Fix: re-render the workflow for the current owner, or move the skill to ${factory.ownerTediId}.`,
			path: WORKFLOW_PATH,
		});

	const turnSteps = tediTurnSteps(body);
	for (const step of turnSteps) {
		if (step.timeoutMs === null || step.timeoutMs <= TEDI_TURN_STEP_CAP_MS)
			continue;
		warnings.push({
			code: "SKILL_TURN_BUDGET_OVER_BRIDGE_CAP",
			message: `Step "${step.name}" gives run_tedi_turn ${Math.round(step.timeoutMs / 1000)} s, but the MCP bridge aborts one call after ${MCP_BRIDGE_CALL_TIMEOUT_MS / 1000} s and the dispatch shim after ${TEDI_TURN_STEP_CAP_MS / 1000} s, so the extra time is never used. Fix: keep the turn step timeout at ${TEDI_TURN_STEP_CAP_MS / 1000} s or less (the factory template uses 240 seconds) and wait for the reply with step.sleep plus messages_read.`,
			path: WORKFLOW_PATH,
		});
	}
	if (
		turnSteps.length > 0 &&
		WORK_SCOPED_SURFACE_RE.test(`${input.content}\n${input.source}`)
	)
		warnings.push({
			code: "SKILL_TURN_NEEDS_WORK_SCOPE",
			message:
				"This workflow starts a tedi turn and mentions GitHub or a workstation. A turn started by a workflow run has no Work Attempt unless the run was started for a Work Item, and GitHub egress and workstation tools refuse it (403). Fix: start the run with workItemId, or file the GitHub or workstation part as a Work Item with an executor and let the turn report on it.",
			path: WORKFLOW_PATH,
		});
	return { errors, warnings };
}
