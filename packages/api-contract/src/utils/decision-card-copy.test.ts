import { expect, it } from "vite-plus/test";
import {
	checkDecisionCardCopy,
	decisionCardFallbackTitle,
	decisionCardFaceText,
	decisionCardActionLabel,
	withoutListPrefix,
	renderCardDateText,
	renderDecisionCardDates,
	recommendationLean,
} from "./decision-card-copy";
it("validates a short story and a separate why-me line within the displayed budget", () => {
	const face = {
		version: 2,
		title: "Keep the plan?",
		context: "Robin needs a room.",
		body: "Records your choice.",
		story: "Robin needs a room choice. Agreeing saves the plan.",
		whyMe: "You know who will attend.",
		recommendation: "Keep it because the room is available.",
	};
	expect(checkDecisionCardCopy(face)).toEqual([]);
	expect(decisionCardFaceText(face)).toContain(
		"Why you: You know who will attend.",
	);
	expect(decisionCardFaceText(face)).not.toContain("If yes:");
	expect(
		checkDecisionCardCopy({ ...face, story: "Robin needs a room." }),
	).toContain("story");
	expect(checkDecisionCardCopy({ ...face, whyMe: "" })).toContain("why_me");
	expect(
		checkDecisionCardCopy({
			...face,
			story: `Robin needs ${"a ".repeat(60)}room. Agreeing saves it.`,
		}),
	).toContain("story");
});
it.each([
	"lane",
	"executor",
	"gates",
	"private-ops trace",
	"recovery-evidence",
])("rejects internal engineering wording: %s", (term) => {
	expect(
		checkDecisionCardCopy({
			version: 2,
			title: "Review the report?",
			context: `Check the ${term}.`,
			body: "Records your review.",
			recommendation: "Wait until the report is ready.",
		}),
	).toContain("banned_words");
});
const copy = {
	version: 2,
	title: "Save a task?",
	context: "The workshop is tomorrow.",
	body: "Creates a reminder.",
	recommendation: "The organizer needs a guest list.",
	generatedAt: "2026-10-19T12:00:00Z",
};
it.each([
	"Execute",
	"Execute?",
	" run! ",
	"Send?",
	"Approve?",
	"Review 2 — Execute?",
])("rejects a bare action title: %s", (title) => {
	expect(checkDecisionCardCopy({ ...copy, title })).toContain(
		"bare_action_title",
	);
	expect(decisionCardFallbackTitle(title)).toBe("Review this request?");
	expect(decisionCardFaceText({ ...copy, title })).not.toContain(title.trim());
});
it("accepts an action that names its object", () => {
	for (const title of [
		"Execute the saved query?",
		"Send the draft to Alex?",
		"Run the submitted code?",
	])
		expect(checkDecisionCardCopy({ ...copy, title })).not.toContain(
			"bare_action_title",
		);
});
it.each([
	["2026-10-19T12:00:00Z", "tomorrow"],
	["2026-10-20T12:00:00Z", "today"],
	["2026-10-22T12:00:00Z", "2 days ago"],
])("renders the same stored date against %s", (now, expected) => {
	expect(
		renderDecisionCardDates(
			copy,
			["2026-10-20"],
			new Date(now),
			"Europe/Berlin",
		).context,
	).toBe(`The workshop is ${expected}.`);
	expect(copy.context).toBe("The workshop is tomorrow.");
});
it("uses calendar days across timezone and DST boundaries", () => {
	expect(
		renderCardDateText("Due in 2 days.", {
			generatedAt: "2026-10-24T00:00:00Z",
			dates: ["2026-10-26"],
			now: new Date("2026-10-25T23:30:00Z"),
			timeZone: "Europe/Berlin",
		}),
	).toBe("Due today.");
});
it.each(["today", "tomorrow", "yesterday", "in 2 days", "2 days ago"])(
	"drops unbound %s sentences while retaining supported copy",
	(phrase) => {
		expect(renderCardDateText(`The event is ${phrase}. Bring a charger.`)).toBe(
			"Bring a charger.",
		);
		expect(
			renderCardDateText(`The event is ${phrase}.`, {
				generatedAt: copy.generatedAt,
				dates: ["2027-01-01"],
			}),
		).toBe("");
	},
);
it("keeps absolute dates and meaningful numbers intact", () => {
	expect(renderCardDateText("Bring 2 chargers on 2026-10-20.")).toBe(
		"Bring 2 chargers on 2026-10-20.",
	);
});
it("omits unknown confidence from plain text while retaining assessed confidence", () => {
	expect(decisionCardFaceText(copy)).not.toContain("Confidence not assessed");
	expect(decisionCardFaceText(copy, 0.8)).toContain("80% sure");
});

