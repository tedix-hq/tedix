import { expect, it } from "vite-plus/test";
import {
	checkDecisionCardCopy,
	decisionCardFallbackTitle,
	decisionCardFaceText,
	decisionCardActionLabel,
	withoutListPrefix,
	renderCardDateText,
	renderDecisionCardDates,
} from "./decision-card-copy";
const copy = {
	version: 2,
	title: "Save a task?",
	context: "The workshop is tomorrow.",
	body: "Creates a reminder.",
	recommendation: "The organizer needs a guest list.",
	generatedAt: "2026-10-19T12:00:00Z",
};
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
		"Review 07 — LOI draft and paid-maintainer offer for Ines?",
		"LOI draft and paid-maintainer offer for Ines?",
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
		context: "Ines meets you Tue 11:30; this is the offer you would bring.",
		recommendation: "Yes — no price named, nothing sent until you say so.",
	};
	expect(
		checkDecisionCardCopy({
			...face,
			title: "Review 07 — Send Ines the LOI draft?",
		}),
	).toContain("list_prefix");
	expect(
		checkDecisionCardCopy({ ...face, title: "Send Ines the LOI draft?" }),
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
