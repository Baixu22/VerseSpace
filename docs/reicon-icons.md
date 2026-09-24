# Icons: the unified layer & the Reicon MCP server

The Workbench dashboard draws every UI icon from one module —
`@/components/icon` — backed by [Reicon](https://reicon.dev). This doc covers
how to use the layer, how to regenerate it, and how to give an AI agent the
Reicon MCP server so it can search icons itself instead of guessing names.

## The layer

```tsx
import { ChevronDown, GitBranch, LoaderCircle } from "@/components/icon";

<ChevronDown className="size-3.5 text-fg-subtle" />
<LoaderCircle className="size-4 animate-spin" />
```

Never import from `reicon-react` or `lucide-react` directly. One import site
means one visual language and one place to swap providers.

Icons are re-exported under the **identifiers this codebase already used**, so
call sites keep their existing props. The layer is a drop-in barrel — the
migration to Reicon changed 166 import lines and zero JSX.

| Location | Scope |
| --- | --- |
| `apps/workbench-ui/src/components/icon/` | Workbench web dashboard — the only frontend since [ADR-0015](decisions/0015-legacy-retirement-execution.md) |

### Props

Reicon's own API, unchanged:

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `size` | `number \| string` | `24` | Sets `width`/`height` attributes |
| `color` | `string` | inherits | Sets inline `color` |
| `weight` | `"Outline" \| "Filled"` | `Outline` | Reicon-backed icons only |
| `strokeWidth` | `number \| string` | `1.5` | Restyles the outline's weight |
| `secondaryColor` | `string` | same as `color` | Dual-tone icons |
| `className` | `string` | — | Wins over `size` — `size-3.5` etc. work as before |

`strokeWidth` maps onto Reicon's scale rather than lucide's: Reicon's native
weight is `1.5` where lucide's was `2`. Values above `1.5` expand the outline
with a cheap `<g stroke>` wrapper; values below it go through an SVG mask, so
prefer `>= 1.5` when adding new call sites. The existing ~490 call sites were
left exactly as authored.

## Coverage

39 icons: **34 backed by Reicon**, 5 by lucide.

This is a curated set, not the full Reicon catalogue: the mapping table carries
only the identifiers a call site actually imports. An earlier revision carried
184 entries (154 Reicon + 30 lucide); the residue cleanup dropped the 145 that
nothing imported — including every `*Icon` alias, which came from lucide's own
alias convention and which no call site here ever used.

Reicon ships 2,676 icons but has **no git glyphs** — a real gap for an app built
around branches and PRs. The 5 that stay on lucide preserve their exact meaning,
and live in `compat.ts`:

```
ArchiveRestore GitBranch GitFork GitMerge Square
```

Most notable substitutions where Reicon uses different vocabulary:

| Was (lucide) | Now (Reicon) |
| --- | --- |
| `PanelLeft` | `SidebarLeft` |
| `Terminal` | `TerminalSquare` |
| `RotateCcw` | `RotateLeft` |
| `Loader2` | `Loader` |
| `Info` | `InfoCircle` |
| `BookOpenText` | `BookOpen` |
| `CircleCheck` | `CheckCircle` |
| `ListChecks` | `ListCheck` |
| `Volume2` | `Volume` |

## Regenerating

The layer is generated from one mapping table — edit it, don't hand-patch the
generated files.

```bash
node scripts/gen-icon-layer.mjs
```

This writes `reicon.ts`, `compat.ts`, `types.ts`, and `index.ts` into
`apps/workbench-ui/src/components/icon/`. It hard-fails if a mapping points at
a Reicon icon that does not exist, so a typo or an upstream rename surfaces
immediately instead of at runtime.

To add an icon:

1. Find its Reicon name — `npx reicon-mcp search "shopping cart"`, or ask an
   agent using the MCP server below.
2. Add `AppName: "ReiconName"` to `MAP` in `scripts/gen-icon-layer.mjs`.
   Use `null` for a glyph Reicon lacks — it then falls into the lucide compat
   set (`compat.ts`, i.e. the `lucide-react` import block).
3. Re-run the generator.

`biome.json` exempts the two generated modules from `organizeImports`, so the
generator owns their layout and linting stays clean.

## Reicon MCP server

`reicon-mcp` exposes the icon set to AI agents over stdio: search 2,676 icons,
preview raw SVG, and generate framework-specific import snippets. Its index is
bundled at build time, so it works fully offline.

### Install

```bash
bun add -d reicon-mcp      # already in this repo's devDependencies
```

### Configuration

The server is launched through `scripts/reicon-mcp.mjs` rather than `npx`
directly. That wrapper resolves the package from **its own** location, so it
works when an agent session's cwd is a Helmor worktree (which has no
`node_modules` of its own), and it sidesteps a Windows footgun: MCP clients that
spawn `npx` there can fail with `ENOENT`, or `EINVAL` for the `npx.cmd` shim,
because Node cannot spawn a `.cmd` without a shell.

**Claude Code** — project scope, committed in `.mcp.json`:

```json
{
  "mcpServers": {
    "reicon": {
      "command": "node",
      "args": ["scripts/reicon-mcp.mjs"]
    }
  }
}
```

**Cursor** — project scope, committed in `.cursor/mcp.json` (identical body).

**Agent sessions in a git worktree** — a session whose cwd is a worktree has no
`node_modules` of its own, so it cannot resolve the project-scope files above.
Register the server in machine-local user config instead, and use an
**absolute** launcher path so worktree sessions still resolve it:

```jsonc
// ~/.claude.json  ->  projects["<repo root>"].mcpServers
{
  "reicon": {
    "command": "node",
    "args": ["<repo-root>\\scripts\\reicon-mcp.mjs"]
  }
}
```

```jsonc
// ~/.cursor/mcp.json
{
  "mcpServers": {
    "reicon": {
      "command": "node",
      "args": ["<repo-root>\\scripts\\reicon-mcp.mjs"]
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.reicon]
type = "stdio"
command = "node"
args = ['<repo-root>\scripts\reicon-mcp.mjs']
```

Single-quoted TOML literal strings keep Windows backslashes verbatim.

### Verify

```bash
claude mcp list                    # Claude Code
node scripts/reicon-mcp.mjs categories
```

### Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `search_icons` | `query`, optional `weight`, `limit` | Ranked matches: name, weight, category, tags, score |
| `view_icon` | `name`, `weight` | Raw SVG, viewBox, tags, category |
| `apply_icon` | `name`, `weight`, `framework`, optional `size`, `color` | Import + usage snippet |
| `list_categories` | — | All category values |

Agent flow: `search_icons` with a short keyword (`cart`, not "a cart icon"), then
`apply_icon` for the snippet. Note that search is keyword-driven — `search "git
branch"` returns map arrows, because Reicon genuinely has no git icons.

### CLI

The same binary runs without an MCP client:

```bash
node scripts/reicon-mcp.mjs search "shopping cart"
node scripts/reicon-mcp.mjs view heart --weight Filled
node scripts/reicon-mcp.mjs apply heart --framework react --size 32 --color "#ef4444"
node scripts/reicon-mcp.mjs categories

# Scripted insertion: replaces the exact marker, adds the import if missing
node scripts/reicon-mcp.mjs apply heart --framework react \
  --file src/App.tsx --marker "{/* ICON */}"
```
