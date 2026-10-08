import { describe, expect, it } from "vite-plus/test";
import type { RuleCandidate } from "./lesson-map-reduce";
import {
	assignRuleKeys,
	deliverableRules,
	mergeRevoked,
	renderRules,
} from "./lesson-rules";

function rule(over: Partial<RuleCandidate>): RuleCandidate {
	return {
		rule: "Commit straight to main and never open pull requests",
		subject: "git",
		eventIds: ["a"],
		sessions: ["s1", "s2"],
		repos: ["tedix"],
		newestAt: "2026-10-01T00:00:00.000Z",
		standing: true,
		...over,
	};
}

describe("assignRuleKeys", () => {
	it("keeps a key across restatements and revokes a reversed preference", () => {
		// Week 1: the person wants pull requests.
		const first = assignRuleKeys([
			rule({ rule: "Always open a pull request for every change" }),
			rule({
				rule: "Answer short and lead with the result",
				subject: "communication",
			}),
		]);
		expect(first.rules.map((r) => r.key)).toEqual([
			"git.pull-requests",
			"comms.length",
		]);
		expect(first.revoked).toEqual([]);

		// The same rule in other words keeps its key and creation time.
		const restated = assignRuleKeys(
			[
				rule({
					rule: "Open a pull request for every change",
					newestAt: "2026-10-03T00:00:00.000Z",
				}),
				first.rules[1]!,
			],
			first.rules,
		);
		expect(restated.rules[0]).toMatchObject({
			key: "git.pull-requests",
			createdAt: "2026-10-01T00:00:00.000Z",
		});
		expect(restated.revoked).toEqual([]);

		// Week 2: reversed. The newer rule takes the key; the old one is history.
		const reversed = assignRuleKeys(
			[
				rule({
					rule: "Never open pull requests; commit straight to main",
					newestAt: "2026-10-08T00:00:00.000Z",
				}),
				first.rules[1]!,
			],
			restated.rules,
		);
		expect(reversed.rules[0]).toMatchObject({
			key: "git.pull-requests",
			createdAt: "2026-10-08T00:00:00.000Z",
		});
		expect(reversed.revoked).toEqual([
			expect.objectContaining({
				key: "git.pull-requests",
				rule: "Open a pull request for every change",
				replacedBy: "Never open pull requests; commit straight to main",
				reason: "Replaced by a newer rule stated 2026-10-08",
			}),
		]);

		// Back again: both earlier wordings stay in the history, newest first.
		const back = assignRuleKeys(
			[
				rule({
					rule: "Open pull requests again for every change",
					newestAt: "2026-10-15T00:00:00.000Z",
				}),
			],
			reversed.rules,
		);
		expect(back.rules[0]!.key).toBe("git.pull-requests");
		const history = mergeRevoked(back.revoked, reversed.revoked);
		expect(history.map((h) => h.rule)).toEqual([
			"Never open pull requests; commit straight to main",
			"Answer short and lead with the result",
			"Open a pull request for every change",
		]);
	});

	it("revokes the old wording when a merge rewrote a keyed rule", () => {
		const old = rule({
			key: "coding.naming",
			rule: "Name fixture files with the zebra- prefix",
			subject: "coding",
		});
		const merged = {
			...old,
			rule: "Use the okapi- prefix for fixtures",
			newestAt: "2026-10-08T00:00:00.000Z",
		};
		const result = assignRuleKeys([merged], [old]);
		expect(result.rules[0]!.key).toBe("coding.naming");
		expect(result.revoked.map((r) => r.replacedBy)).toEqual([
			"Use the okapi- prefix for fixtures",
		]);
	});

	it("gives different decisions on one facet distinct keys", () => {
		const { rules } = assignRuleKeys([
			rule({ rule: "Push promptly after every validated change" }),
			rule({ rule: "Rebase on main before every push" }),
		]);
		expect(rules.map((r) => r.key)).toEqual([
			"git.push",
			"git.push.rebase-main",
		]);
	});
});

describe("delivery", () => {
	it("reads stored rules, deriving keys for rules stored before keys", () => {
		expect(
			deliverableRules({
				learningFeed: {
					rules: [
						{
							rule: "Commit and push promptly",
							subject: "git",
							key: "git.push",
						},
						{ rule: "Answer in plain English", subject: "communication" },
					],
				},
			}),
		).toEqual([
			{ key: "git.push", rule: "Commit and push promptly", subject: "git" },
			{
				key: "comms.plain-language",
				rule: "Answer in plain English",
				subject: "communication",
			},
		]);
	});

	it("renders rules as a short list grouped by subject", () => {
		expect(
			renderRules("How the user works:", [
				{ key: "comms.length", rule: "Answer short", subject: "communication" },
				{ key: "git.push", rule: "Push promptly", subject: "git" },
				{
					key: "comms.plain-language",
					rule: "Use plain English",
					subject: "communication",
				},
			]),
		).toBe(
			"How the user works:\n- Answers: Answer short; Use plain English\n- Git: Push promptly",
		);
	});
});
