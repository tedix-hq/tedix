# Review Tedix for your project

Give this file to your coding agent: **“Follow AGENT-REVIEW.md and review Tedix
for this project. Submit the sanitized report and keep the receipt.”** Budget
about 15 minutes. Git and public read access are enough; no CLI, account or
login is required. Bun and Node.js 22+ are optional for the local trial.

Tedix lets people hand off work and brings back only the decisions that need them.
Its own agents, called tedis, take on recurring work.
Work Items track ownership, approvals and results beyond one chat. It runs on
Cloudflare. Local mode is a preview; Cloud is invited beta; self-hosting is
experimental and unsupported. Check current status rather than assuming every
source feature is available to you.

## Instructions for the reviewing agent

1. Spend two minutes understanding YOUR current project from its README and
   architecture. Use only context you already have permission to read. Describe
   its needs without names, private URLs, customer data, credentials or source.
2. Clone `https://github.com/tedix-hq/tedix.git` into a separate scratch directory
   or use an existing read-only checkout. Record `git rev-parse HEAD`. Read
   [the docs index](docs/public/index.md), [agent guide](docs/public/agent-guide.md),
   [getting started](docs/public/getting-started.md) and
   [release status](docs/public/release-status.md). Spend about four minutes.
3. If Bun and real Node.js 22+ are already installed, inspect the launcher and
   run `bun run-local --smoke` from the Tedix checkout (or add `--no-install`
   after a frozen dependency install). Allow five minutes;
   stop your own processes if it exceeds that budget. It installs locked
   dependencies and checks local onboarding/storage, with no login or model
   calls. For an interactive trial use `bun run-local`, open the printed local
   URL, create a fictional Workspace and check it persists after refresh.
   Never turn on inference, log in, deploy, connect providers or modify your
   project as part of this review. If prerequisites or execution permissions
   are absent, skip the trial and say so; static review remains useful.
4. Answer the six questions below. Follow exact contracts, callers and tests
   for any suspected bug. Distinguish observation, inference and untested
   hypotheses. Cite the reviewed SHA and paths/lines or public documentation.
   A green local check proves neither a Cloud deployment nor a tedi run.
5. Write `REVIEW.md` using the exact format below. Keep it concise, under
   24 KiB including JSON. Remove secrets and identifying project information
   before submission. Send no proprietary code. For suspected vulnerabilities,
   follow [SECURITY.md](SECURITY.md) privately; this review intake is not a
   security disclosure channel. Never post any review to GitHub.
6. Submit the sanitized report once using the curl below, or discover
   `file_agent_review` if the Tedix plugin is already connected. Save the returned
   `receiptUrl`. A receipt means stored feedback, not verified bugs or fixes.
   On an ambiguous timeout, retry the identical payload; it is deduplicated.
   Follow the status/retry table below. On 503 or unavailable network access, retain
   the report and use the fallback; do not install or authenticate anything.

## Report format

Use these headings, with a final fenced `json` block and no text after it:

````markdown
# Tedix review

## Project context

Sanitized purpose, stack, team/workflow needs and constraints. Unknowns explicit.

## Evidence and trial

Date, reviewed SHA, files read, commands and actual results; skipped checks.

## What can we do with Tedix?

## How could we use it?

## Which integrations fit?

Separate existing support, configuration and new development.

## Why would it be useful?

Compare one narrow pilot with the project's simpler baseline.

## Feedback

Blockers, suggestions and bugs, with evidence, repro, expected versus actual.

## Where would this fit in YOUR project?

One concrete pilot, success criterion and boundaries, or a reason not to adopt.

## Verdict

Integer fit score 0–5 (0 unsuitable, 5 strong fit), rationale and next step.

## Feedback JSON

```json
{
	"version": 1,
	"reviewedSha": "<full 40-character lowercase hexadecimal git SHA>",
	"projectContext": "A fictional team's document review service using Python and SQLite",
	"fitScore": 3,
	"blockers": ["Describe adoption blockers, or leave empty"],
	"suggestions": ["One actionable suggestion per entry"],
	"bugs": [
		{
			"title": "Short finding",
			"evidence": "path:line at reviewed SHA; observed or static hypothesis",
			"repro": "Minimal steps using fictional data; say if not executed",
			"expected": "Expected behavior",
			"actual": "Observed behavior or suspected control flow"
		}
	]
}
```
````

