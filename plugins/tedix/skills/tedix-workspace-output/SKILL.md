---
name: tedix-workspace-output
description: Create or update a durable Tedix OS Workspace Output and verify its current revision. Use for a requested Tedix document, sheet, or presentation in a named Workspace, not for local files or external provider documents.
---

# Create or update a Workspace Output

Input: the CLI workspace profile or organization, the OS Workspace ID or
Output ID, the content, and the requested output kind. An Output is a durable,
revisioned deliverable, not a preview or a local file.

Tool names below describe the underlying OS operations. Discover the exact
callables under the selected organization namespace; do not assume Connect
exports a literal `os` namespace. Keep every read and write in that target.

1. Use the authenticated native plugin connection; no CLI is required. Honor
   a user-selected surface or repository CLI policy and run
   `tedix -w <workspace> auth status` only on that path. Confirm the
   organization and an authorized `os` read; do not infer write access from
   login alone. Never introduce another credential store. If the destination
   Workspace is unclear, read `os.list_os_workspaces` before asking. Paginate
   when the API reports more results; project compact candidate IDs, names,
   descriptions and status inside Code Mode so gateway truncation does not
   hide the relevant destination. Compare actual Workspace purposes with the
   authorized task. Reuse an unambiguous relevant existing Workspace and
   verify it by ID; ask only when the destination remains ambiguous. A
   similarly named project is not a Workspace, and a truncated response is
   not evidence that no suitable Workspace exists.
2. Read the exact destination with `os.get_os_workspace`. For an update, read
   `os.get_os_output` and its current revision. Discover the current schema
   with compact `discover.search` in the selected organization namespace,
   then `discover.describe(callable)` for that one operation. Use the returned
   callable and parameter schema; do not invent fields or treat discovery as
   write authorization. If `scopeMappingMissing` is true, report a gateway
   mapping defect; reauthorizing cannot repair it. If `missingScopes` is
   populated, name the missing capability and use the access-management flow.
3. For a new Output, use `os.create_os_output` with its kind, title,
   `workspaceId`, and the user-authorized content. For an assistant edit to an
   existing collaborative document, prefer
   `os.create_os_collaboration_proposal` and its review/merge flow; a proposal
   is not a committed Output revision. Do not impersonate the source identity
   that this flow requires. For an authorized direct revision, preserve the
   existing kind and body and use `os.patch_os_document`,
   `os.set_os_sheet_range`, `os.patch_os_slides`, or `os.revise_os_output` as
   appropriate, with the current revision precondition.
4. Read `os.get_os_output` after a committed write. Report the Output ID,
   Workspace ID, kind, observed revision, and what changed. If only a
   proposal was created, report its proposal state and the remaining merge
   step instead of claiming the Output changed.

If authentication or an `os` scope is missing, stop before a write and name
the missing access. With read-only access, offer the requested content as a
draft in this chat, or summarize an existing visible Output. Explain that the
draft has not been saved to Tedix and which capability would be needed to save
it; do not broaden consent or change the destination to bypass the restriction.
If the Workspace or Output is not visible, report that
exact lookup failure. On a revision conflict, re-read and reconcile instead
of replaying stale content. Never archive, delete, publish, or export as a
substitute for the requested authoring action.
