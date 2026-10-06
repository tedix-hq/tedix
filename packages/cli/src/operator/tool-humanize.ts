/**
 * Tool-name dictionaries used by the tedix CLI live panel.
 * packages/cli/src/live-panel.ts owns namespace parsing, fallback labels
 * and display truncation; these maps provide lowercase verb phrases.
 */

/**
 * Operator-friendly verb phrases keyed by the bare (namespace-stripped) tool
 * name. Values are lowercase (CLI style).
 */
export const TOOL_VERB_MAP: Record<string, string> = {
	code: "running code",
	execute_muscle_code: "running code",
	search_threads: "searching gmail",
	list_messages: "reading gmail",
	send_email: "sending email",
	create_draft: "drafting email",
	scrape_url: "fetching page",
	crawl_url: "crawling page",
	search: "searching web",
	web_search: "searching web",
	list_invoices: "listing invoices",
	create_invoice: "creating invoice",
	get_invoice: "reading invoice",
	list_contacts: "listing contacts",
	get_contact: "reading contact",
	create_contact: "creating contact",
	list_vouchers: "listing vouchers",
	create_voucher: "creating voucher",
	search_products: "searching products",
	list_events: "listing events",
	create_event: "creating event",
	list_tasks: "listing tasks",
	create_task: "creating task",
	read_file: "reading file",
	write_file: "writing file",
	list_files: "listing files",
	run_command: "running command",
	bash: "running bash",
	computer: "using computer",
	screenshot: "taking screenshot",
	navigate: "navigating",
};

/**
 * snake_case verb prefix → present-participle form. Drives the "verb noun"
 * heuristic for tools not in `TOOL_VERB_MAP` (e.g. "list_skills" →
 * "listing skills").
 */
export const VERB_PREFIX_MAP: Record<string, string> = {
	list: "listing",
	get: "reading",
	read: "reading",
	fetch: "fetching",
	search: "searching",
	find: "finding",
	create: "creating",
	send: "sending",
	run: "running",
	execute: "running",
	write: "writing",
	update: "updating",
	delete: "deleting",
	upload: "uploading",
	download: "downloading",
	scrape: "fetching",
	crawl: "crawling",
	call: "calling",
	invoke: "calling",
	ask: "asking",
	query: "querying",
	check: "checking",
	save: "saving",
};
