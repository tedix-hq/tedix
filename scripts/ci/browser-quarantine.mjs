import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const policyUrl = new URL("./browser-quarantine.json", import.meta.url);
const protectedUrl = new URL("./never-quarantine.json", import.meta.url);
const day = 86_400_000;

export function validateQuarantine(entries, never, now = Date.now()) {
	const seen = new Set();
	for (const entry of entries) {
		const { testId, ownerWorkItem, createdAt, expiresAt, evidence, failure } =
			entry;
		if (
			typeof testId !== "string" ||
			!/^apps\/os\/browser-tests\/[\w-]+\.spec\.ts::[^*]+$/.test(testId)
		)
			throw new Error("Quarantine requires an exact browser case id");
		if (seen.has(testId)) throw new Error(`Duplicate quarantine: ${testId}`);
		seen.add(testId);
		if (never.some((pattern) => new RegExp(pattern, "i").test(testId)))
			throw new Error(`Never quarantine: ${testId}`);
		if (
			!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
				ownerWorkItem,
			)
		)
			throw new Error(`Missing owner Work: ${testId}`);
		const created = Date.parse(createdAt);
		const expires = Date.parse(expiresAt);
		if (
			!Number.isFinite(created) ||
			!Number.isFinite(expires) ||
			created > now ||
			expires <= created ||
			expires - created > 14 * day
		)
			throw new Error(`Quarantine must expire within 14 days: ${testId}`);
		if (expires <= now)
			throw new Error(`Expired quarantine: ${testId}; fix or remove it`);
		if (!failure?.name || !failure?.message)
			throw new Error(`Missing observed failure: ${testId}`);
		const failed = Date.parse(evidence?.failedAt);
		const passed = Date.parse(evidence?.passedAt);
		if (
			!/^[a-f0-9]{40}$/.test(evidence?.sha) ||
			!Number.isFinite(failed) ||
			!Number.isFinite(passed) ||
			passed <= failed ||
			passed > created ||
			created - failed > 2 * day
		)
			throw new Error(
				`Require failed-then-passed evidence on one SHA within 48h: ${testId}`,
			);
		for (const key of ["failedJob", "passedJob"])
			if (
				!/^https:\/\/github\.com\/tedix-hq\/tedix\/actions\/runs\/\d+\/job\/\d+$/.test(
					evidence[key],
				)
			)
				throw new Error(`Missing job evidence: ${testId}`);
		if (evidence.failedJob === evidence.passedJob)
			throw new Error(`Evidence must name different executions: ${testId}`);
	}
	return entries;
}

export function readQuarantine() {
	return validateQuarantine(
		JSON.parse(readFileSync(policyUrl, "utf8")),
		JSON.parse(readFileSync(protectedUrl, "utf8")),
	);
}

// Only the recorded failure is tolerated; a new failure in the same case blocks.
export function quarantineFailure(testId, error, entries = readQuarantine()) {
	const entry = entries.find((candidate) => candidate.testId === testId);
	if (
		!entry ||
		error?.name !== entry.failure.name ||
		error?.message !== entry.failure.message
	)
		return false;
	console.error(error);
	const note = `QUARANTINED FAIL: ${testId}; owner Work ${entry.ownerWorkItem}; expires ${entry.expiresAt}`;
	console.log(`::warning::${note}`);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${note}\n`);
	return true;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const entries = readQuarantine();
	console.log(`Validated ${entries.length} browser quarantine entries`);
}
