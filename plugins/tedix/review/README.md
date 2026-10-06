# Tedix review materials

`cases.json` is the source for the public manifest's
`extensions.com.openai.review.test_cases`: exactly five positive and three
negative cases. `release-notes.md` supplies `publication.release_notes`.
The package builder imports these two sources; this directory itself is not
part of the public ZIP. Cases are expected behaviors, **not passing results**.

The current release is **1.1.0**. Uploading a corrected
candidate does not imply review approval or publication. Imported test cases
are managed by the package and become read-only in the dashboard.

## Validation and walkthrough

1. Verify the native connection succeeds with the actual reviewer identity and
   intended organization scopes. Record connection errors before running cases.
2. Use the official business draft, the isolated reviewer and only synthetic
   Tedix Demo data. Verify the reviewer identity and Demo-only consent before
   running cases. An owner CLI read is not reviewer proof. A human enters the
   password and approves any new consent; no password belongs in this repo.
3. Run each positive prompt through the actual native connection. Discover
   current inner schemas rather than treating a fixture's descriptive tool
   label as an executable command. Record the exact returned IDs, revision,
   state, tool calls and observable result, including failures or omissions.
4. Run negative prompts as conversational refusal/fallback cases. They do not
   authorize a write-capable denial probe or a private cross-organization read.
   Any separate server-side denial test requires its own bounded authority.
5. Copy `evidence-template.json` to private operational storage. Fill actual
   evidence references, tested host, timestamp, consent boundary and ZIP hash.
   Leave unrun cases unrun; static schema checks and hook tests do not count as
   native reviewer results. Never include credentials, tokens, cookies or
   private conversations in evidence committed to the public package.
6. Record a walkthrough demonstrating the actual eight cases and first-use
   experience after they work. Hide credentials and sensitive account data.
   Check that its recording URL is accessible to reviewers without a private
   account or network. Add the real URL through the package review metadata or
   secure dashboard. Do not insert a placeholder URL or empty value that could
   clear an existing recording.
7. Check one fresh native scan after a successful reconnect. Preserve failures
   in the review report, including the affected case and observed access scope.
   Leave access and denial checks pending until their results are verified.

Reviewer access details belong in the secure dashboard Review details form,
not `plugin.json`, this directory, the public ZIP or a Ref. Country coverage
and legal attestations remain explicit publisher decisions.

## Optional local hooks

The existing SessionStart hook supports startup, resume, clear and compaction;
the UserPromptSubmit hook restores selected document revision and recent Work
comments. Both are opt-in, read-only and separate from execution authority.
The opt-in turn-status reporter (`tedix hooks status`) writes local state and,
with a configured CLI profile, a bounded status report; it grants no authority.
Every hook runs `tedix hooks <name>` in the installed Tedix CLI; the plugin
ships no scripts. Trust them through the local host before use. Web installation
cannot supply the CLI; the default cloud artifact excludes the hooks. The local artifact
includes them under the same canonical plugin identity. OpenAI supports trusted
local hooks; this artifact split reflects execution environments.

Run the offline hook and packager regressions from the repository root:

```sh
bun run --cwd packages/cli test:run src/hooks scripts/package-plugin.test.ts
```

Those tests check local hook behavior, not public native connectivity or the
eight reviewer cases.

Sources: [OpenAI submission requirements](https://developers.openai.com/plugins/deploy/submission)
and [plugin packaging and hooks](https://developers.openai.com/plugins/build/plugins).
