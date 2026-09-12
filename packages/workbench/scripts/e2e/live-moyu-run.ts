/**
 * moyu 真实模型开发现场（TF-0162/0163 的自然数据沉淀驱动）。
 *
 * 与 live-run.ts 的差别：工作对象不是合成 fixture，而是**真实仓库 moyu**
 * （用户指定的本地项目），任务是其 user_api demo 里真实需要的输入校验模块。
 * 机制完全复用：真实模型回合（live-agent）→ 足迹 → 交互沉淀 → 前提失效 →
 * 恢复卡 → 封印 → 分叉继承。操作由本脚本模拟真人多线程开发（读/改/复核/
 * 分叉），**人的复核数据仍留给真人**——本脚本不写任何 landmark.review。
 *
 * 现场落在 `packages/workbench/.evidence-sites/live-moyu-<label>/`（持久），
 * 不落 TEMP（TEMP 现场几小时内会消失）。
 *
 * 用法（密钥只走环境变量）：
 *   E2E_LLM_KEY=sk-... E2E_LLM_MODEL=senseaudio-s2-flash \
 *   E2E_LLM_BASE_URL=https://api.senseaudio.cn/v1 \
 *   bun scripts/e2e/live-moyu-run.ts
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	api,
	cli,
	type E2EWorkspace,
	lastEventFor,
	sendTurn,
	startServer,
	waitFor,
} from "./driver";
import { assertLiveAuthorized } from "./live-auth";
import { observeRestore } from "./restoration";

const WORKBENCH = resolve(import.meta.dir, "..", "..");
const MOYU_SRC =
	process.env.E2E_MOYU_SRC ?? "C:\\Users\\27933\\Desktop\\bad-shit\\moyu";
const SITES = join(WORKBENCH, ".evidence-sites");

const TARGET = "demo/user_api/utils/validators.py";
const REQUIREMENTS = "demo/user_api/utils/validators.requirements.txt";
const REVIEW = "demo/user_api/utils/validators.review.json";

if (!process.env.E2E_LLM_KEY || !process.env.E2E_LLM_MODEL) {
	throw new Error("需要 E2E_LLM_KEY 和 E2E_LLM_MODEL；密钥只通过环境变量传入");
}

/** v1 朴素实现：真实存在的缺陷形状（供 reader 建立前提，writer 按需求修复）。 */
const V1_VALIDATORS = `"""用户输入校验工具（v1 朴素实现，待按需求修复）"""
import re

EMAIL_RE = re.compile(r"^.+@.+$")


def validate_username(name):
    if isinstance(name, str) and len(name) >= 2:
        return True, ""
    return False, "用户名过短"


def validate_email(email):
    if isinstance(email, str) and EMAIL_RE.match(email):
        return True, ""
    return False, "邮箱格式不正确"


def validate_phone(phone):
    if phone is None:
        return True, ""
    if isinstance(phone, str) and len(phone) == 11:
        return True, ""
    return False, "手机号格式不正确"
`;

