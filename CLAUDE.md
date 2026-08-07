# MBO Tracker

## Project

MBO Tracker is an active software project.

## Working Rule

Before making significant changes:

1. Inspect the existing code.
2. Understand the current architecture.
3. Check relevant project documentation.
4. Avoid unnecessary changes.
5. Preserve existing functionality.
6. Never expose secrets or credentials.

## Development

When working on this project:

- Explain important architectural changes before implementing them.
- Prefer modifying existing code over unnecessarily creating new systems.
- Keep changes focused.
- Check for existing utilities and services before duplicating functionality.

## Obsidian Second Brain

The live Obsidian knowledge base for this project is at:

`C:\KNOWLEDGE BASE\01 Projects\Active\MBO_Tracker`

This is the authoritative source of project context. Do not create copies of it.

### Notes

| File | Contains |
|---|---|
| `Overview.md` | Purpose, tech stack, status, blockers |
| `Current State.md` | Current objective, what works, risks, where we left off |
| `Architecture.md` | System diagram, components, data flow, constraints |
| `Roadmap.md` | Phases, priorities, future and rejected ideas |
| `Decisions.md` | Important technical/product decisions and reasoning |
| `Bugs & Issues.md` | Discovered, investigated, and resolved bugs |
| `Experiments.md` | Experiments, benchmarks, investigations |
| `Research.md` | Research findings worth retaining |

### Before Significant Work

Read the relevant notes before starting meaningful implementation, debugging, or architectural work. At minimum read `Current State.md` and the note most relevant to the task.

### Proactive Updates — Do Not Wait to Be Asked

After meaningful work, update the relevant note without being prompted. Apply these rules:

- **`Current State.md`** — when status, progress, blockers, or next steps change.
- **`Architecture.md`** — when architecture, components, data flow, infrastructure, or dependencies change.
- **`Decisions.md`** — when an important technical or product decision is made; always include the reasoning and alternatives considered.
- **`Bugs & Issues.md`** — when a significant bug is discovered, investigated, or fixed.
- **`Roadmap.md`** — when priorities or planned work change.
- **`Research.md`** — for research or findings that should be retained beyond this session.
- **`Experiments.md`** — for experiments, benchmarks, or investigations worth remembering.

### Rules

- Keep notes concise and factual.
- Do not duplicate code or reproduce large file contents into Obsidian.
- Do not modify notes unnecessarily — only update when something meaningful changed.
- Never invent project facts. If something is uncertain, inspect the code or mark it as unknown.
- Preserve existing Obsidian structure and `[[wiki links]]`.