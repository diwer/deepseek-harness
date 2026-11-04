# Agent Note: Session-scoped browser storage

Status: implemented

English | [中文](2026-11-04-browser-session-storage.zh.md)

## Problem

Grouping Browser storage by Workspace CWD lets unrelated DSH Sessions share site accounts and makes guest initialization depend on Workspace state. A directory is not the intended owner of a Session's browsing account, while related tabs still need shared login state.

## Decision

Desktop Browser selects storage by DSH Session identity. `browserSessionStorage(sessionId, signal)` checks cancellation and returns `session:${sessionId}` without consulting Workspace or waiting for its readiness. Tabs in one Session share the process-local account; different Sessions remain isolated even when they use the same Workspace or CWD.

This partially supersedes the Workspace/CWD storage decision in [Retained Desktop browser webviews](2026-09-20-desktop-browser-webview.md). That note continues to own the carrier, guest security, retained page lifetime and partition-owned versus page-owned state. Main still assigns random, non-persistent Electron partitions. A storage key selects sharing only; it does not authenticate a task, authorize browser automation or establish a handoff.

## Alternatives considered

**Keep Workspace/CWD grouping.** This preserves cross-Session login sharing but makes a common directory an implicit site-account group and retains an unnecessary initialization dependency.

**Use one partition per tab.** This isolates related tabs within the same Session and prevents the intended login sharing.

**Remap mounted guests.** Electron fixes the partition before first navigation. Existing guests retain their assigned partition; changing ownership does not relabel or migrate them.

## Consequences

Cross-Session workflows sign in separately; same-Session tabs share storage under normal origin rules. Fresh assignments require a Desktop restart, as described in the [upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.3/task-browser-storage/guide.md). Cookies and Web storage remain process-local and do not survive application exit; this decision adds no persistent-data migration. Web iframe behavior is unchanged.

Resolver tests pin same-Session key reuse, different-Session keys and pre-aborted initialization. They do not establish real Electron storage isolation or restart behavior; native runtime verification remains a coverage gap. No automation or handoff verification is claimed.
