import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** Local evidence for commits explicitly cited in an opted-in agent turn. */
export function referencedCommitEvidence(
	root: unknown,
	text: string,
	sourceAt: string,
): string {
	if (typeof root !== "string" || !isAbsolute(root)) return "";
	const refs = [
		...new Set(
			Array.from(
				text.matchAll(
					/(?:`|\(|\/commit\/|\b(?:commit|sha)\s+)([a-f0-9]{7,40})(?=[`),.\s]|$)/gi,
				),
				(match) => match[1]!.toLowerCase(),
			),
		),
	];
	if (!refs.length) return "";
	const asOf = Date.parse(sourceAt);
	if (!Number.isFinite(asOf)) return "";
	try {
		const git = (args: string[], input: string) =>
			execFileSync("git", ["--no-pager", "--no-replace-objects", ...args], {
				cwd: root,
				input,
				env: {
					...process.env,
					GIT_NO_LAZY_FETCH: "1",
					GIT_TERMINAL_PROMPT: "0",
				},
				encoding: "utf8",
				timeout: 1000,
				maxBuffer: 2 * 1024 * 1024,
				stdio: ["pipe", "pipe", "pipe"],
			});
		const hashes = git(
			["cat-file", "--batch-check=%(objectname) %(objecttype)"],
			refs.join("\n") + "\n",
		)
			.split("\n")
			.flatMap((line) => /^([a-f0-9]{40}) commit$/.exec(line)?.[1] ?? []);
		if (!hashes.length) return "";
		const records = git(
			[
				"log",
				"--stdin",
				"--no-walk=unsorted",
				"--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1f",
				"--name-only",
			],
			[...new Set(hashes)].join("\n") + "\n",
		);
		const evidence = records
			.split("\x1e")
			.flatMap((record) => {
				const [sha, date, subject, body, files] = record.split("\x1f");
				if (
					!sha ||
					!date ||
					!subject ||
					Date.parse(date) > asOf ||
					!Number.isFinite(Date.parse(date))
				)
					return [];
				const validation = (body ?? "")
					.split("\n")
					.filter((line) =>
						/\b(test|tests|check|lint|format|passed|verified|validation|proof)\b/i.test(
							line,
						),
					);
				const tests = (files ?? "")
					.split("\n")
					.filter((file) =>
						/(?:^|[/.\-])(test|spec|eval)(?:[/.\-]|$)/i.test(file),
					);
				return [
					`Commit ${sha} (${date}): ${subject}`,
					...validation,
					...tests.map((file) => `Changed test file: ${file}`),
				];
			})
			.join("\n");
		return evidence
			? `\n\n<agent-message from="local-git">\nReferenced local commit metadata (file changes alone do not prove tests passed):\n${evidence.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}\n</agent-message>`
			: "";
	} catch {
		return "";
	}
}
