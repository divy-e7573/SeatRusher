# Architecture Decision Records

An ADR captures a decision that was **not obvious**, together with the reasoning and
the consequences we accepted. Later ADRs supersede earlier ones; nothing here is
rewritten, so the history of how the design evolved stays visible.

## Format

Each file is `NNNN-short-kebab-title.md` and contains:

1. **Status** - Proposed / Accepted / Superseded by ADR NNNN.
2. **Context** - the forces that made a decision necessary.
3. **Decision** - what we chose, in the present tense.
4. **Consequences** - what becomes easier, what becomes harder, what we accept as risk.

## Index

| #                                                | Title                                               | Status   | Phase |
| ------------------------------------------------ | --------------------------------------------------- | -------- | ----- |
| [0001](0001-stack-and-foundation-choices.md)     | Stack and foundation choices                        | Accepted | 0     |
| [0002](0002-database-schema-and-unique-index.md) | Database schema and the double-booking unique index | Accepted | 1     |
| [0003](0003-authentication.md)                   | Authentication design                               | Accepted | 2     |

## When to write one

Write an ADR when a decision would be hard to justify in a code review alone:
concurrency and locking strategy, transaction isolation level, cache invalidation,
ORM choice, or anything that constrains a later phase.
@@
| [0003](0003-authentication.md) | Authentication design | Accepted | 2 |
| [0004](0004-seat-hold-locking-strategy.md) | Seat-hold locking strategy | Accepted | 3 |
