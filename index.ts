/**
 * dev-mission-status: toolbar section showing observaitory connection state
 * and the current repo's dev-mission package pipeline.
 *
 * Rendered by the omp-footer-custom renderer inside the single toolbar widget
 * (order 25, own row below the infra row):
 *
 *   obs: ● vault  ● cli · ◐ Caliber PR preview and status column
 *   obs: ● vault  ● cli · 0 in-prog  2 review · 17 backlog
 *   obs: ● vault  ● cli                   (off-repo: no package segment)
 *
 * Connection glyphs match the existing toolbar pattern (Hindsight, Decisions):
 *   ● up (success) · ◐ probing (warning) · ○ down (error).
 * Repo segment drops entirely off-repo; counts collapse to "0 packages" when
 * the repo has no dev-mission packages. Active-task title (newest-touched
 * package among in-progress/review/uat/ready-for-production, by spec.md
 * mtime) wins over counts so heads-down work is the loudest signal; title is
 * dim and prefixed with a status glyph so the loudest cue stays the
 * connection row.
 *
 * When the footer-toolbar renderer is not loaded (pi, prime-agent daemon
 * workers), falls back to its own belowEditor widget with a self-claim beat.
 *
 * Same probe discipline as the decisions extension: probing starts only once
 * a real UI is attached (headless / print mode / Task subagents never poll),
 * interval timers are session-scoped, and agent_end re-probes so the line
 * tracks real session activity. All failures degrade to dim glyphs or a
 * shorter line; nothing here may ever throw.
 *
 * Env:
 *   DEV_MISSION_OBSERVATORY_BIN   observaitory binary (default: observaitory on PATH)
 *   DEV_MISSION_OBSIDIAN_VAULT    vault name for the vault probe (default: Work)
 *   DEV_MISSION_NODE_BIN          node binary for explicit invocations (default: node)
 */

import { execFile } from "node:child_process"
import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

const execFileP = promisify(execFile)

// Renderer owns the widget; beats keep age/counts fresh; one probe per 6 beats
// (30 s at the default 5 s interval) is enough for liveness without flooding.
const PUBLISH_INTERVAL_MS = 5_000
const PROBE_EVERY_BEATS = 6
const PROBE_TIMEOUT_MS = 4_000
const ATTACH_DELAYS_MS = [0, 150, 500, 1200, 2500]
const WIDGET_KEY = "dev-mission-toolbar"

const SECTION_ID = "dev-mission"
const SECTION_ORDER = 25 // below infra row (hindsight 15 + decisions 20)

const OBSERVATORY_BIN = process.env.DEV_MISSION_OBSERVATORY_BIN?.trim() || "observaitory"
const OBSIDIAN_BIN = process.env.DEV_MISSION_OBSIDIAN_BIN?.trim() || "obsidian-cli"
const OBSIDIAN_VAULT = process.env.DEV_MISSION_OBSIDIAN_VAULT?.trim() || "Work"

interface FooterSections {
	setFooterSection: (id: string, order: number, lines: string[] | undefined, row?: string) => void
	hasFooterRenderer: () => boolean
}

// The shared module must load from the anchored ~/.omp path: relative imports
// resolve from this file's realpath (the development repo), which has no shared
// sibling. Failure leaves `sections` unset → own-widget fallback mode.
const SECTIONS_PATH = join(homedir(), ".omp", "agent", "extensions", "shared", "footer-sections.ts")
let sections: FooterSections | undefined
try {
	void import(SECTIONS_PATH)
		.then((m) => {
			sections = m as FooterSections
		})
		.catch(() => {
			// fallback widget mode
		})
} catch {
	// fallback widget mode
}

type ThemeColorName = "success" | "warning" | "dim"
type Painter = (color: ThemeColorName, text: string) => string

// Theme-colored text when pi-tui is reachable; plain text otherwise so the
// line degrades safely in headless modes.
let paint: Painter = (_color, text) => {
	return text
}
try {
	void import("@oh-my-pi/pi-tui")
		.then((m) => {
			paint = (color, text) => {
				return m.theme.fg(color, text)
			}
		})
		.catch(() => {
			// plain text fallback
		})
} catch {
	// plain text fallback
}

type ConnState = boolean | undefined // undefined = not probed yet
interface ProbeCache {
	at: number
	result: boolean
}

