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
