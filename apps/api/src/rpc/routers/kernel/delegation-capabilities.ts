import type { ExecutionRequirement } from "@tedix/api-contract/schemas/execution-evidence";
import { withoutQuotedCommitSubjects } from "@tedix/api-contract/utils/approval-policy";
import { delegatedCloseoutProjects } from "@tedix/api-contract/utils/delegated-work-closeout";
import type { DelegationCapabilityPlan } from "@tedix/api-contract/schemas/kernel-runtime";
import type { KernelRouteDecision } from "./route-schema";
import type { TediCapabilityCard } from "./tedi-capabilities";

/** CLI repository metadata supplies context, never additional requested access. */
export function delegationRequestContent(content: string): string {
	return content.split(/\n\nLocal terminal context:\n- cwd: /, 1)[0] ?? content;
}

/**
 * Native tool ids are bare snake_case names and provider callables are
 * `namespace.tool`; a planned id of any other shape names a connected app
 * (slug, or the `mcp__<app>__<tool>` aggregate alias) rather than a tool.
 */
export function isAppLevelGrant(
	id: string,
	card: Pick<TediCapabilityCard, "apps"> | null,
): boolean {
	if (id.includes(".")) return false;
	return (
		id.startsWith("mcp__") ||
		id.includes("-") ||
		Boolean(card?.apps.includes(id))
	);
}

