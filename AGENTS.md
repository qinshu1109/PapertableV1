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

## Verification

- Documentation-only changes: run `git diff --check` and inspect the rendered Markdown structure.
- Code changes: run `npm run verify` unless the TASK defines a narrower or stronger check.
- Do not edit generated files under `public/assets/` by hand; change `frontend/src/` and rebuild.
- Preserve unrelated user changes in the working tree. Do not commit or push unless the user explicitly requests it.