const CACHE_TTL_MS = 30_000 // matches PROBE_EVERY_BEATS * PUBLISH_INTERVAL_MS
let vaultCache: { at: number; root?: string } | undefined
let cliCache: ProbeCache | undefined
interface Package {
	status: string
	title: string
	task_key: string
	priority: string
	updated: string
	source_type: string
	path: string
	// spec.md mtime, stamped by probePackages for active packages only.
	// Newest touched wins the title slot (see renderRepo).
	mtimeMs?: number
}
let packagesCache: { at: number; packages: Package[] } | undefined
let repoRootCache: { cwd: string; root: string | undefined } | undefined

async function resolveVaultRoot(): Promise<string | undefined> {
	const now = Date.now()
	if (vaultCache && now - vaultCache.at < CACHE_TTL_MS) return vaultCache.root
	try {
		const { stdout } = await execFileP(
			OBSIDIAN_BIN,
			[`vault=${OBSIDIAN_VAULT}`, "vault", "info=path"],
			{ timeout: PROBE_TIMEOUT_MS },
		)
		const root = stdout.trim()
		const ok = root.length > 0 && !root.toLowerCase().includes("not found")
		vaultCache = { at: now, root: ok ? root : undefined }
		return vaultCache.root
	} catch {
		vaultCache = { at: now, root: undefined }
		return undefined
	}
}

async function probeCli(): Promise<boolean> {
	const now = Date.now()
	if (cliCache && now - cliCache.at < CACHE_TTL_MS) return cliCache.result
	try {
		const { stdout } = await execFileP(OBSERVATORY_BIN, ["--version"], { timeout: PROBE_TIMEOUT_MS })
		// `observaitory --version` prints "<semver>" plus optional trailing whitespace.
		const ok = /\d+\.\d+\.\d+/.test(stdout)
		cliCache = { at: now, result: ok }
		return ok
	} catch {
		cliCache = { at: now, result: false }
		return false
	}
}

async function resolveRepoRoot(cwd: string): Promise<string | undefined> {
	if (repoRootCache?.cwd === cwd) return repoRootCache.root
	try {
		const { stdout } = await execFileP(
			"git",
			["-C", cwd, "rev-parse", "--show-toplevel"],
			{ timeout: PROBE_TIMEOUT_MS },
		)
		const root = stdout.trim()
		repoRootCache = { cwd, root: root || undefined }
		return root || undefined
	} catch {
		repoRootCache = { cwd, root: undefined }
		return undefined
	}
}

async function probePackages(cwd: string): Promise<Package[]> {
	const now = Date.now()
	if (packagesCache && now - packagesCache.at < CACHE_TTL_MS) return packagesCache.packages
	const root = await resolveRepoRoot(cwd)
	if (!root) {
		packagesCache = { at: now, packages: [] }
		return []
	}
	try {
		const { stdout } = await execFileP(
			OBSERVATORY_BIN,
			["mission", "list", "--cwd", root, "--json"],
			{ timeout: PROBE_TIMEOUT_MS },
		)
		const parsed: unknown = JSON.parse(stdout)
		const packages = Array.isArray(parsed) ? (parsed as Package[]) : []
		await stampActiveMtimes(packages)
		packagesCache = { at: now, packages }
		return packages
	} catch {
		packagesCache = { at: now, packages: [] }
		return []
	}
}

// The active title slot must track the package most recently touched in this
// repo. mission list orders rows alphabetically by task key, so dotfiles
// (which routinely holds several concurrent in-progress packages) would
// otherwise pin the title to whichever active key sorts first and never
// surface a package created for a live session. `updated` frontmatter is
// unreliable for this (often date-only or hand-edited), so stamp spec.md
// mtimes; unreadable specs sort after dated ones without reordering peers.
async function stampActiveMtimes(packages: Package[]): Promise<void> {
	const active = packages.filter((pkg) => pkg.status in ACTIVE_GLYPH)
	if (active.length < 2) return
	const vaultRoot = await resolveVaultRoot()
	if (!vaultRoot) return
	const mtimes = await Promise.all(
		active.map(async (pkg) => {
			try {
				return (await stat(join(vaultRoot, pkg.path))).mtimeMs
			} catch {
				return 0
			}
		}),
	)
	for (const [index, pkg] of active.entries()) {
		pkg.mtimeMs = mtimes[index]
	}
}

function truncateTitle(title: string, maxCells = 36): string {
	// Conservative cell-aware truncation; the renderer concatenates this with
	// other segments separated by spaces, so leave headroom for the prefix.
	if (title.length <= maxCells) return title
	return `${title.slice(0, maxCells - 1).trimEnd()}…`
}

