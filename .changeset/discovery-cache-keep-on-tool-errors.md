---
"@tedix/cli": patch
---

A failed tool call no longer clears the saved gateway discovery answer unless the failure shows the gateway's protocol changed. Commands such as `tedix ask` stop paying an extra 1-2 s discovery round trip after an unrelated error in another `tedix` process on the same machine.
