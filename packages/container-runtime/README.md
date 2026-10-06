# `@tedix/container-runtime`

Shared app-owned process and file primitives for Cloudflare Sandbox v1.

The package does not own a Worker or Durable Object namespace. Each consuming
Worker extends `NativeContainerSandbox`, supplies its own container image and
startup policy, and exposes only the RPC methods its application needs. Native
`ctx.container` owns container lifecycle; Tedix adds durable logical process
identity, bounded retained output, and filesystem helpers.
