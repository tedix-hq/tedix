---
"@tedix/cli": patch
---

`tedix factory` prints a failed call's own error instead of the gateway's JSON envelope. `factory status` shows `- (paused)` as the next fire of a paused factory and points to `tedix skill status <runId>` to read a run. A dry run says the next fire is set when the factory is created, and `tedix factory --help` names the guide for pausing or archiving a factory.
