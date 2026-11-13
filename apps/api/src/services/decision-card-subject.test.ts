import { expect, it } from "vite-plus/test";
import { nextStepCard, subjectIssues } from "./decision-card-subject";

it("checks the visible story for the affected person and false ownership", () => {
	const source = { name: "Morgan", isReader: false, sensitive: true };
	const face = {
		title: "Review the account?",
		context: "Morgan needs an account review.",
		body: "Records the choice.",
		recommendation: "Review it first.",
		story: "Your account needs a review. Agreeing changes your role.",
	};
	expect(subjectIssues(face, source)).toEqual([
		"subject_missing",
		"subject_not_reader",
	]);
	expect(
		subjectIssues(
			{
				...face,
				story:
					"Morgan needs an account review. Agreeing changes Morgan's role.",
			},
			source,
		),
	).toEqual([]);
});

const card = (subject: string, prompt = "") =>
	nextStepCard({ subject, prompt, metadata: {} });

it("treats an access grant as consent, not every use of authorize", () => {
	expect(card("Authorize read access for Devin in the consent tab")).toBe(
		"consent",
	);
	expect(card("Sign in again", "Waiting for the owner's consent.")).toBe(
		"consent",
	);
	// A go-ahead on ordinary work performs no access step.
	expect(card("Authorize following up with Morgan about dates?")).toBeNull();
});
