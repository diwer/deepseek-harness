---
kind: upgrade-guide
description: "Desktop Browser site storage is shared within one DSH Session instead of across Sessions using the same Workspace directory."
---

# Desktop Browser storage is scoped to each Session

English | [中文](guide.zh.md)

## Change

Desktop Browser previously shared cookies and origin storage across Sessions whose Workspaces resolved to the same canonical CWD. It now shares a process-local partition only between tabs in one DSH Session. Different Sessions remain isolated even when they use the same Workspace or directory; selecting storage no longer waits for Workspace readiness. Web iframe behavior is unchanged.

This changes storage sharing only. It adds no task authorization, browser automation or handoff capability. Mounted guests keep their existing partition; the update neither relabels them nor migrates their site data.

## Migration

1. Finish or save any work in open Desktop Browser pages, then install the updated Desktop build and fully quit and restart Desktop. A page reload is not a substitute for restarting to establish fresh partition assignments. Cookies and Web storage were already process-local and did not survive application restart; this update adds no persistent-cookie migration.
2. Restore the Browser tabs you need and sign in separately in each Session. If you need related tabs to share a site's login state, open them in the same Session rather than relying on a shared Workspace or CWD. No profile or settings change is required.
3. To confirm the new sharing, sign in to a site in one Browser tab, then open the same site in another tab in that Session and confirm the login is shared. Open the site in a second Session using the same Workspace and confirm it starts without the first Session's login. Normal origin rules still apply; page-owned state such as sessionStorage is not shared between tabs.
