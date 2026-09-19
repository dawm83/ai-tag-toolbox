# Unified Tag Library — Execution Ledger

Plan: docs/superpowers/plans/2026-09-19-unified-tag-library.md
Spec: docs/superpowers/specs/2026-09-19-unified-tag-library-design.md

## Rulings

- Ruling: use the user-approved exact project directory, current clean tracked tree and dedicated codex/unified-tag-library branch. Native task worktree points at another project; file checkpoint provides recovery without wrong-repository work.
- Ruling: implementation is authorized, prior planning-only status is superseded; no true user data migration until app first opens verified new build.
- Ruling: base catalog may preserve noneditable metadataById and characterInfo so heat/model indices/role fallback metadata do not disappear. Content remains solely TagRecord.
- Ruling: version stays1.4.316 during internal steps, commit milestone prefix1.4.317; bump all runtime versions together only at final release step.
- Ruling: test examples are acceptance shapes; meaningful tests use real modules, no clone-only tests or placeholder implementations.

## Interface preflight

| Tasks | Shared boundary | Review/ruling |
| --- | --- | --- |
| 1→2 | schema & document | repository consumes schema version; referential validation has base at library boundary |
| 1→3 | fixtures/schema/base | basic constructors first; real library harness added Task3 |
| 1→4 | legacyIds/seed | migration preserves both IDs and provenance |
| 2→3 | repository.save | resolve only durable commit; failure leaves published state unchanged |
| 3→4 | library.ready | migration produces candidate before library writable |
| 3→5 | execute/read projections | adapters share state; no independent entries |
| 3→6 | CharacterLinks | role fields project identity tag; one compound edit command |
| 3→7 | change event/revision | one index with uniform search and adult filtering |
| 4→9 | async ready | preload and UI await readiness before mutation |
| 5→9 | async facade mutations | every UI callsite awaited, no Promise-as-result |
| 6→7 | role projections | identity search obeys flags, explicit role links allowed |
| 7→9 | search/get/list | same-tag duplicates removed, browse preserves hidden-search tags |
| 8→9 | editor/location service | one mounted instance; no remaining side-editor timers |
| 3→10 | import preview/commit | same transaction, host-owned preview IDs |
| 9→10 | menus/exports | not-ready temporary dev state resolved before any delivery |
| 1→11 | seed builder pure loader | no dependency on removed legacy mutable factory |
| 9→11 | production references | legacy writing paths removed only after all consumers converted |

## Per-task consistency

| Task | Self consistency |
| --- | --- |
| 0 基线 | Scope, files and test boundary reviewed; baseline read/copy only |
| 1 schema/seed | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 2 repository | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 3 commands/library | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 4 migration | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 5 adapters | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 6 characters | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 7 search/tools | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 8 editor/location | Scope, files and test boundary reviewed; no contradictory implementation step found |
| 9 UI integration | Scope, files and test boundary reviewed; production cutover after public APIs |
| 10 transfer | Scope, files and test boundary reviewed; complete temporary transfer capability before delivery |
| 11 delivery | Scope, files and test boundary reviewed; no contradictory implementation step found |

## Progress

