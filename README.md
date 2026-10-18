# omp-dev-mission-status

oh-my-pi footer section for observaitory + current repo dev-mission state.

Renders one line in the toolbar (rendered by `omp-footer-custom`, order 25,
own row below the `infra` row):

    obs: ● vault  ● cli · ◐ Caliber PR preview and status column
    obs: ● vault  ● cli · 0 in-prog  2 review · 17 backlog
    obs: ● vault  ● cli                   (off-repo: no package segment)

- Connection glyphs match the existing toolbar pattern (`Hindsight: ● hx`,
  `Decisions: ● dec`): `●` up (success), `◐` probing (warning),
  `○` down (error — pops at a glance).
- Repo segment: active task title wins over counts. Active package =
  newest-touched `spec.md` (mtime) among `in-progress`/`review`/`uat`/
  `ready-for-production` — recency matters because busy repos (dotfiles)
  hold several concurrent in-progress packages and list order is just
  alphabetical. Prefixed with a status glyph (`◐`/`◉`/`◆`/`▲`); falls back
  to per-status counts when nothing's active; collapses to `0 packages`
  when the repo has no dev-mission work.
- Off-repo: drops the repo segment entirely.

## Probes

- `obsidian-cli vault=<name> vault info=path` for the vault probe.
- `observaitory --version` for the CLI probe.
- `git rev-parse --show-toplevel` + `observaitory mission list --cwd <root> --json`
  for the repo probe.

All probes cached 30 s; one full probe every 6 beats (30 s cadence) keeps
the per-second cost bounded.

## Install

Linked into every omp profile by
`~/.dotfiles/dot_omp/run_link-development-repos.sh.tmpl` (runs on
`chezmoi apply`). Sessions import extensions once at start; restart to pick
up edits.

## Env

- `DEV_MISSION_OBSERVATORY_BIN` (default `observaitory` on PATH)
- `DEV_MISSION_OBSIDIAN_BIN` (default `obsidian-cli`)
- `DEV_MISSION_OBSIDIAN_VAULT` (default `Work`)