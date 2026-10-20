/** A project-scoped closeout request, excluding terminal metadata and quoted briefs. */
export function delegatedCloseoutProjects(content: string): string[] {
	const request = (
		content.split(/\n\nLocal terminal context:\n- cwd: |\bBrief:\s*/i, 1)[0] ??
		""
	)
		.replace(/```[\s\S]*?```/g, "")
		.replace(/^\s*>.*$/gm, "");
	if (
		!/\bWork\b/i.test(request) ||
		!/\b(?:backlog|hygiene|closeout)\b/i.test(request) ||
		!/(?:^|[.!?:]\s*)(?:please\s+)?mark\b[^.!?\n]{0,60}\bcompleted\b/i.test(
			request,
		) ||
		/\b(?:read[- ]only|no\s+Work\s+(?:writes|mutations)|(?:never|do\s+not|don't|must\s+not)\s+(?:mark|close|complete))\b/i.test(
			request,
		) ||
		!/\bclosing\s+comment\b/i.test(request)
	)
		return [];
	return [
		...new Set(
			[
				...request.matchAll(
					/\bproject\s+([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\b/gi,
				),
			].map((match) => match[1]!.toLowerCase()),
		),
	];
}

export function closeoutRequiresHuman(askForClasses: string[] = []): boolean {
	return askForClasses.some(
		(value) =>
			value === "*" ||
			value === "native:close_completed_work_item" ||
			/(?:[:.]|__)(?:add_comment|work_item_comment|complete_work_item)$/.test(
				value,
			),
	);
}