// Status glyph for the active-task title. Kept short so the section stays
// single-line; matches the per-service vocabulary (◐/◉/◆/▲) so it reads as
// the same family.
const ACTIVE_GLYPH: Record<string, string> = {
	"in-progress": "◐",
	review: "◉",
	uat: "◆",
	"ready-for-production": "▲",
}

function renderRepo(packages: Package[]): string {
	const counts: Record<string, number> = {}
	for (const pkg of packages) {
		counts[pkg.status] = (counts[pkg.status] ?? 0) + 1
	}
	// Newest-touched active package wins the title slot; ties and unstamped
	// packages fall back to list order (Array.sort is stable).
	const active = packages
		.filter((pkg) => pkg.status in ACTIVE_GLYPH)
		.sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0]
	if (active) {
		const glyph = ACTIVE_GLYPH[active.status] ?? "◐"
		return paint("dim", `${glyph} ${truncateTitle(active.title)}`)
	}
	const inProg = counts["in-progress"] ?? 0
	const review = counts["review"] ?? 0
	const backlog = counts["backlog"] ?? 0
	const total = inProg + review + backlog
	if (total === 0) return paint("dim", "0 packages")
	const seg = (n: number, label: string): string =>
		paint(n > 0 ? "success" : "dim", `${n} ${label}`)
	const dot = paint("dim", "·")
	return `${seg(inProg, "in-prog")}  ${seg(review, "review")} ${dot} ${seg(backlog, "backlog")}`
}

function renderLine(
	vault: ConnState,
	cli: ConnState,
	packages: Package[] | undefined,
): string[] {
	const segments: string[] = [paint("dim", "obs:")]
	// Plain `●` matches the existing toolbar (Hindsight: ● hx, Decisions: ● dec).
	// ◐ = probing, ○ = down — distinct from filled `●`.
	const glyphFor = (state: ConnState): string => (state === undefined ? "◐" : state ? "●" : "○")
	const colorFor = (state: ConnState): ThemeColorName =>
		state === undefined ? "warning" : state ? "success" : "error"
	segments.push(paint(colorFor(vault), `${glyphFor(vault)} vault`))
	segments.push(paint(colorFor(cli), `${glyphFor(cli)} cli`))
	if (packages) {
		segments.push(paint("dim", "·"))
		segments.push(renderRepo(packages))
	}
	return [segments.join(paint("dim", "  "))]
}

export default function devMissionStatus(pi: ExtensionAPI) {
	// undefined = not probed yet (amber). Connection never goes red — it just
	// dims, since a transient timeout is normal during boot.
	let vault: ConnState
	let cli: ConnState
	let packages: Package[] | undefined
	let inFlight = false
	let ownWidget = false

	function publish(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return
		const lines = renderLine(vault, cli, packages)
		if (sections?.hasFooterRenderer()) {
			// Renderer owns the widget; hand the section over and retire any
			// fallback widget published before the renderer appeared.
			if (ownWidget) {
				ctx.ui.setWidget(WIDGET_KEY, undefined)
				ownWidget = false
			}
			sections.setFooterSection(SECTION_ID, SECTION_ORDER, lines)
			return
		}
		ownWidget = true
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" })
	}

	async function tick(ctx: ExtensionContext): Promise<void> {
		if (inFlight) return
		inFlight = true
		try {
			await Promise.all([
				resolveVaultRoot().then((root) => {
					vault = root !== undefined
				}),
				probeCli().then((ok) => {
					cli = ok
				}),
				probePackages(process.cwd()).then((pkgs) => {
					packages = pkgs
				}),
			])
		} catch {
			// never propagate; next tick retries
		} finally {
			inFlight = false
		}
		publish(ctx)
	}

	pi.on("session_start", async (_event, ctx) => {
		const attempt = (index: number): void => {
			if (index >= ATTACH_DELAYS_MS.length) return
			ctx.setTimeout(() => {
				if (!ctx.hasUI) {
					attempt(index + 1)
					return
				}
				publish(ctx)
				void tick(ctx)
				// Beats refresh the line; every PROBE_EVERY_BEATS-th beat also
				// re-probes the services.
				let beat = 0
				const interval = (): void => {
					ctx.setTimeout(() => {
						beat++
						if (beat % PROBE_EVERY_BEATS === 1) {
							void tick(ctx).finally(interval)
						} else {
							publish(ctx)
							interval()
						}
					}, PUBLISH_INTERVAL_MS)
				}
				interval()
			}, ATTACH_DELAYS_MS[index])
		}
		attempt(0)
	})

	pi.on("agent_end", async (_event, ctx) => {
		void tick(ctx)
	})
}