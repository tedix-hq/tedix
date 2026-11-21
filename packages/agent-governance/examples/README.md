# Offline change verification

Internal preparation for a portable change-record profile. Nothing here
publishes a package or transfers contribution rights.

`valid.json` and `invalid.json` are DSSE envelopes containing language-neutral
JSON. `statement.json` is the decoded valid payload for inspection. All three
use fictional data. `public-key.spki` is base64 Ed25519 SPKI DER; its example
private key was discarded. This key establishes fixture integrity only.

Copy this directory anywhere outside the repository, then use Node 26.13 or
later. The verifier needs only Node built-ins, no installation or Tedix code:

```sh
node --permission --allow-fs-read=. verify-change.mjs valid.json public-key.spki
# VALID change-record/example-change-1 (exit 0)
node --permission --allow-fs-read=. verify-change.mjs invalid.json public-key.spki
# INVALID: Signature verification failed (exit 1)
```

These permissions grant file reads only. Network, child processes, workers,
native addons and file writes remain denied. `invalid.json` changes the
record's outcome but retains the original signature. Neither file authorizes
an action. The caller must obtain the trusted public key independently; an
envelope's unauthenticated `keyid` never chooses the trusted key.

## Profile

`changeStatement(record)` builds an
[in-toto Statement v1](https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md).
Its subject is the immutable change record, named `change-record/<id>`.
The SHA-256 digest uses the existing record format: sorted-key JSON of the
record with `sequence`, `recordDigest` and `chainHash` omitted. Those fields
describe ledger placement; this statement does not verify a ledger chain.
Use the existing checkpoint verifier when chain membership matters.

The predicate type is `https://tedix.dev/attestations/change-record/v1`.
`predicate.record` retains the captured record; the other fields project its
actor, cause (operation, source, task and parent), approval, environment and
time. The verifier checks both the signature and these projections against
the record. It uses the authenticated payload bytes directly, with the
[DSSE pre-authentication encoding](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md).
`signStatement` reuses the existing checkpoint signer and Ed25519 keys.
There is no new signing service, log or production integration.

`ChangeContent` accepts ledger records and gateway execution captures. A
capture may lack a ledger sequence or gate evaluation; neither is invented.
A successful call receipt can establish execution, but does not expose the
policy decision, approval route or delegated principal. Capture signatures
attest the capturer's account of an event, not platform audit provenance.
The real gateway event and its valid/invalid captures belong in the matching
internal Work evidence, alongside the original receipt. Keep live account
and resource identifiers out of these checked-in examples.

## Field map

| Field           | Mapping or remaining gap                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subject kind    | `subjectKind: change_record`; `record.resource` identifies the affected resource. The subject digest identifies the record, not the mutable resource. |
| Actor           | `actor` copies the recorded principal and kind.                                                                                                       |
| On behalf of    | Open: records do not capture the delegated principal. `onBehalfOf` is null.                                                                           |
| Task            | `cause.task` copies `record.subject`; absent links are open with a reason.                                                                            |
| Parent          | `cause.parent` copies captured run/root/record links; absent links are open.                                                                          |
| Approval        | Copied when captured; otherwise null and open. An allow verdict alone does not establish human approval.                                              |
| Environment     | Captured fields only. An absent environment is open. Harness facts do not prove the deployed product revision or model.                               |
| Policy version  | `environment.policyDigest` or `approval.policy.revisionId`; open when neither was captured. A digest identifies rules, not a tenant revision.         |
| Time            | `time.recordedAt` copies recorder time. Trusted time remains open: there is no independent timestamp authority receipt.                               |
| Gate evaluation | Retained in the record when available; open for execution receipts that do not expose it.                                                             |

Every absent field above is listed in the signed `openFields` with its reason.
A signature proves integrity under a supplied key; it does not prove the
event's truth, authority, time, completeness, or successful downstream effects.

## Build the portable modules

Copy `standalone/package.json` as `package.json`, `tsconfig.build.json` and
`src/{record,seal,evidence,hash,types}.ts` into an independent directory.
The extraction manifest has no workspace or catalog dependency versions.
The build config is self-contained and the modules have no runtime dependencies.
With TypeScript 7.0.2 installed, run:

```sh
tsc -p tsconfig.build.json
```

This emits runnable ESM and declarations for `record`, `seal`, `evidence`
and their local `hash`/`types` dependencies into `dist/`. Tests and unrelated
governance modules are outside this build. The package's normal type check
still covers all its source modules. The workspace manifest and normal
`tsconfig.json` retain the repository's shared development tooling; neither
is needed by the extracted modules.
