---
"@tedix/cli": patch
---

Keep a stored login renewable when a refresh fails before any connection opens, for example offline right after the Mac wakes, a DNS failure or a refused connection. Such a refresh reaches no server, so it no longer asks for `tedix login`. Lane serve also stops counting a cited commit that was already in the lane's starting point as that lane's landed result.
