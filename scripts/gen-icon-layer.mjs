// Generates the unified icon layer modules from a single authoritative mapping.
// Re-run with: node scripts/gen-icon-layer.mjs [--target src|workbench-ui|all]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
// Both frontends are separate builds with their own node_modules resolution, so
// each gets its own copy of the layer, generated from this one mapping.
// --target lets a mainline-only regeneration avoid rewriting the legacy Helmor
// icon layer (TF-0216). The mapping table below stays the single source.
const TARGET_ARG = process.argv.indexOf("--target");
const TARGET =
	TARGET_ARG >= 0 ? (process.argv[TARGET_ARG + 1] ?? "all") : "all";
const OUT_DIRS =
	TARGET === "workbench-ui"
		? [join(ROOT, "apps/workbench-ui/src/components/icon")]
		: TARGET === "src"
			? [join(ROOT, "src/components/icon")]
			: [
					join(ROOT, "src/components/icon"),
					join(ROOT, "apps/workbench-ui/src/components/icon"),
				];

// --- authoritative reicon name list --------------------------------------
const reiconIndex = readFileSync(
	join(ROOT, "node_modules/reicon-react/index.d.ts"),
	"utf8",
);
const reiconNames = new Set(
	[...reiconIndex.matchAll(/^export \{ (\w+) \} from '\.\/icons\//gm)].map(
		(m) => m[1],
	),
);

// --- mapping: lucide name -> reicon name ---------------------------------
// `null` value => reicon has no equivalent; falls through to the lucide compat set.
const MAP = {
	// identical name in reicon
	AlertCircle: "AlertCircle",
	AlertTriangle: "AlertTriangle",
	Archive: "Archive",
	ArrowDown: "ArrowDown",
	ArrowLeft: "ArrowLeft",
	ArrowRight: "ArrowRight",
	ArrowUp: "ArrowUp",
	ArrowUpRight: "ArrowUpRight",
	AtSign: "AtSign",
	Ban: "Ban",
	Box: "Box",
	Calendar: "Calendar",
	Check: "Check",
	ChevronDown: "ChevronDown",
	ChevronLeft: "ChevronLeft",
	ChevronRight: "ChevronRight",
	ChevronUp: "ChevronUp",
	ClipboardCheck: "ClipboardCheck",
	ClipboardList: "ClipboardList",
	Clock: "Clock",
	Clock3: "Clock3",
	Cloud: "Cloud",
	Command: "Command",
	Copy: "Copy",
	Cpu: "Cpu",
	Download: "Download",
	Eye: "Eye",
	FilePlus: "FilePlus",
	FileText: "FileText",
	Folder: "Folder",
	FolderOpen: "FolderOpen",
	FolderPlus: "FolderPlus",
	Globe: "Globe",
	HardDrive: "HardDrive",
	HelpCircle: "HelpCircle",
	History: "History",
	Laptop: "Laptop",
	Layers: "Layers",
	Lightbulb: "Lightbulb",
	LogIn: "Login",
	MessageCircle: "MessageCircle",
	MessageSquare: "MessageSquare",
	Minus: "Minus",
	Monitor: "Monitor",
	Moon: "Moon",
	Paperclip: "Paperclip",
	Pause: "Pause",
	PauseCircle: "PauseCircle",
	Pin: "Pin",
	PinOff: "PinOff",
	Play: "Play",
	Plug: "Plug",
	Plus: "Plus",
	Search: "Search",
	Send: "Send",
	Settings: "Settings",
	Settings2: "Settings2",
	Sparkles: "Sparkles",
	Sun: "Sun",
	Tag: "Tag",
	ThumbsDown: "ThumbsDown",
	ThumbsUp: "ThumbsUp",
	Trash2: "Trash2",
	X: "X",
	XCircle: "XCircle",

	// renamed: lucide's `-Icon` suffix is its own alias convention
	ArrowUpRightIcon: "ArrowUpRight",
	CheckIcon: "Check",
	ChevronDownIcon: "ChevronDown",
	ChevronRightIcon: "ChevronRight",
	ChevronUpIcon: "ChevronUp",
	CloudIcon: "Cloud",
	CopyIcon: "Copy",
	DownloadIcon: "Download",
	EyeIcon: "Eye",
	FileIcon: "File",
	FolderIcon: "Folder",
	FolderOpenIcon: "FolderOpen",
	ImageIcon: "Image",
	InfoIcon: "InfoCircle",
	LaptopIcon: "Laptop",
	ListIcon: "List",
	ListTreeIcon: "DiagramTree",
	Loader2Icon: "Loader",
	LoaderCircleIcon: "Loader",
	MessageCircleIcon: "MessageCircle",
	MinusIcon: "Minus",
	PanelLeftIcon: "SidebarLeft",
	PanelRightOpenIcon: "SidebarRight",
	PlusIcon: "Plus",
	SearchIcon: "Search",
	SettingsIcon: "Settings",
	SquarePenIcon: "PenSquare",
	TriangleAlertIcon: "AlertTriangle",
	Undo2Icon: "Undo",
	XIcon: "X",
	ZapIcon: "Bolt",

	// renamed: different vocabulary, same concept
	ArrowDownAZ: "SortAlpha",
	BookOpenText: "BookOpen",
	CheckCircle2: "CheckCircle",
	ChevronsRight: "AnglesRight",
	ChevronsUpDown: "SortDownUp",
	CircleAlert: "AlertCircle",
	CircleAlertIcon: "AlertCircle",
	CircleCheck: "CheckCircle",
	CircleCheckIcon: "CheckCircle",
	CircleHelp: "HelpCircle",
	CircleQuestionMark: "HelpCircle",
	CircleSlashIcon: "SlashCircle",
	CircleStop: "StopCircle",
	CircleX: "XCircle",
	ExternalLink: "ArrowUpRightSquare",
	ExternalLinkIcon: "ArrowUpRightSquare",
	FileCode: "CodeFile",
	FileCode2: "DocumentCode2",
	Goal: "Target",
	Hammer: "Sledgehammer",
	Info: "InfoCircle",
	KeyRound: "Key",
	LayersPlus: "Layers",
	LinkIcon: "Link",
	ListChecks: "ListCheck",
	ListFilter: "Filter",
	ListTree: "DiagramTree",
	Loader2: "Loader",
	LoaderCircle: "Loader",
	MessageSquareMore: "MessageDots",
	MessageSquareText: "MessageText",
	MessageSquareWarning: "MessageSquare",
	MessagesSquare: "Messages",
	MoreHorizontal: "MoreH",
	PackageCheck: "Package",
	PanelLeft: "SidebarLeft",
	PanelLeftClose: "SidebarLeft",
	PanelLeftOpen: "SidebarLeft",
	PanelRightClose: "SidebarRight",
	PanelRightOpen: "SidebarRight",
	Pencil: "Pen",
	PencilLine: "PenLine",
	RefreshCcw: "Refresh",
	RefreshCw: "Refresh",
	RotateCcw: "RotateLeft",
	SlidersHorizontal: "Sliders",
	Smartphone: "Mobile",
	SquareArrowOutUpRight: "ArrowUpRightSquare",
	SquareTerminal: "TerminalSquare",
	Terminal: "TerminalSquare",
	TimerReset: "Timer",
	TriangleIcon: "Triangle",
	Undo2: "Undo",
	Volume2: "Volume",
	Wrench: "Sledgehammer",
	Zap: "Bolt",
	ZoomIn: "SearchZoomIn",
	ZoomOut: "SearchZoomOut",

	// genuinely absent from reicon (no git / panel-collapse / keyboard glyphs)
	ArchiveRestore: null,
	ArrowBigUp: null,
	Bot: null,
	Brain: null,
	BrainIcon: null,
	Circle: null,
	CircleDashed: null,
	CircleDot: null,
	CornerDownLeft: null,
	Delete: null,
	FileAudio: null,
	FileDiff: null,
	FolderGit2: null,
	FolderSearch: null,
	GitBranch: null,
	GitBranchPlus: null,
	GitFork: null,
	GitMerge: null,
	GitPullRequest: null,
	GitPullRequestArrow: null,
	GripVertical: null,
	Option: null,
	Orbit: null,
	Pickaxe: null,
	Rows3: null,
	ShieldQuestion: null,
	Space: null,
	Split: null,
	// lucide `Square` + `strokeWidth={0}` is used as a solid filled stop glyph;
	// reicon's fill-based outline would erode under the strokeWidth mask.
	Square: null,
	Workflow: null,
};

// --- validate ------------------------------------------------------------
const errors = [];
for (const [lucideName, reiconName] of Object.entries(MAP)) {
	if (reiconName !== null && !reiconNames.has(reiconName)) {
		errors.push(
			`reicon has no icon named "${reiconName}" (mapped from lucide "${lucideName}")`,
		);
	}
}
if (errors.length) {
	console.error(`MAPPING ERRORS:\n${errors.join("\n")}`);
	process.exit(1);
}

const onlyReicon = Object.entries(MAP)
	.filter(([, v]) => v !== null)
	.sort(([a], [b]) => a.localeCompare(b));
const onlyCompat = Object.entries(MAP)
	.filter(([, v]) => v === null)
	.map(([k]) => k)
	.sort();

// direct (same name) vs aliased (name differs)
const direct = onlyReicon.filter(([k, v]) => k === v);
const aliased = onlyReicon.filter(([k, v]) => k !== v);

// --- emit ----------------------------------------------------------------
for (const OUT of OUT_DIRS) {
	mkdirSync(OUT, { recursive: true });
}

const HEADER = `/**
 * AUTO-GENERATED by \`scripts/gen-icon-layer.mjs\` — do not edit by hand.
 *
 * Edit the mapping table in that script, then re-run it.
 */
`;

// Emit ONE export block sorted by source icon then alias, matching what
// biome's organizeImports produces — so linting the generated file is a no-op
// and a regeneration never shows up as a spurious diff.
//
// NOTE: biome sorts by UTF-16 code unit, NOT `localeCompare` (ICU collation
// treats "MessageSquare"/"Messages" differently). Keep the raw comparison.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const specs = onlyReicon
	.map(([appName, sourceName]) => ({
		sourceName,
		alias: appName === sourceName ? "" : appName,
	}))
	.sort((a, b) =>
		a.sourceName === b.sourceName
			? byCodeUnit(a.alias, b.alias)
			: byCodeUnit(a.sourceName, b.sourceName),
	)
	.map(({ sourceName, alias }) =>
		alias ? `${sourceName} as ${alias}` : sourceName,
	);

const reiconFile = `${HEADER}
// Icons whose glyph exists in Reicon, re-exported under the identifiers this
// codebase already imports. Anything Reicon does not ship lives in ../compat.
// Keep this one sorted block: biome's organizeImports must stay a no-op here.

export {
${specs.map((s) => `\t${s},`).join("\n")}
} from "reicon-react";
`;

const compatFile = `${HEADER}
// Glyphs Reicon does not ship. Reicon has no git, panel-collapse, or keyboard
// glyphs, so these stay on lucide-react to preserve their exact meaning.
// Each entry is a candidate for removal as Reicon's set grows.

export {
${onlyCompat.map((n) => `\t${n},`).join("\n")}
} from "lucide-react";
`;

const typesFile = `/**
 * Shared icon typing for the unified icon layer.
 *
 * Every icon reachable from \`@/components/icon\` is assignable to {@link AppIcon},
 * so this is the type to use for icon props, maps, and render-prop slots.
 */
import type { SVGProps } from "react";
import type { IconComponent } from "reicon-react";

/** Props understood by Reicon-backed icons; compat icons accept a subset. */
export interface AppIconProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
	color?: string;
	/** Pixel size when numeric. Default \`24\`. */
	size?: number | string;
	/** Reicon weight. Reicon-backed icons only; compat icons ignore it. */
	weight?: "Outline" | "Filled";
	/** Stroke emphasis. Reicon-backed icons restyle their outline to match. */
	strokeWidth?: number | string;
	/** Reicon dual-tone secondary color. Reicon-backed icons only. */
	secondaryColor?: string;
}

/**
 * The unified icon component type. Reicon-backed and lucide compat icons both
 * satisfy it, because \`AppIconProps\` is a structural superset of lucide's.
 */
export type AppIcon = IconComponent;
`;

const indexFile = `/**
 * The single source of icons for the app.
 *
 * \`@/components/icon\` is the only module that should import from an icon
 * library. Reicon is the primary set; a small compat layer covers the glyphs
 * Reicon does not ship (see \`./compat\`). Import by name and the underlying
 * provider is an implementation detail:
 *
 * \`\`\`tsx
 * import { ChevronDown, GitBranch } from "@/components/icon";
 * \`\`\`
 *
 * Do not import from \`reicon-react\` or \`lucide-react\` directly anywhere else —
 * two import sites means two visual languages and no single place to swap.
 */

export * from "./compat";
export * from "./reicon";
export type { AppIcon, AppIconProps } from "./types";
`;

const FILES = {
	"reicon.ts": reiconFile,
	"compat.ts": compatFile,
	"types.ts": typesFile,
	"index.ts": indexFile,
};

for (const OUT of OUT_DIRS) {
	for (const [name, content] of Object.entries(FILES)) {
		writeFileSync(join(OUT, name), content, "utf8");
	}
}

console.log(
	`reicon-backed : ${onlyReicon.length} (${direct.length} direct, ${aliased.length} aliased)`,
);
console.log(`lucide compat : ${onlyCompat.length}`);
console.log(`total names   : ${onlyReicon.length + onlyCompat.length}`);
console.log(`\ncompat set: ${onlyCompat.join(", ")}`);