const REQUIREMENT_TEXT = [
	"完善 demo/user_api/utils/validators.py 的三个校验函数（供 UserService 与批量导入脚本复用）。",
	"",
	"模块约束：",
	"- 只依赖标准库（允许 re），Python 3.9+ 兼容；不得访问网络/文件/环境变量。",
	"- 每个函数返回 (ok: bool, message: str) 二元组：ok=True 时 message 必须是空字符串；ok=False 时 message 必须是非空中文说明。",
	'- validate_username(name) 与 validate_email(email) 只接受 str，其他类型一律 (False, "输入类型不正确")。',
	'- validate_phone(phone) 只接受 None 或 str：None 表示可选字段，直接 (True, "")；其他非 str 类型 (False, "输入类型不正确")。',
	"",
	"validate_username：",
	"1. 首尾空白直接不合格（消息说明「首尾不能有空白」）。",
	"2. 去首尾空白后长度必须 2–50（含边界），过长过短都不合格。",
	'3. 任何位置出现控制字符都不合格；中间的普通空格合法（如 "张 三"）。',
	"",
	"validate_email：",
	"1. 先剔除首尾空白再校验；剔除后内部仍有空格不合格。",
	"2. 整体格式 local@domain：local 只允许字母数字与 ._%+-，且不以点开头/结尾、不含连续点。",
	"3. domain 至少两段，段间用点分隔；每段以字母数字开头结尾，中间可有连字符；不允许纯数字外的其他符号。",
	"4. 只做格式校验，不做真实验证（不发请求、不查 DNS）。",
	"",
	"validate_phone：",
	"1. 允许空格与短横线作为分隔符，先剔除再校验。",
	"2. 剔除后必须恰好 11 位数字、以 1 开头、第二位为 3–9。",
	"3. 其他任何字符（含字母、括号、加号）不合格；位数或号段不对时消息说明原因。",
	"",
	"验收例：",
	'- validate_phone("138 1234 5678") 通过；validate_phone("12812345678") 不合格（第二位不在 3–9）；validate_phone("abcdefghijk") 不合格。',
	'- validate_email(" a@b.com ") 通过（首尾空白剔除后合法）；validate_email("a@b") 不合格（domain 至少两段）；validate_email("user@x..com") 不合格。',
	'- validate_username(" 张三 ") 不合格（首尾空白）；validate_username("张 三") 通过；validate_username("u"*51) 不合格。',
].join("\n");

/** 工作区路径。 */
function siteDir(label: string): string {
	return join(SITES, `live-moyu-${label}`);
}

/** 从真实仓库复制出隔离现场：只取 git 跟踪的文件，不带 .git。 */
async function buildWorkspace(label: string): Promise<E2EWorkspace> {
	const projectDir = siteDir(label);
	await mkdir(projectDir, { recursive: true });
	// 累积跑要复用现场：已经初始化过的现场不再覆盖源码树。
	// 原因是护城河 A 的读数来自**单一黑板**，多轮必须接着往同一块写；刷新源码会把
	// 上一轮的黑板与轮次记录一起搅乱（2026-09-12 实测：跨现场行数不会相加）。
	const initialized = await stat(join(projectDir, ".workbench")).then(
		(info) => info.isDirectory(),
		() => false,
	);
	if (!initialized) {
		// 整树递归复制，排除 .git（源仓库的历史不属于现场；现场自己 git init）。
		await cp(MOYU_SRC, projectDir, {
			recursive: true,
			filter: (source) => !source.endsWith(".git"),
		});
	}
	await writeFile(
		join(projectDir, ".live-e2e-authorized"),
		"isolated-live-model-fixture\n",
	);
	await mkdir(join(projectDir, "runs"), { recursive: true });
	return {
		projectDir,
		entry: resolve(import.meta.dir, "..", "..", "src", "index.ts"),
		agentScript: resolve(import.meta.dir, "live-agent.ts"),
	};
}

async function gitSeed(ws: E2EWorkspace): Promise<void> {
	const gitCode = (args: string[]) =>
		new Promise<number>((done, fail) => {
			const proc = spawn("git", args, { cwd: ws.projectDir });
			proc.on("exit", (code) => done(code ?? -1));
			proc.on("error", fail);
		});
	const identity = ["-c", "user.email=e2e@local", "-c", "user.name=e2e"];
	await gitCode(["init"]);
	await gitCode([...identity, "add", "."]);
	// 复用现场时通常没有新改动：`git diff --cached --quiet` 返回 0 表示无需提交，
	// 直接返回即可——不要把它当失败（累积跑的每一轮都会走到这里）。
	const staged = await gitCode([...identity, "diff", "--cached", "--quiet"]);
	if (staged !== 0) {
		const committed = await gitCode([
			...identity,
			"commit",
			"-m",
			"seed: moyu snapshot",
		]);
		if (committed !== 0) throw new Error(`git commit -> ${committed}`);
	}
}

interface Validation {
	total: number;
	passed: number;
	failures: Array<{
		name: string;
		input: string;
		expected: boolean | null;
		actual: string | boolean;
	}>;
}