it.each(["If yes, creates a reminder.", "If yes: If yes: creates a reminder."])(
	"labels the consequence once when the body is %j",
	(body) => {
		const text = decisionCardFaceText({ ...copy, body });
		expect(text).toContain("If yes: Creates a reminder.");
		expect(text.match(/If yes/gi)).toHaveLength(1);
	},
);

it("keeps the explicit decline even when generated button copy suggests yes", () => {
	expect(
		decisionCardActionLabel(
			{ ...copy, actionLabels: { reject: "Yes" } },
			"no",
			"reject",
			"No / Not needed",
		),
	).toBe("No / Not needed");
});

it.each([
	[
		"Review 07 — Renewal quote and support plan for Morgan?",
		"Renewal quote and support plan for Morgan?",
	],
	["Item 3: send the signed quote?", "Send the signed quote?"],
	["#4 Merge the fix?", "Merge the fix?"],
	["2) Approve the refund?", "Approve the refund?"],
	["Review 3 invoices before Friday?", "Review 3 invoices before Friday?"],
	["1.5 GB limit is fine?", "1.5 GB limit is fine?"],
	["acme-app is waiting?", "acme-app is waiting?"],
])("drops list numbers from the ask: %s", (title, expected) => {
	expect(withoutListPrefix(title)).toBe(expected);
	expect(decisionCardFallbackTitle(title, 160)).toBe(expected);
});

it("rejects generated copy that opens with a list number", () => {
	const face = {
		...copy,
		context: "Morgan meets you Thu 14:00; this is the quote you would bring.",
		recommendation: "Yes — no price named, nothing sent until you say so.",
	};
	expect(
		checkDecisionCardCopy({
			...face,
			title: "Review 07 — Send Morgan the renewal quote?",
		}),
	).toContain("list_prefix");
	expect(
		checkDecisionCardCopy({ ...face, title: "Send Morgan the renewal quote?" }),
	).not.toContain("list_prefix");
});

it("never lets a decline read as agreement, whatever its fallback label", () => {
	expect(
		decisionCardActionLabel(
			{ ...copy, actionLabels: { reject: "Approve anyway" } },
			"no",
			"reject",
			"Decline",
		),
	).toBe("Decline");
});

it("uses the supplied short no label for a decline", () => {
	expect(
		decisionCardActionLabel(
			{ ...copy, actionLabels: { reject: "Make public" } },
			"no",
			"reject",
			"No / Not needed",
		),
	).toBe("Make public");
});

it("formats stored ISO deadlines across every face field without changing source dates", () => {
	const source = {
		...copy,
		context: "Review by 2026-11-14.",
		actionLabels: { approve: "Review 2026-11-14" },
	};
	const rendered = renderDecisionCardDates(
		source,
		["2026-11-14"],
		new Date("2026-10-21T12:00:00Z"),
		"Europe/Berlin",
	);
	expect(rendered.context).toBe("Review by Nov 14, 2026.");
	expect(rendered.actionLabels.approve).toBe("Review Nov 14, 2026");
	expect(source.context).toBe("Review by 2026-11-14.");
});

it("rejects a face that tells the person how to answer the card", () => {
	expect(
		checkDecisionCardCopy({
			...copy,
			body: "Open this Work item and click Reply on this Needs-you card.",
		}),
	).toContain("agent_addressed");
	expect(checkDecisionCardCopy(copy)).not.toContain("agent_addressed");
});

it.each([
	["Wait — the source does not confirm the dates arrived.", "later"],
	["I recommend: hold until the terms are signed.", "later"],
	["No — the price is not agreed.", "reject"],
	["Don't send it; the draft names the wrong person.", "reject"],
	["No need to wait — approve it.", null],
	["Yes — nothing is sent until you say so.", null],
])("recommendationLean(%j)", (text, lean) => {
	expect(recommendationLean(text)).toBe(lean);
});
