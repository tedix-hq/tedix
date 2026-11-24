---
"@tedix/cli": patch
---

Share credential exchanges across CLI processes using the same session, so concurrent commands reuse the fresh credential instead of racing to issue it.
