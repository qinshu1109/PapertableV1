# PapertableV1 Agent Guide

## Project scope

- This repository is the from-scratch PapertableV1 project. Do not infer current architecture, task status, or requirements from legacy Papertable repositories, installed apps, or similarly numbered historical TASKs.
- Current repository code, user-confirmed V1 decisions, and the documents named below are the sources of truth.

## Required reading before implementation

Before planning or editing code:

1. Read `docs/REQUIREMENT-DOMAINS.md`.
2. Find the relevant active `docs/TASK-*.md` and read it completely. For implementation work, do not edit code until a TASK exists and contains all four required fields:
   - 主需求域
   - 业务接口
   - 数据真值源
   - 质量约束与验收终态
3. Read `docs/ASSEMBLY.md` when the change touches frontend/backend assembly, HTTP/SSE APIs, runtime startup, or build output.

Do not treat an old TASK as active merely because its number or topic looks related. Confirm its status and scope from the current V1 file.

## Requirement-domain rules

- Every TASK has exactly one primary requirement domain. Cross-domain work is declared through the business-interface field, not by inventing a catch-all domain.
- A business rule and its data each have one owner and one source of truth. Other domains consume them through the business interfaces defined in `docs/REQUIREMENT-DOMAINS.md`.
- Requirement domains describe user-value boundaries. They do not automatically require matching folders, packages, processes, databases, or deployments.
- If a new requirement does not fit the current domains, revise the boundary document from user value and a real scenario before writing code.

## Architecture change threshold

- Do not pre-emptively move files, split services, add factories, or create abstraction layers because a requirement domain exists.
- Refactor only the path touched by the current TASK, and only when there is concrete evidence: a duplicated business rule, multiple sources of truth, repeated cross-domain edits, or an untestable boundary.
- Prefer existing Pi capabilities, repository helpers, platform features, and installed dependencies over new Papertable-owned infrastructure.

## Documentation two-layer rule (user is non-technical)

Every `docs/TASK-*.md`, `docs/SPEC-*.md`, acceptance report, and eval report must open with two plain-language sections before any technical content:

1. **这刀是干什么的** — business intent and user journey only: what appears on screen, where the user clicks, what repeated labor is removed. No implementation vocabulary.
2. **怎么算好** — acceptance written as phenomena the user can verify on screen or in conversation (what shows up when clicking X), not as test counts.

After those two sections, technical details follow under a clear marker such as「以下给干活的看，可以跳过」. Rules:

- No unexplained English terms. When a technical term is unavoidable, attach a plain-language gloss inline (e.g. watermark（水位线兜底：程序卡住时每分钟自动补跑一次）).
- Acceptance reports lead with three plain sentences — 什么能用了 / 什么还不行 / 有什么等拍板 — then screenshots or conversation transcripts as evidence; file-change lists go last.
- Eval cases and eval reports: every case states in plain language 考什么、为什么考; reports are scorecards — 考了几道、过几道、挂的题贴出 AI 答错的原话.

## Verification

- Documentation-only changes: run `git diff --check` and inspect the rendered Markdown structure.
- Code changes: run `npm run verify` unless the TASK defines a narrower or stronger check.
- Environment caveat: the default `node` on PATH (`~/.local/bin/node`) is the ChatGPT app's bundled cua_node; its hardened signature breaks the frontend rollup native module. Run `PATH="$HOME/.local/node/bin:$PATH" npm run verify` (official Node v24.18.0) when the frontend build is involved.
- Do not edit generated files under `public/assets/` by hand; change `frontend/src/` and rebuild.
- Prompt/model changes (e.g. `SIEVE_SYSTEM_PROMPT`, `COLLAB_SYSTEM_PROMPT`, provider model config) must run `npm run eval:sieve` and attach the scorecard diff (before/after) to the acceptance report. Untested prompt changes do not ship.
- Preserve unrelated user changes in the working tree. Do not commit or push unless the user explicitly requests it.
