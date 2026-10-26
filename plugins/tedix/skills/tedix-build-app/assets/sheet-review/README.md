# Review cards

Copy `server.js`, `client.js` and this README into the app revision's `files`.
Pass `manifest.json` separately as `manifest`, not as a source file.

Bind the `cards` workspace resource slot to a Tedix sheet Output in the same
workspace (`providerId: tedix`, `resourceType: output`, `providerResourceId`:
the verified Output ID). The sheet has columns `ID`, `Title`, `Text`, `Topic`.
Each row needs a nonempty, unique, stable ID. Change header names, the slot,
`locale` and every visible word (`copy`) in `config.settings`; no tenant IDs,
language or wording belong in code. Workbook inputs use the
active sheet's mirrored columns and rows.

Open shows unreviewed cards; Reviewed shows saved ratings. Next rotates
the visible queue. Useful and Not useful save a verdict in synchronous
`ctx.storage.kv`, shared by this app's users. Reset asks for confirmation and
removes only `review:` keys. The source sheet is read-only. A `use` reviewer
can rate and reset; this is not a personal or audit-grade decision ledger.
Do not use it for approvals, sending, money or protected decisions.

`cards()` reads the bound Output using `env.TEDIX.outputsRead(slot, {})`.
That server response wraps content in `revision.content`; browser
`tedix.call("outputs.read", {slot})` returns the content directly instead.
`rate()` validates the verdict and checks that the ID still exists before
writing. Settings and capabilities are supplied anew for each invocation;
do not keep identity, capabilities or state in module globals.

Test loading, empty/error states, both tabs, keyboard focus, rating, reload
and reset at 375px and desktop width, including long text in the configured language. Root colour
tokens explicitly choose light mode; all buttons are at least 44px tall.
Preview uses isolated storage and cannot write resources; preview ratings do
not migrate to the committed app. Leave the result as a draft for review.
Never publish from this starter workflow.