/** 独立检查：python checker 子进程（干净环境，不带凭据）。 */
async function checkValidators(projectDir: string): Promise<Validation> {
	const python = process.env.E2E_MOYU_PYTHON ?? "python";
	const child = await new Promise<{ code: number | null; stdout: string }>(
		(done, fail) => {
			const proc = spawn(
				python,
				[
					resolve(import.meta.dir, "live-moyu-check.py"),
					join(projectDir, TARGET),
				],
				{
					cwd: projectDir,
					windowsHide: true,
					timeout: 20_000,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
					},
				},
			);
			let stdout = "";
			proc.stdout.on("data", (chunk) => (stdout += String(chunk)));
			proc.on("exit", (code) => done({ code, stdout }));
			proc.on("error", fail);
		},
	);
	try {
		return JSON.parse(child.stdout) as Validation;
	} catch {
		throw new Error(
			`独立检查进程异常（code=${child.code}）：${child.stdout.slice(0, 200)}`,
		);
	}
}

async function validateWithCorrections(
	projectDir: string,
	correct: (failures: Validation["failures"]) => Promise<unknown>,
): Promise<Validation[]> {
	const checks: Validation[] = [];
	await mkdir(join(projectDir, "runs"), { recursive: true });
	for (let attempt = 0; attempt <= 2; attempt++) {
		const check = await checkValidators(projectDir);
		checks.push(check);
		await writeFile(
			join(projectDir, "runs/live-moyu-validation.json"),
			JSON.stringify(checks, null, 2),
		);
		if (check.passed === check.total) return checks;
		if (attempt < 2) await correct(check.failures);
	}
	throw new Error(
		"模型产物独立检查仍未通过（已纠正两轮），见 runs/live-moyu-validation.json",
	);
}

async function runMoyuDevelopment(ws: E2EWorkspace) {
	await assertLiveAuthorized(ws.projectDir, "仅允许已授权的隔离工作区");
	await mkdir(join(ws.projectDir, "demo/user_api/utils"), { recursive: true });
	await writeFile(join(ws.projectDir, TARGET), V1_VALIDATORS);
	await writeFile(join(ws.projectDir, REQUIREMENTS), REQUIREMENT_TEXT);
	const server = await startServer(ws);
	try {
		const create = async (title: string) => {
			const response = await api(server, "/api/chat/threads", {
				method: "POST",
				body: JSON.stringify({ title }),
			});
			if (!response.ok) throw new Error(`建立开发线程失败 ${response.status}`);
			return ((await response.json()) as { id: string }).id;
		};
		const send = async (thread: string, text: string) => {
			const events = await sendTurn(server, thread, text);
			const error = events.find((event) => event.type === "error");
			if (error || !events.some((event) => event.type === "done"))
				throw new Error(`真实开发回合失败：${JSON.stringify(error)}`);
			return events;
		};
		const reader = await create("真实模型：moyu 校验模块旧前提与恢复复核");
		const writer = await create("真实模型：moyu 输入校验修复");
		console.log("[moyu-dev] 读取 v1 实现，建立真实前提");
		await send(
			reader,
			`用 Read 读取 ${TARGET}，说明当前校验函数对 "138-1234-5678"、"user@@example.com"、" 张三 " 会分别给出什么结论。不要修改文件。`,
		);
		await api(server, `/api/chat/threads/${reader}/leave`, { method: "POST" });
		console.log("[moyu-dev] 模型自主按需求修复校验模块");
		await send(
			writer,
			`先读取 ${REQUIREMENTS} 和 ${TARGET}，按需求实际修复代码并用 Write 保存完整文件，然后简述改动。不要修改其他文件。`,
		);
		const independentChecks = await validateWithCorrections(
			ws.projectDir,
			async (failures) => {
				console.log(
					`[moyu-dev] 独立验收未通过 ${failures.length} 项，模型纠正`,
				);
				await send(
					writer,
					`独立验收失败如下：${JSON.stringify(failures)}。先用 Read 读当前 ${TARGET}，**只做最小必要的定点修改**（不要重写整个文件、不要重复解释整体设计），用一次 Write 保存修改后的完整 ${TARGET}，一句话说明改了什么。不改需求、用例或其他文件。`,
				);
			},
		);
		const implementation = await readFile(join(ws.projectDir, TARGET), "utf8");
		if (!implementation.includes("def validate_username"))
			throw new Error("模型产物缺少三个校验函数");
		if (
			(await readFile(join(ws.projectDir, REQUIREMENTS), "utf8")) !==
			REQUIREMENT_TEXT
		)
			throw new Error("模型改动了只读需求");
		await waitFor(
			"旧读者前提失效",
			async () => Boolean(await lastEventFor(ws, "premise_stale", reader)),
			45_000,
		);
		const restored = await observeRestore(server, reader);
		if (!restored.resumeCard?.facts.some((fact) => fact.path === TARGET))
			throw new Error("真实代码变化未出现在恢复卡");
		await api(server, `/api/chat/threads/${reader}/resume-note/consume`, {
			method: "POST",
			body: JSON.stringify({ surface: "card" }),
		});
		const seal = async () => {
			const result = await cli(ws, [
				"--json",
				"premises",
				"seal",
				"--target",
				TARGET,
				"--writer",
				reader,
			]);
			if (![0, 2].includes(result.code ?? -1))
				throw new Error(`封印命令异常：${result.code}`);
			return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
				blocked: boolean;
				decision: string;
			};
		};
		const before = [await seal(), await seal(), await seal(), await seal()];
		if (!before[0]?.blocked || before.at(-1)?.blocked)
			throw new Error("陈旧前提封印/连续阻断降级未生效");
		console.log("[moyu-dev] 旧读者恢复、复读并独立复核新实现");
		await send(
			reader,
			`其他写者已按需求修复了这个模块。先 Read ${TARGET} 和 ${REQUIREMENTS}，基于实际新代码逐条复核需求，把 JSON 格式 {verdict: 'pass'或'fail', findings: 字符串数组} 的独立结论写入 ${REVIEW}。不要修改实现；不能仅因作者说完成就认可。`,
		);
		const after = await seal();
		if (after.blocked) throw new Error("真实复读之后仍被旧前提阻断");
		if (
			(await readFile(join(ws.projectDir, TARGET), "utf8")) !== implementation
		)
			throw new Error("复核线程改动了已独立验收的实现");
		const review = JSON.parse(
			await readFile(join(ws.projectDir, REVIEW), "utf8"),
		) as unknown;
		return {
			source: "live-model-moyu-development",
			reader,
			writer,
			requirement: REQUIREMENT_TEXT,
			implementation: TARGET,
			modelReview: review,
			independentChecks,
			sealBefore: before,
			sealAfter: after,
			limitations:
				"模型实现与模型复核来自真实工具回合；控制器安排并发和恢复。实现通过独立 python 用例；模型意见不记为人工认可。",
		};
	} finally {
		await server.stop();
	}
}

