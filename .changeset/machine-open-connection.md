---
"@tedix/cli": minor
---

Keep one open connection from a machine to Tedix for machine tool calls where the server offers it, so a call arrives at once instead of at the next poll. The machine keeps polling when the server offers no connection or the connection drops.
