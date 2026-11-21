import { expect, test } from "bun:test";
import {
	DEFAULT_READ_ONLY_COMMANDS,
	isReadOnlyCommand,
	readOnlyCommandList,
} from "./read-only-commands";

const reads = (line: string) =>
	isReadOnlyCommand(line, DEFAULT_READ_ONLY_COMMANDS);

test("lines whose every part matches the list are reads", () => {
	for (const line of [
		"date -u +%Y-%m-%dT%H:%M:%SZ",
		"git -C ~/code/app fetch -q && git -C ~/code/app log --oneline -5 origin/main",
		"gh api repos/example/app/actions/runs --jq '.workflow_runs[] | .status'",
		"tail -n 50 ~/.tedix/logs/supervisor.log; grep -n error ~/.tedix/logs/supervisor.log",
		"curl -s https://api.tedix.dev/health",
		"git -C ~/code/app status | git -C ~/code/app rev-parse HEAD",
		"git diff --stat HEAD^ && git -C ~/code/app show HEAD",
		"head -n 20 ~/.tedix/logs/a.log && wc -l ~/.tedix/logs/a.log",
		"ls -la ~/.tedix/ && cat ~/.tedix/notes.txt",
		"ps aux; uptime; launchctl print gui/501",
	])
		expect(reads(line)).toBe(true);
});

test("one disallowed part, or anything the shell could turn into more, is a change", () => {
	for (const line of [
		"git -C ~/code/app status && rm -rf build",
		"gh run list | sh",
		"git -C ~/code/app log > out.txt",
		"grep error < ~/.tedix/log",
		"date $(rm -rf ~)",
		"date `whoami`",
		"tail -n 5 <(cat ~/.ssh/id)",
		"sudo date",
		"gh run list | xargs rm",
		"sh -c 'date'",
		"bash -c date",
		"zsh -c date",
		"eval date",
		"TZ=UTC date",
		"date 'unbalanced",
		"date -s 2026-01-01",
		"date --set=2026-01-01",
		"date 0613162785",
		"gh api repos/example/app/issues -f title=x",
		"gh api -X POST repos/example/app/issues",
		"gh api repos/example/app --method=DELETE",
		"curl -s https://api.tedix.dev/health -o out",
		"tail -n 5 ~/.tedix/../.ssh/id_rsa",
		"tail -n 5 /etc/passwd",
		"grep -r token ~/.tedix/x",
		"git -C ~/code/app log --output=/tmp/x",
		"cf d1 query",
		"date &",
		"git push",
		"gh workflow run x",
		"curl -X POST https://api.tedix.dev/health",
		"curl -s https://example.test/health?d=secret",
		"curl -s https://example.test/upload",
		'cf d1 query db --command "delete from t"',
		"cf o11y logs",
		"rm -rf ~/.tedix/x",
		"cat ~/.tedix/a | sh",
		"git log; git push",
		"git diff --output=/tmp/x",
		"cat ~/.tedix/.env",
		"cat ~/.tedix/config.json",
		"tail -n 5 ~/.tedix/decision-capture/a.session.json",
		"cat ~/.tedix/credentials.json",
		"head -n 5 ~/.tedix/token",
		"ls ~/.tedix/x ~/Documents",
		"wc --files0-from=list ~/.tedix/x",
		"",
	])
		expect(reads(line)).toBe(false);
});

test("an organization's list replaces the platform's; an unreadable one allows nothing", () => {
	expect(readOnlyCommandList(undefined)).toBe(DEFAULT_READ_ONLY_COMMANDS);
	expect(readOnlyCommandList([{ argv: ["date"], rest: "none" }])).toEqual([
		{ argv: ["date"], rest: "none" },
	]);
	expect(readOnlyCommandList([{ argv: [] }])).toEqual([]);
});