/** A task ceiling, never a substitute for executor entitlement or dispatch policy. */
export function deriveDelegationCapabilityPlan(input: {
	content: string;
	route: KernelRouteDecision;
	requirement: ExecutionRequirement;
	card: TediCapabilityCard | null;
}): DelegationCapabilityPlan | undefined {
	const { route, requirement, card } = input;
	const content = withoutQuotedCommitSubjects(
		delegationRequestContent(input.content),
	);
	// An explicitly read-only request never derives a Work write capability.
	const readOnly = /\bread-only\b/i.test(content);
	const scopedCloseout = Boolean(
		card && delegatedCloseoutProjects(content).length,
	);
	const capabilities: string[] = [];
	const tools = new Set<string>();
	const missingCapabilities: string[] = [];
	const urls = [...new Set(content.match(/https?:\/\/[^\s<>"`]+/gi) ?? [])]
		.map((url) => url.replace(/[),.;!?]+$/, ""))
		.filter((url) => URL.canParse(url));
	const outputUrls = urls.filter((url) =>
		/^\/outputs\/([a-f\d-]{36})$/i.test(new URL(url).pathname),
	);
	const outputRead =
		outputUrls.length > 0 ||
		route.plannedToolIds.some((id) => id.endsWith(".get_os_output"));
	const outputIds = outputRead
		? [
				...new Set(
					content.match(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi) ?? [],
				),
			]
		: [];
	const activityTools =
		card?.delegationEntrustments
			.filter((grant) => grant.activityId === route.targetActivityId)
			.flatMap((grant) =>
				grant.activityToolIds.filter((id) => grant.scope.toolIds.includes(id)),
			) ?? [];
	const providerTool = (capability: string, pattern: RegExp) => {
		capabilities.push(capability);
		const matches = [
			...new Set([...route.plannedToolIds, ...activityTools]),
		].filter((id) => id.includes(".") && pattern.test(id));
		if (matches.length !== 1) missingCapabilities.push(capability);
		else tools.add(matches[0]!);
	};
	if (outputRead) {
		providerTool("output.read", /\.get_os_output$/);
		if (outputIds.length === 0) missingCapabilities.push("output.reference");
	}
	// Native web search is offered only where the organization enabled it.
	// The planner can omit web_search; these phrasings still name a web lookup.
	const webLookup =
		/\b(?:search\s+(?:the\s+)?(?:web|internet)|search\s+online|(?:web|internet)\s+search|on\s+the\s+(?:web|internet)|latest\s+(?:stable\s+)?version\s+of)\b/i.test(
			content,
		) ||
		(/\blook\s+(?:(?:it|this|that|them)\s+)?up\b/i.test(content) &&
			!/\b(?:work\s+items?|emails?|invoices?|repository|codebase)\b/i.test(
				content,
			));
	if (
		card?.webSearch &&
		(route.plannedToolIds.includes("web_search") || webLookup)
	) {
		capabilities.push("web.search");
		tools.add("web_search");
		tools.add("browser_markdown");
		tools.add("browser_read_result");
	}
	if (urls.some((url) => !outputUrls.includes(url))) {
		capabilities.push("page.read");
		tools.add("browser_markdown");
		tools.add("browser_read_result");
	}
	if (
		/\b(?:draft|compose|prepare)\b[^.!?\n]{0,80}\b(?:e-?mail|gmail|reply)\b|\b(?:e-?mail|gmail)\s+draft\b/i.test(
			content,
		)
	) {
		providerTool(
			"email.draft",
			/\.(?:create_draft|drafts_create|create_email_draft)$/,
		);
	}
	if (
		!scopedCloseout &&
		!readOnly &&
		/\bwork(?:\s+item)?\b/i.test(content) &&
		/\b(?:add|post|write|leave)\s+(?:(?:a|an|the|one-line|closing|brief|short)\s+){0,4}comment\b|\bclosing\s+comment\b|\bwork(?:\s+item)?\s+comment\b/i.test(
			content,
		)
	) {
		const mapped = [...route.plannedToolIds, ...activityTools].some((id) =>
			/\.(?:add_comment|work_item_comment)$/.test(id),
		);
		if (!mapped && card) {
			// Canonical platform callable; the child still verifies its own grant
			// with discover.describe before inference. No scopes are added here.
			capabilities.push("work.comment");
			tools.add("work.add_comment");
		} else {
			providerTool("work.comment", /\.(?:add_comment|work_item_comment)$/);
		}
	}
	if (
		card &&
		/\bwork\b/i.test(content) &&
		(/\b(?:history|backlog|attempts|settled)\b/i.test(content) ||
			/\bwork\s+(?:items?|board)\b/i.test(content))
	) {
		capabilities.push("work.read");
		for (const id of [
			"list_attempt_projection",
			"list_work_items",
			"get_work_items_by_id",
			"list_work_item_attempts",
			"list_work_item_evidence",
			"list_work_item_events",
		])
			tools.add(`work.${id}`);
		if (scopedCloseout) {
			capabilities.push("work.closeout");
			tools.add("close_completed_work_item");
		} else if (
			!readOnly &&
			/\bmark\b[^.!?\n]{0,60}\bcompleted\b/i.test(content)
		) {
			capabilities.push("work.complete");
			tools.add("work.complete_work_item");
		}
	}
	if (card && /\bToday\/Feed\s+post\b/i.test(content)) {
		capabilities.push("today.read");
		for (const id of ["list_work_apps", "get_os_output"]) tools.add(`os.${id}`);
		if (/\b(?:write|publish|update|refresh)\b/i.test(content)) {
			capabilities.push("today.update");
			tools.add("os.revise_os_output");
		}
	}
	if (
		card &&
		/\b(?:save|create)\b[^.!?\n]{0,60}\b(?:Output|document)\b/i.test(content)
	) {
		capabilities.push("output.create");
		for (const id of [
			"list_os_workspaces",
			"create_os_output",
			"get_os_output",
		])
			tools.add(`os.${id}`);
	}
	if (
		card &&
		/\bAdmission:\s*create\b/i.test(content) &&
		/\bWork\s+item\b/i.test(content)
	) {
		// Home owns admission and settlement below the child model.
		capabilities.push("work.read");
		for (const id of [
			"list_work_items",
			"get_work_items_by_id",
			"list_work_item_attempts",
		])
			tools.add(`work.${id}`);
	}
	const repositoryTask =
		(capabilities.length === 0 ||
			/\b(?:repo(?:sitory)?|codebase|source code)\b/i.test(
				content.replace(/https?:\/\/\S+/gi, " "),
			)) &&
		requirement.requiredCapabilities.some(
			(capability) =>
				capability === "repository_read" || capability === "repository_edit",
		);
	if (repositoryTask || requirement.surface !== "native") {
		const editing =
			requirement.requiredCapabilities.includes("repository_edit");
		capabilities.push(
			requirement.surface === "native"
				? editing
					? "repository.edit"
					: "repository.read"
				: requirement.surface,
		);
		for (const id of ["read", "ls", "find", "grep", "code_search"])
			tools.add(id);
		if (
			requirement.surface !== "native" ||
			(editing && !requirement.prohibitedSurfaces.includes("workstation"))
		) {
			for (const id of [
				"open_computer",
				"close_computer",
				"exec",
				"read_execution",
				"cancel_execution",
				"write",
				"edit",
				"delete",
			])
				tools.add(id);
		} else {
			for (const id of ["clone_repo", "repo_load"]) tools.add(id);
			if (editing)
				for (const id of ["write", "edit", "repo_commit"]) tools.add(id);
		}
	}
	// A narrow read/draft may not inherit unrelated planner-selected mutations.
	if (capabilities.length === 0 && route.plannedToolIds.length > 0) {
		// An app-level grant (a connected app slug such as `sevdesk-tedix`, or
		// the aggregate alias `mcp__<app>__<tool>`) names the executor's Code
		// Mode on that app, not a tool the runtime can serve by name: the child
		// narrows a plan to exact native ids and `namespace.tool` callables and
		// fails the whole run on anything else. Such a delegation runs under
		// the executor's supervised ceiling instead of an unsatisfiable plan.
		if (route.plannedToolIds.some((id) => isAppLevelGrant(id, card)))
			return undefined;
		capabilities.push("planned_tools");
		for (const id of route.plannedToolIds) {
			if (id === "web_search" && !card?.webSearch) continue;
			if (id === "tedix_mcp_code" || id.startsWith("tedix_mcp_"))
				missingCapabilities.push("exact_tool_mapping");
			else tools.add(id);
		}
	}
	if (capabilities.length === 0) return undefined;
	return {
		version: "delegation-capabilities.v1",
		requiredCapabilities: capabilities,
		allowedToolIds: [...tools],
		missingCapabilities,
		urls,
		outputIds,
	};
}