async function runMoyuFork(
	ws: E2EWorkspace,
	reader: string,
): Promise<{
	source: string;
	branches: Array<{ threadId: string; scenario: string }>;
}> {
	const implementation = await readFile(join(ws.projectDir, TARGET), "utf8");
	const server = await startServer(ws);
	try {
		const source = (await (
			await api(server, `/api/chat/threads/${reader}`)
		).json()) as { messages: Array<{ id: string }> };
		const anchor = source.messages.at(-1)?.id;
		if (!anchor) throw new Error("持久源线程缺少锚点");
		const branches: Array<{ threadId: string; scenario: string }> = [];
		const scenarios = [
			"用户名规则（长度边界、首尾空白、控制字符）",
			"邮箱格式规则（local 与 domain 的每条限制）",
			"手机号规则（分隔符剔除、号段与位数）",
		];
		for (const [index, scenario] of scenarios.entries()) {
			const response = await api(server, `/api/chat/threads/${reader}/fork`, {
				method: "POST",
				body: JSON.stringify({ anchorMessageId: anchor }),
			});
			const outcome = (await response.json()) as {
				thread?: { id: string };
				declaration?: { agentContextPlan?: string };
			};
			const child = outcome.thread?.id;
			if (!child || outcome.declaration?.agentContextPlan !== "fork-session")
				throw new Error("持久分支没有真实 provider 继承计划");
			console.log(`[moyu-fork] 分支 ${index + 1}：${scenario}`);
			await observeRestore(server, child, branches.at(-1)?.threadId ?? reader);
			const events = await sendTurn(
				server,
				child,
				`从继承的上下文继续，不要重复之前的改动。读取刚才复核的校验模块 ${TARGET}，重点独立检查「${scenario}」，将 JSON {verdict:'pass'或'fail',findings:字符串数组} 写到 demo/user_api/utils/branch-${index + 1}.review.json，不改其他文件。`,
			);
			if (
				events.some((event) => event.type === "error") ||
				!events.some((event) => event.type === "done")
			)
				throw new Error("真实模型分支回合失败");
			branches.push({ threadId: child, scenario });
		}
		const first = branches[0]!.threadId;
		await observeRestore(server, first, branches.at(-1)!.threadId);
		const revisit = await sendTurn(
			server,
			first,
			`再次读取 ${TARGET}，对照刚才用户名规则的检查，如果有剩余问题就明确列出；不修改文件。`,
		);
		if (revisit.some((event) => event.type === "error"))
			throw new Error("兄弟分支返回回合失败");
		const after = (await (
			await api(server, `/api/chat/threads/${reader}`)
		).json()) as { messages: unknown[] };
		if (JSON.stringify(after.messages) !== JSON.stringify(source.messages))
			throw new Error("分支改动了源线程消息");
		if (
			(await readFile(join(ws.projectDir, TARGET), "utf8")) !== implementation
		)
			throw new Error("复核分支改动了已独立验收的实现");
		return {
			source: reader,
			branches,
		};
	} finally {
		await server.stop();
	}
}

