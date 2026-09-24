/** 纯只读动词：任何参数组合都不写工作树、不写 ref。 */
const READ_ONLY_VERBS = new Set([
	"annotate",
	"blame",
	"cat-file",
	"check-attr",
	"check-ignore",
	"check-mailmap",
	"check-ref-format",
	"count-objects",
	"describe",
	"diff",
	"diff-files",
	"diff-index",
	"diff-tree",
	"for-each-ref",
	"get-tar-commit-id",
	"grep",
	"hash-object",
	"interpret-trailers",
	"log",
	"ls-files",
	"ls-remote",
	"ls-tree",
	"merge-base",
	"merge-tree",
	"name-rev",
	"rev-list",
	"rev-parse",
	"shortlog",
	"show",
	"show-index",
	"show-ref",
	"status",
	"var",
	"verify-commit",
	"verify-pack",
	"verify-tag",
	"version",
	"whatchanged",
]);

/**
 * 条件只读动词：裸调用（或只读子命令/只读选项）是列出。
 * 判定不出来时一律按可写处理——闸门宁可多拦，不可放过连带删除。
 */
const CONDITIONAL_VERBS: Record<
	string,
	{
		bare?: boolean;
		readOnlyFlags?: ReadonlySet<string>;
		subcommands?: ReadonlySet<string>;
	}
> = {
	branch: {
		bare: true,
		readOnlyFlags: new Set([
			"-a",
			"-r",
			"-v",
			"-vv",
			"-l",
			"--list",
			"--show-current",
			"--contains",
			"--no-contains",
			"--merged",
			"--no-merged",
			"--points-at",
			"--format",
			"--sort",
			"--column",
			"--no-column",
			"--color",
			"--no-color",
			"--abbrev",
		]),
	},
	config: {
		readOnlyFlags: new Set([
			"--get",
			"--get-all",
			"--get-regexp",
			"--get-urlmatch",
			"--list",
			"-l",
			"--show-origin",
			"--show-scope",
			"--name-only",
			"--type",
		]),
	},
	notes: { subcommands: new Set(["list"]) },
	remote: { bare: true, readOnlyFlags: new Set(["-v", "--verbose"]) },
	stash: { subcommands: new Set(["list", "show"]) },
	submodule: { subcommands: new Set(["status", "summary"]) },
	tag: {
		bare: true,
		readOnlyFlags: new Set([
			"-l",
			"--list",
			"-n",
			"-i",
			"--ignore-case",
			"--contains",
			"--no-contains",
			"--merged",
			"--no-merged",
			"--points-at",
			"--format",
			"--sort",
			"--column",
			"--no-column",
			"--color",
			"--no-color",
		]),
	},
	worktree: { subcommands: new Set(["list"]) },
};

/** 动词之前、带独立取值的全局选项。 */
const GLOBAL_OPTION_WITH_VALUE = new Set([
	"-c",
	"-C",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--exec-path",
	"--config-env",
]);

/** 动词之前、以 `--x=` 形式带值的全局选项。 */
const GLOBAL_OPTION_PREFIXES = [
	"--git-dir=",
	"--work-tree=",
	"--namespace=",
	"--exec-path=",
	"--config-env=",
	"--attr-source=",
	"--list-cmds=",
];

/** 动词之前、不带值的全局旗标。 */
const GLOBAL_FLAGS = new Set([
	"--bare",
	"--glob-pathspecs",
	"--icase-pathspecs",
	"--literal-pathspecs",
	"--no-optional-locks",
	"--no-pager",
	"--no-replace-objects",
	"--noglob-pathspecs",
	"--paginate",
	"-p",
	"-P",
]);

/** 从 git 参数里取出动词与紧随其后的子命令/首个选项。 */
function parseGitCommand(args: string[]): {
	verb?: string;
	rest: string[];
} {
	let index = 0;
	while (index < args.length) {
		const token = args[index] as string;
		if (GLOBAL_OPTION_WITH_VALUE.has(token)) {
			index += 2;
			continue;
		}
		if (GLOBAL_OPTION_PREFIXES.some((prefix) => token.startsWith(prefix))) {
			index += 1;
			continue;
		}
		if (GLOBAL_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		break;
	}
	const verb = args[index];
	if (verb === undefined) return { rest: [] };
	return { verb, rest: args.slice(index + 1) };
}

/** 这条 git 命令是否可证明为只读。 */
export function isReadOnlyGitCommand(args: string[]): boolean {
	const { verb, rest } = parseGitCommand(args);
	if (verb === undefined) return false;
	if (READ_ONLY_VERBS.has(verb)) return true;

	const conditional = CONDITIONAL_VERBS[verb];
	if (!conditional) return false;
	if (rest.length === 0) return conditional.bare === true;
	const first = rest[0] as string;
	if (conditional.readOnlyFlags?.has(first)) return true;
	if (first.startsWith("-")) return false;
	return conditional.subcommands?.has(first) === true;
}
