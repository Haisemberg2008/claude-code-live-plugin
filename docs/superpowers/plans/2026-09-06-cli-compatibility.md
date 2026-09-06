# Claude Code Live Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Claude Code Live reproducibly valid, version-aware, and safely smoke-tested in a disposable workspace.

**Architecture:** Keep the plugin bundle as the canonical artifact. Add a self-contained validation runner, make the local executor feature-aware before launching Claude, and document only guarantees that the installed CLI can verify.

**Tech Stack:** PowerShell 7, Python 3, Claude Code CLI, Codex plugin and skill validators.

**Spec:** User request to correct all documentation, skill, and plugin issues identified in the audit.

## Global Constraints

- Do not authenticate, send prompts, create a cloud session, or expose secrets during smoke testing.
- Keep the source bundle and installed plugin synchronized only after validation passes.
- Do not claim operating-system sandboxing.

---

### Task 1: Reproducible validation

**Files:**
- Create: `outputs/claude-code-live/scripts/validate.ps1`
- Modify: `outputs/claude-code-live/README.md`
- Test: `work/tests/validate-plugin.ps1`

- [ ] Write a test that fails when the validation runner cannot find a Python runtime with YAML support.
- [ ] Run it and verify the current documentation-only flow fails in the standard terminal.
- [ ] Implement a runner that finds an available Python runtime, explains a missing dependency without installing it, and invokes both validators.
- [ ] Run the test and then validate the bundle.

### Task 2: CLI compatibility guard

**Files:**
- Modify: `outputs/claude-code-live/skills/claude-code-live/scripts/run-live.ps1`
- Modify: `outputs/claude-code-live/skills/claude-code-live/references/local.md`
- Test: `work/tests/cli-compatibility.ps1`

- [ ] Write a test that fails when a required local-execution option is unavailable.
- [ ] Implement a help-based preflight that stops before running a prompt and reports an actionable compatibility failure.
- [ ] Document the documented permission controls and clarify the limits of restricted mode.
- [ ] Run the compatibility test and PowerShell parser validation.

### Task 3: Documented smoke validation and release

**Files:**
- Create: `outputs/claude-code-live/scripts/smoke-test.ps1`
- Modify: `outputs/claude-code-live/README.md`
- Modify: `outputs/claude-code-live/skills/claude-code-live/references/cloud.md`
- Test: `work/tests/smoke-test.ps1`

- [ ] Write tests for non-authenticated CLI, parser, bundle, and documentation checks.
- [ ] Implement a smoke script that never starts a Claude session or cloud task.
- [ ] Run all checks, update the plugin cache version, reinstall, and validate the installed copy.
