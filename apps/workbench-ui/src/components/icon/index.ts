/**
 * The single source of icons for the app.
 *
 * `@/components/icon` is the only module that should import from an icon
 * library. Reicon is the primary set; a small compat layer covers the glyphs
 * Reicon does not ship (see `./compat`). Import by name and the underlying
 * provider is an implementation detail:
 *
 * ```tsx
 * import { ChevronDown, GitBranch } from "@/components/icon";
 * ```
 *
 * Do not import from `reicon-react` or `lucide-react` directly anywhere else —
 * two import sites means two visual languages and no single place to swap.
 */

export * from "./compat";
export * from "./reicon";