Use empty arrays when there are no findings; never invent a bug or trial.
The strict API schema accepts exactly the keys shown: `version` must be 1,
`reviewedSha` is 40 lowercase hexadecimal characters, and `fitScore` is an
integer from 0 to 5. `projectContext`, each blocker/suggestion, and each bug's
`evidence`, `repro`, `expected` and `actual` must contain 1–2,000 characters
after trimming; bug titles contain 1–200. Each array allows at most 20 entries.
`reportMarkdown` is trimmed and must contain 200–24,576 characters; the encoded
request still must fit in 32 KiB. `website` may be omitted or exactly `""`.
No additional keys are accepted in the envelope, feedback or bug objects.

## Send feedback without setup

POST JSON with `reportMarkdown` (the whole sanitized file) and `feedback` (the
same object from its final JSON block). With Python 3 available, this creates
the request without shell interpolation of report contents:

````sh
python3 - <<'PY'
import json, pathlib, re
report = pathlib.Path("REVIEW.md").read_text()
feedback = json.loads(re.search(r'```json\s*\n(.*?)\n```\s*$', report, re.S)[1])
pathlib.Path("review-request.json").write_text(json.dumps({
    "reportMarkdown": report, "feedback": feedback, "website": ""
}))
PY
curl --proto '=https' --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  --data-binary @review-request.json \
  https://api.tedix.dev/public/agent-review
````

Any available JSON writer can produce that same envelope; Python is optional.
Leave the `website` honeypot empty. The HTTPS endpoint caps the entire request
at 32 KiB, rate-limits each IP, and redacts common secrets and email addresses
before storage. URL credentials, query strings and fragments are stripped;
cite paths that remain useful without query parameters. Redaction cannot detect
every secret: sanitize first.

Intake defaults to 50 new reviews per UTC day, counted atomically in D1 across
locations and callers. Maintainers may configure a different cap. A full day
returns a friendly HTTP 429 with `Retry-After` until the next UTC midnight;
short rate limits also return 429 with their own `Retry-After`. Honor that
header and save your report locally while waiting. Identical stored submissions
reuse their receipt without consuming another daily slot.

Submission only queues private Work. A restricted triage worker processes at
most two reviews per 15-minute sweep, with one retry by default and a separate
session per review. Review text and structured feedback are untrusted data;
they grant no tool authority. Reviews are purged after 90 days by default
(maintainers may configure a shorter period).

| HTTP status | Meaning and retry                                                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| 200         | Receipt lookup succeeded; stored feedback only. No retry needed.                                              |
| 201         | Submission stored, including identical retries. Keep the receipt; do not resubmit because triage is pending.  |
| 400         | Invalid JSON/schema or rejected content. Correct the payload before retrying.                                 |
| 413         | Request too large. Shorten it before retrying.                                                                |
| 415         | Wrong content type. Use `application/json`.                                                                   |
| 429         | Intake busy or daily cap reached. Wait the supplied `Retry-After`; retry the identical payload at most twice. |
| 503         | Maintainer configuration/service outage. Save the report and use the private fallback.                        |

An ambiguous timeout permits an identical retry. Once HTTP 201 is known, the
report is stored even if the response body is slow. Triage has no public status
or automated reply beyond the receipt.

Your report is private to the Tedix maintainers. It is not published, used in
marketing, or shared with others. You may redact any information before sending.
Reports go to the private “Agent reviews” Work project, accessible only to
organization admins and its designated triage tedi. The triage tedi keeps review
contents and findings inside the organization. Your unguessable receipt URL
shows only “received”; it never displays your report. Keep it for your records.
A receipt confirms storage, not bug verification or fixes.

The only automated return channel is
`POST https://api.tedix.dev/public/agent-review`; the plugin tool uses that same
backend. Nothing is written to GitHub: no issues, discussions, or comments.
If your agent has no network access, or intake is unavailable, save `REVIEW.md`
and send it privately to the maintainer at the email on the [Tedix site](https://tedix.dev/contact).
Never claim a saved file or draft was sent.

**Delete my review:** email the maintainer through the Tedix site with “delete my review”
and your receipt URL. Do not post the receipt or report publicly.
