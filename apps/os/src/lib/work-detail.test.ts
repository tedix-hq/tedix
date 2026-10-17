import { describe, expect, it } from "vite-plus/test";
import {
	plainWorkText,
	workChecklist,
	workDate,
	workDue,
	workMarkdown,
	workReminders,
} from "./work-detail";

describe("readable Work content", () => {
	it("saves checklist updates separately and ignores code examples", () => {
		const content =
			"## Steps\n- [ ] Email the team\n  - [x] Prepare notes\n\n```md\n- [ ] Example only\n```";
		const tasks = workChecklist(content);
		expect(tasks).toHaveLength(2);
		expect(
			workChecklist(content, [
				{ metadata: { workChecklist: { key: tasks[0]!.key, checked: true } } },
				{ metadata: { workChecklist: { key: tasks[0]!.key, checked: false } } },
			])[0]?.checked,
		).toBe(false);
		expect(
			workChecklist(content, [
				{ metadata: { workChecklist: { key: tasks[0]!.key, checked: true } } },
			])[0]?.checked,
		).toBe(true);
		expect(
			workChecklist(content.replace("Email the team", "Email the customer"), [
				{ metadata: { workChecklist: { key: tasks[0]!.key, checked: true } } },
			])[0]?.checked,
		).toBe(false);
	});
	it("formats prose dates while preserving destinations and code", () => {
		const url =
			"https://example.com/2026-10-28/11111111-1111-4111-8111-111111111111";
		const markdown = workMarkdown(
			`Follow-up 2026-10-28\n[Meeting](${url})\n${url}\n\`2026-10-28\`\nGmail thread: 1a10ba56c82bc95b — Team catch-up`,
		);
		expect(markdown).toContain("Follow-up Wed 28 Oct");
		expect(markdown).toContain(`[Meeting](${url})`);
		expect(markdown).toContain("`2026-10-28`");
		expect(markdown).toContain(
			"[Team catch-up](https://mail.google.com/mail/u/0/#all/1a10ba56c82bc95b)",
		);
		expect(workDate("2026-10-28")).toBe("Wed 28 Oct");
		expect(workDue("2026-10-30", new Date("2026-10-17T12:00:00"))).toBe(
			"due in 13 days",
		);
		expect(workDue("2026-10-16", new Date("2026-10-17T12:00:00"))).toBe(
			"1 day overdue",
		);
	});
	it("uses declared reminder times without inventing a time", () => {
		expect(workReminders(null, "Follow-up 2026-10-28: ask for dates")).toEqual([
			"Reminder Wed 28 Oct",
		]);
		expect(
			workReminders({ reminders: [{ at: "2026-10-28T09:00:00" }] }, ""),
		).toEqual(["Reminder Wed 28 Oct 09:00"]);
	});
	it("keeps failure reasons without run identifiers", () => {
		expect(
			plainWorkText(
				"Run 11111111-1111-4111-8111-111111111111 failed: provider timeout",
			),
		).toBe("Last run failed: provider timeout");
	});
});
