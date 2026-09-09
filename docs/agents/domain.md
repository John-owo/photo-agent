# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Configured layout: **single-context**.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terms or decisions actually get resolved.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept, use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, reconsider whether the term belongs to the project or note the gap for `/domain-modeling`.

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007, but worth reopening because..._

## Decision evidence and current version

The accepted ADRs describe architecture and intended release sequence; they do
not establish implementation, test, merge or publication status. In particular,
ADR 0005/0006 planned a `0.1.0-alpha.N` version sequence, while the checkouts
inspected on 2026-09-05 still declare `0.3.0-alpha.0`. Record that mismatch; do
not change the package version, rewrite the historical tag, close/merge a PR,
or claim those migration steps completed as part of a documentation task.
Follow AGENTS.md for current-state routing and exact-commit evidence.