Task 0: complete — 306 tests both source and restored checkpoint; SHA manifest and desktop hash recorded.
Task 1: running — /root/unified_tags_seed, base ba40769; controller writing Task0 docs only.
Task 2: pending — repository
Task 3: pending — commands/library
Task 4: pending — migration
Task 5: pending — adapters
Task 6: pending — characters
Task 7: pending — search/tools
Task 8: pending — editor/location
Task 9: pending — UI integration
Task 10: pending — transfer
Task 11: pending — delivery
Task 1: review — commit27c133a; /root/unified_review_seed; 11 focused tests, npm check317 pass; actual report in .superpowers/sdd/2026-09-19-unified-tag-library/task-1-report.md.
Task 2 handoff ruling: repository.read is responsible for missing/invalid JSON/unknown schema and safe atomic file IO; complete referential validation occurs with base in TagLibrary.ready/execute. Do not invent fake base to validate repository in isolation. Read-time malformed shape must still produce INVALID_DOCUMENT.
Task 3 handoff ruling: preserve duplicate-content escape allowIndependent, explicit empty field overrides, immutable ID and both taxonomy/favorite location scopes. Batch color commands and selections must not affect current editor content revision accidentally without reporting conflict.
Task 1: fix round1 — review P1 invented characterOverrides and P2 malformed seed input Result boundary; original implementer /root/unified_tags_seed fixing. Corpus mapping approved, no unrelated seed redesign.
Task 1: complete — commits27c133a/15b93d5, reviewer PASS; 14 focused /320 total; unified base53707 tags/34122 roles/804 specific. Source mapping and exact limits verified.
Task 2: running — /root/unified_tags_repository; base15b93d5; filesystem-only task, no AppData writes.
Ruling for Task3: migrationReceipt ID maps are historical, not permanent live FK constraints. Validate target existence when migrating/importing, but later unfavorite/delete must not be blocked by old receipt; add regression and retain audit metadata.
Task 2: review — a57e22c, focused11/full331, reviewer /root/unified_review_repository. Controller identified backup allowlist omits rewrite_custom_tags/rewrite_selected; review to confirm and close before migration relies on it.
Task 2: fix round1 — required legacy backup keys missing custom_tags/selected; duplicated structural validators drifted. Original implementer refactoring shared schema export and exhaustive10-key backup tests; atomic IO path approved.
Task 2: complete — commitsa57e22c/a989888, reviewer PASS, targeted26/project332, atomic replace+backup and all10 source keys verified. Full directory metadata power-loss fsync not claimed.
Task 3: running — /root/unified_tags_commands (gpt-6-astra/high), basea989888; single authoritative commands/projections/live selections/history. No production UI cutover yet.
Task 3: review — commit0dc603e, focused44/project350 pass; reviewer /root/unified_review_commands (gpt-5.6-sol/high), review range8a21688..0dc603e. Recovery resumed2026-09-20 in exact toolbox directory; simulator untouched.
Ruling: deleted favorite structures must relocate memberships to the explicit “未分类” destination specified in design line350, not arbitrary first remaining user group — predictable organization matters; current deviation will be closed with Task3 review findings.
Task 3: fix round1 — review found wrong relocation destination and favoriteTag accepting a moving membershipId. Commit12ff246 fixes both; focused20/project353 pass; scoped re-review /root/unified_review_commands underway.
Ruling: startup recovery in Task4 must support explicit retry and validated restoration of the fixed repository backup while preserving corrupt original bytes — an error string alone does not satisfy recovery design; Task9 consumes documented host APIs, renderer never supplies paths.
Task 3: complete — commits0dc603e/12ff246; independent scoped re-review PASS; commands20 plus full353 pass. Task4 starts from12ff246.
Task 4: running — /root/unified_tags_migration (gpt-6-astra/high); migration, strict source reader, retry/fixed-backup recovery; no live user data access.
Ruling: canonical selection output owns single-tag parenthesis escaping; bundle/legacySnapshot remain byte-exact. Task6 implements the boundary, Task9 uses catalog.selected once to prevent tag/favorite projection duplication; source/editor content remains raw.
Desktop preflight2026-09-20: both1.4.315 and1.4.316 directories exist. Final packaging uses verified1.4.316 template; reconcile prior directories only at final delivery after checking live processes and backups.
Ruling: add explicit favoriteTag/duplicateTag batch variants in Task5 so multi-item copy is one candidate/save/history operation; current five-variant BatchOperation cannot express approved atomic copy. Add restoreCharacter in Task6 for atomic relation+original identity default restoration, preserving prior behavior without separate partial commits. Both are narrow schema allowlist extensions with rollback/undo tests, not arbitrary transaction callbacks.
Task 4: review —893cdea/ad0512a, focused47/full375 PASS; reviewer /root/unified_review_migration. Retry API clarified to one user-triggered attempt with no lifetime cap. Controller probe full53707 base +100 valid legacy favorites:5673ms synchronous conversion; per-row full map copies/reference checks require fix before UI cutover, not deferred to delivery.
Ruling: migration receipt records every ID actually encountered in user migration, not all bundled corpus IDs. Full immutable legacyIds mapping remains in seed+manifest. Evidence: empty source produced5,064,584 bytes /78,359 tag mappings /34,122 character mappings and407ms memory-only select. Remove duplicated corpus receipt payload to preserve overlay design and interactive performance; keep mappings of all migrated user sources and unresolved originals.
Task 4: fix round1 — reviewer confirmed threeP1: whole-corpus receipt duplication, per-row full clone/validation/search scans, and independent favorites wrongly using first bundled category质量词. Original implementer resumes with indexed/local transactional migration + final full validation, encountered-ID receipt, reusable未分类 taxonomy; benchmark0/100/10000 synthetic favorites after fix.
Task 4: complete —893cdea/ad0512a/08e3da4, independentfix re-reviewPASS; focused64/full381. Fullseed10k migration1026ms, emptyreceipt705B. P1 checkpoint223 trackedfiles captured from08e3da4 via gitarchive, SHAmanifest/check/performance logs in work/unified-tags/P1; no claim of a second restore test run.
Task 5: running —/root/unified_tags_adapters (gpt-6-astra/high), base08e3da4. Shared tag/favorite adapters, metadata/prefs and atomic copy batches; parent only QA docs/checkpoint.
Ruling: full base LibraryBundle measured33,103,267B compact /49,194,762B pretty, while32MiB file limit is33,554,432B; +10k valid user rows exceeds it. Task10 compact JSON export and optional builtin-zlib .json.gz transport preserve complete round-trip. Input file max32MiB; gzip expansion max128MiB before parse; unchanged v2 inner schema, no paths/dependencies. In-memory decoded bundle budget128MiB, raw JSON file budget32MiB. Fail before unusable export; test fullseed+10k and malformed/oversize bounds. Gzip base measured3,681,573B.
Task 5: review —4bf0331, focused45/full395,118sourcefiles. Reviewer /root/unified_review_adapters. Batch results[] returns each stable membershipId; getRecentTagIds cloned query added. saveEntry(sourceTagId/no membershipId) rejects stale shared-field mismatches; pinned/order use dedicated commands. Search/adapter projection performance remains Task7 before production cutover.
Task 5: fix round1 —review singleP2 nullable mutation inputs escaped Promise<Result>; fe8918e adds six method/commonoptions guards. Focused44/full425 passed, scoped re-review /root/unified_review_adapters pending. Parent Task6 brief includes formatter propagation to selectedText/copyText and pure UI formatter; Task8 includes new-only initialValues bundle prefill.
Task 5: complete —4bf0331/fe8918e, independent reviewPASS,44focused/final425project; shared adapters and atomic copy, argument errors verified. Task6 beginsfe8918e.
Task 6: running —/root/unified_tags_characters (gpt-6-astra/high), basefe8918e; role adapter, shared output formatter, atomic restoreCharacter. Parent onlyQA/planTask5section.
Task 6: review —5d200be, targeted135/full471,120sourcefiles; reviewer /root/unified_review_characters. Canonical role audit source solely seed.characterInfo, delayed-ready regression, atomicrestoreCharacter and sharedformatTagOutput. Parent recorded Task7 pre-index adapter baselines in scratch logs (full53707base/10kfavorites: tagwarm380ms, roleafterselect387ms, favoriteswarm84ms, select344ms).
Task 6: complete —5d200be, independentreviewPASS, targeted135/full471. Task7 running /root/unified_tags_search(gpt-6-astra/high), base5d200be; canonicalindex+queryconsumers and measured wrapper/invalidation optimization beforeproduction. Parent ownsTask6checkboxes/QAonly.
