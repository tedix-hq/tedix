# `@tedix/tsconfig`

Shared TypeScript 7 configuration for the workspace.

The base profile deliberately enables strict checking, rejects unresolved
side-effect-only imports, and starts with no ambient `@types` packages. Projects
that need globals must declare them explicitly in `compilerOptions.types`.

The Cloudflare profile owns Worker compiler settings. Consumers that compile
JSX declare their framework import source in `compilerOptions.jsxImportSource`
and own the corresponding runtime dependency.

TypeScript 7 does not expose the legacy compiler API, and it ships no
source-text parser at all: `typescript/unstable/ast` is an AST and visitor
library, and the one route to a `SourceFile` — `typescript/unstable/sync` —
spawns the Go server over a channel Bun cannot open. Runtime utilities that
need AST access therefore parse with `oxc-parser` through the shared helpers in
`scripts/oxc-ast.ts`, which is the same parser `vp lint` and `vp fmt` already
run on. Normal type-checking and editor workflows continue to use the workspace
`typescript` package and its `tsc` 7 binary.
