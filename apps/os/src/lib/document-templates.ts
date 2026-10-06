import type {
	OsDocumentBlock,
	OsOutputContent,
} from "@tedix/api-contract/schemas/os-workspaces";

export const documentTemplates = [
	{
		id: "blank",
		name: "Blank document",
		description: "Start with an empty page.",
	},
	{
		id: "close-plan",
		name: "Accountancy close plan",
		description: "Summarize the situation, missing evidence, and next actions.",
	},
	{
		id: "reconciliation",
		name: "Reconciliation memo",
		description:
			"Compare records and explain differences without assuming a match.",
	},
	{
		id: "monthly-close",
		name: "Monthly close report",
		description:
			"Record coverage, open issues, and the decision for one period.",
	},
] as const;
export type DocumentTemplateId = (typeof documentTemplates)[number]["id"];

const heading = (text: string): OsDocumentBlock => ({
	type: "heading",
	level: 2,
	text,
});
const paragraph = (text: string): OsDocumentBlock => ({
	type: "paragraph",
	text,
});

export function documentFromTemplate(
	id: DocumentTemplateId,
	title: string,
): OsOutputContent {
	const blocks: OsDocumentBlock[] =
		id === "blank" ? [] : [{ type: "heading", level: 1, text: title }];
	if (id === "close-plan")
		blocks.push(
			heading("Where we stand"),
			paragraph(
				"Period: [add period]. Prepared by: [name]. Last reviewed: [date].",
			),
			paragraph(
				"Draft plan. Record what has been verified and what is still unresolved before making a close decision.",
			),
			heading("Your next actions"),
			{
				type: "list",
				ordered: true,
				items: [
					"[Action] — Owner: [name]. Evidence needed: [document or answer]. Work item: [link].",
					"[Action] — Owner: [name]. Evidence needed: [document or answer]. Work item: [link].",
				],
			},
			heading("Evidence and source records"),
			paragraph(
				"Link the working register, original documents, bank statements, and bookkeeping records. Note the coverage and review date for each source.",
			),
			heading("Open decisions"),
			paragraph(
				"List unresolved business use, allocation, reimbursement, booking, and currency questions separately. Identify who can answer each question.",
			),
			heading("Close criteria"),
			paragraph(
				"Specify the checks, remaining evidence, and responsible reviewer needed to conclude the period. Track execution in Work.",
			),
		);
	if (id === "reconciliation")
		blocks.push(
			heading("Scope and sources"),
			paragraph(
				"Period: [add period]. Source records: [links]. Statement coverage: [opening date] to [closing date]. Reviewed by: [name].",
			),
			heading("Comparison"),
			paragraph(
				"Record each source reference, date, amount, and currency. Explain the evidence for each proposed match; an equal amount alone is not a confirmed match.",
			),
			heading("Differences and missing evidence"),
			paragraph(
				"Describe unmatched transactions, missing invoices or credits, timing differences, fees, and foreign-currency valuation separately.",
			),
			heading("Treatment and next actions"),
			paragraph(
				"For each issue, record proposed treatment, business allocation, reimbursement state, booking state, owner, and linked Work item. Mark unconfirmed decisions explicitly.",
			),
			heading("Conclusion"),
			paragraph(
				"State the checks performed and unresolved limitations. Add reviewer and review date when available; do not infer closure from a matched payment.",
			),
		);
	if (id === "monthly-close")
		blocks.push(
			heading("Period and review"),
			paragraph(
				"Month: [month and year]. Prepared by: [name]. Reviewed by: [name or pending]. Review date: [date or pending].",
			),
			heading("Coverage"),
			paragraph(
				"List the bank accounts, statements, invoices, credits, and bookkeeping records included. Record opening and closing balance evidence and any missing coverage.",
			),
			heading("Checks and findings"),
			{
				type: "list",
				ordered: false,
				items: [
					"Bank reconciliation: [status and evidence].",
					"Income and expense documents: [status and evidence].",
					"Partner-paid expenses and reimbursements: [status and evidence].",
					"Currency, tax, and allocation decisions: [status and evidence].",
					"Bookkeeping entries and review: [status and evidence].",
				],
			},
			heading("Outstanding work"),
			paragraph(
				"Link each unresolved issue to a Work item with its owner and required evidence.",
			),
			heading("Close decision"),
			paragraph(
				"Status: not assessed. Record the decision, remaining qualifications, responsible reviewer, and supporting evidence. Creating this report does not close the books.",
			),
		);
	return { kind: "document", blocks };
}
