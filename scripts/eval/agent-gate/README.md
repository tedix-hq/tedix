# Agent evaluation gate

This small promptfoo gate evaluates Tedix's actual prompt-context lesson
selector, which supplies instructions to local coding agents. promptfoo is
used because its custom provider, exact-output assertions, repeat option and
CLI exit status fit this bounded check without an experiment tracking server.
The tool version is pinned to 0.126.0 in `run.ts`.

Nine cases come from the task shapes in
`packages/cli/src/hooks/lesson-selection.test.ts`: numbered release targets,
short database names, misleading branch context, short requests with a Work
title, and UTF-8 context limits. All names and instructions are fictional.
No organization memory, customer prompts, credentials or live tools are read.

Run from the repository root after `bun install --frozen-lockfile`:

```sh
bun scripts/eval/agent-gate/run.ts check
bun test scripts/eval/agent-gate/gate.test.ts scripts/eval/agent-gate/metrics.test.ts
bunx tsc -p scripts/eval/agent-gate/tsconfig.json --noEmit
```

The first command invokes promptfoo against production source, three times per
case, with caching disabled. The stored `baseline.json` is a real 27-trial run.
Any case with fewer passes than its baseline fails with exit 1. Assertion
failures also fail even if a baseline were lowered. Missing/extra trials,
provider errors and changed case fingerprints fail closed. The runner never
updates a baseline during a check. Raw promptfoo exports and the latest summary
are working buffers under ignored `.runs/`.

The existing scripts test discovery includes `gate.test.ts`. Default CI repeats
the same production selector and exact-output scoring against the frozen
baseline without downloading promptfoo or making model calls. The explicit
promptfoo command also makes zero model calls: its custom provider runs only
the local selector. Three deterministic trials check repeatability, not model
variance or statistical confidence. This gate measures instruction selection;
it does not measure generated answers or certify all agent behavior. Future
model evaluations need separate providers and reviewed cases.

To replace a baseline, review the cases and source change first, deliberately
remove `baseline.json`, then run `bun scripts/eval/agent-gate/run.ts capture`
and inspect the generated file. Capture refuses CI, a historical provider
override, failed assertions, and overwriting an existing baseline. Commit the
baseline change separately from any attempt to repair a regression.

## Real change replay

The recorded comparison gates the real numbered-identifier fix
`f8f99f37fba68b4be93b02683c26d06006af87fa`. Its selector is still used by
`packages/cli/src/hooks/prompt-context.ts`. The fixed selector passes all 27
trials. Its pre-fix parent can be replayed without editing production source:

```sh
git show f8f99f37f^:packages/cli/src/hooks/lesson-selection.ts \
  > scripts/eval/agent-gate/.historical-selector.ts
AGENT_GATE_SELECTOR="$PWD/scripts/eval/agent-gate/.historical-selector.ts" \
  bun scripts/eval/agent-gate/run.ts check
rm scripts/eval/agent-gate/.historical-selector.ts
```

This is a retrospective gate of an existing real agent change. Work comments
hold the observed pass counts, failing exit status, source revisions and
verification record; a replay is not a new deployment or a model evaluation.