async function collectCalls(projectDir: string) {
	const dir = join(projectDir, ".workbench", "live-agent");
	const read = async (name: string) =>
		(await readFile(join(dir, name), "utf8").catch(() => ""))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	return {
		calls: await read("calls.jsonl"),
		attempts: await read("attempts.jsonl"),
	};
}

// 累积跑（TF-0163）：用 E2E_MOYU_LABEL 固定现场名，让多轮落进同一块黑板。
// 不给就用「一次一个新现场」的旧行为（新现场之间行数不相加）。
const label =
	process.env.E2E_MOYU_LABEL ??
	`${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const ws = await buildWorkspace(label);
console.log(`[moyu-live] 现场：${ws.projectDir}（源 ${MOYU_SRC}）`);
await gitSeed(ws);
await cli(ws, ["--json", "init", "--project", ws.projectDir]);
await assertLiveAuthorized(ws.projectDir);

let development: Awaited<ReturnType<typeof runMoyuDevelopment>> | undefined;
let forks: Awaited<ReturnType<typeof runMoyuFork>> | undefined;
let ok = true;
let errorText: string | undefined;
try {
	development = await runMoyuDevelopment(ws);
	forks = await runMoyuFork(ws, development.reader);
} catch (caught) {
	ok = false;
	const key = process.env.E2E_LLM_KEY ?? "";
	errorText = String(caught).split(key).join("[REDACTED]");
	process.exitCode = 1;
}
const { calls, attempts } = await collectCalls(ws.projectDir);
const report = {
	source: "live-model-moyu-run",
	model: process.env.E2E_LLM_MODEL,
	baseUrl: process.env.E2E_LLM_BASE_URL ?? "(default)",
	project: "moyu（真实本地仓库快照，git init 后作为隔离现场）",
	ok,
	...(errorText ? { error: errorText } : {}),
	development,
	forks,
	calls,
	attempts,
	limitations:
		"模型回复与工具是真实执行；恢复手势、human/git 写者和线程编排由测试脚本驱动，不代表人工偏好或自然用户体验。L1 复核仍留给真人。",
};
const round = Number(process.env.E2E_MOYU_ROUND ?? "1");
const reportText = `${JSON.stringify({ round, ...report }, null, 2)}\n`;
const reportPath = join(ws.projectDir, `runs/live-moyu-report-r${round}.json`);
await writeFile(reportPath, reportText);
// 同时写一份固定文件名，兼容既有报告引用。
await writeFile(join(ws.projectDir, "runs/live-moyu-report.json"), reportText);
console.log(
	`[moyu-live] ${ok ? "通过" : "失败"}；模型响应 ${calls.length} 次；请求尝试 ${attempts.length} 次；报告 ${reportPath}`,
);
if (!ok) console.error(errorText);
