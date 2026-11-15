---
"@tedix/cli": patch
---

Devin lanes now find their own Tedix profile. When a workspace's shared agent profile belongs to another coding tool, the dispatcher stored the Devin lane's profile under a Devin-specific name, but the CLI inside the lane looked under the workspace name and reported "No external-agent profile is configured." Commands such as `tedix work context`, `tedix agent status` and Work comments now run under the lane's own short-lived credential, and the lane brief no longer suggests setting session variables by hand.
