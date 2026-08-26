# Backlog

Freeform list of work for the planner to pick from. One item per bullet is
the simplest shape, but write as much detail as the task needs — the planner
copies your intent into each implementer's instructions verbatim, so vague
bullets produce vague implementations.

Only items that don't touch the same files as another chosen item get
parallelized (there's no merge step, so overlapping changes would just
conflict silently across branches) — the planner decides which subset is
safe to run together, not you.

- Example: add a `--version` flag to the CLI that prints the package version
- Example: add a `LICENSE` file (MIT, current year, your name)

Delete the examples above and replace with your own backlog before running
the planner.
