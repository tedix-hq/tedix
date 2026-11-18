/**
 * "Always approve" rules: a person lets one kind of change in this workspace
 * apply without asking. The rules live in the workspace object. Only the
 * kinds listed here can ever be covered; deleting, sharing, filing Work and
 * anything else outside the workspace's own files always waits for a person.
 */

export type AutoApprovalKind = "files";

export interface AutoApprovalRule {
	kind: AutoApprovalKind;
	/** What the rule approves, in the words the confirm dialog showed. */
	label: string;
	enabledBy: string;
	enabledAt: string;
}

interface KindDefinition {
	label: string;
	/** The exact binding methods the kind covers. */
	methods: Record<string, readonly string[]>;
}

const KINDS: Record<AutoApprovalKind, KindDefinition> = {
	files: {
		label: "creating and editing docs, sheets and slides in this workspace",
		methods: {
			outputs: ["create", "revise"],
			documents: ["replace", "edit"],
			sheets: ["replace", "edit"],
			presentations: ["replace", "edit"],
		},
	},
};

export function isAutoApprovalKind(value: unknown): value is AutoApprovalKind {
	return typeof value === "string" && Object.hasOwn(KINDS, value);
}

export function autoApprovalLabel(kind: AutoApprovalKind): string {
	return KINDS[kind].label;
}

/** An edit that removes blocks or slides always asks, even inside a rule. */
function removesSomething(args: unknown[]): boolean {
	const input = args[0];
	if (!input || typeof input !== "object") return false;
	const ops = (input as { ops?: unknown }).ops;
	if (!Array.isArray(ops)) return false;
	return ops.some((op) => {
		const name =
			op && typeof op === "object" ? (op as { op?: unknown }).op : null;
		return typeof name === "string" && /delete|remove|archive/i.test(name);
	});
}

/**
 * The rule kind that could cover this held call, or null when no rule may
 * ever approve it. A call is covered only when it is a listed method, is not
 * destructive and removes nothing.
 */
export function autoApprovalKindFor(
	binding: string,
	method: string,
	args: unknown[],
	/** `destructive`: anything beyond a bounded write to one file. */
	options: { destructive?: boolean } = {},
): AutoApprovalKind | null {
	if (options.destructive) return null;
	if (removesSomething(args)) return null;
	for (const [kind, definition] of Object.entries(KINDS) as Array<
		[AutoApprovalKind, KindDefinition]
	>) {
		if (definition.methods[binding]?.includes(method)) return kind;
	}
	return null;
}

const RULES_KEY = "auto-approval-rules";

export interface RuleStorage {
	get<T>(key: string): T | undefined;
	put(key: string, value: unknown): void;
}

export function readAutoApprovalRules(store: RuleStorage): AutoApprovalRule[] {
	const rules = store.get<AutoApprovalRule[]>(RULES_KEY) ?? [];
	return rules.filter((rule) => isAutoApprovalKind(rule.kind));
}

export function writeAutoApprovalRule(
	store: RuleStorage,
	input: { kind: AutoApprovalKind; enabled: boolean; by: string; at: string },
): AutoApprovalRule[] {
	const others = readAutoApprovalRules(store).filter(
		(rule) => rule.kind !== input.kind,
	);
	const rules = input.enabled
		? [
				...others,
				{
					kind: input.kind,
					label: autoApprovalLabel(input.kind),
					enabledBy: input.by,
					enabledAt: input.at,
				},
			]
		: others;
	store.put(RULES_KEY, rules);
	return rules;
}
