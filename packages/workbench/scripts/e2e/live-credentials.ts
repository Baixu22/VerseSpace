/**
 * live 模型凭据读取（跨宿主可用）。
 *
 * 为什么需要它：本机 Windows 上的 DPAPI 凭据此前只能靠脚本宿主解密，于是「起 bun」
 * 这件事就被绑死在那个宿主上——而某些宿主会话根本**不执行原生进程**（2026-09-12 实测：
 * 沙箱开关两侧都一样，调用连启动都没发生，`$LASTEXITCODE` 从未被赋值），于是拿到密钥
 * 的唯一办法是把明文塞进命令行，明文就漏进了记录。
 *
 * 这个模块用 `bun:ffi` 直接调 `crypt32!CryptUnprotectData`，让整条 live 链路都在 Bun 里
 * 跑完：密钥只存在于进程内存，不落盘、不进命令行、不依赖任何外部宿主。
 *
 * 凭据文件格式：`ConvertFrom-SecureString` 的输出——DPAPI blob 的 hex 串。
 * 默认路径与原脚本一致：%LOCALAPPDATA%\HelmorWorkbench\credentials\openrouter.dpapi
 *
 * 优先级：环境变量 E2E_LLM_KEY > DPAPI 文件。
 */
import { dlopen, FFIType, ptr, toArrayBuffer } from "bun:ffi";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_BASE_URL = "https://api.senseaudio.cn/v1";
const DEFAULT_MODEL = "senseaudio-s2-flash";

function defaultCredentialPath(): string {
	const localAppData =
		process.env.LOCALAPPDATA ??
		join(process.env.USERPROFILE ?? "", "AppData", "Local");
	return join(
		localAppData,
		"HelmorWorkbench",
		"credentials",
		"openrouter.dpapi",
	);
}

/** DATA_BLOB { DWORD cbData; BYTE *pbData; } —— 64 位下占 16 字节（含 4 字节对齐）。 */
const DATA_BLOB_BYTES = 16;

// 惰性加载并缓存：非 Windows 上不该在 import 期就尝试找 crypt32.dll。
function loadCrypt32() {
	return dlopen("crypt32.dll", {
		CryptUnprotectData: {
			args: [
				FFIType.ptr, // pDataIn
				FFIType.ptr, // ppszDataDescr
				FFIType.ptr, // pOptionalEntropy
				FFIType.ptr, // pvReserved
				FFIType.ptr, // pPromptStruct
				FFIType.u32, // dwFlags
				FFIType.ptr, // pDataOut
			],
			returns: FFIType.i32,
		},
	});
}

function loadKernel32() {
	// HLOCAL 就是指针大小的整数：声明成 u64 才能把 CryptUnprotectData 返回的地址
	// 原样传回去（声明成 ptr 时 Bun 会拒绝把该地址转成指针）。
	return dlopen("kernel32.dll", {
		LocalFree: { args: [FFIType.u64], returns: FFIType.ptr },
	});
}

let crypt32Lib: ReturnType<typeof loadCrypt32> | undefined;
let kernel32Lib: ReturnType<typeof loadKernel32> | undefined;

/** 解出 DPAPI hex 串里的明文。密钥只在这个函数的返回值里出现。 */
export function decryptDpapiString(hex: string): string {
	if (process.platform !== "win32")
		throw new Error(
			"DPAPI 只在 Windows 上可用；其他平台请用 E2E_LLM_KEY 环境变量",
		);
	if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0)
		throw new Error("凭据文件不是 DPAPI hex 串");
	crypt32Lib ??= loadCrypt32();
	kernel32Lib ??= loadKernel32();
	const blob = Buffer.from(hex, "hex");
	const inBlob = Buffer.alloc(DATA_BLOB_BYTES);
	inBlob.writeUInt32LE(blob.length, 0);
	inBlob.writeBigUInt64LE(BigInt(ptr(blob)), 8);
	const outBlob = Buffer.alloc(DATA_BLOB_BYTES);
	const ok = crypt32Lib.symbols.CryptUnprotectData(
		ptr(inBlob),
		null,
		null,
		null,
		null,
		0,
		ptr(outBlob),
	);
	if (!ok) throw new Error("CryptUnprotectData 失败（凭据可能属于另一个用户）");
	const cbData = outBlob.readUInt32LE(0);
	const pbData = outBlob.readBigUInt64LE(8);
	try {
		// ConvertFrom-SecureString 的明文是 UTF-16LE。
		return Buffer.from(toArrayBuffer(Number(pbData), 0, cbData)).toString(
			"utf16le",
		);
	} finally {
		kernel32Lib.symbols.LocalFree(pbData);
	}
}

export interface LiveModelCredentials {
	key: string;
	model: string;
	baseUrl: string;
	/** 密钥来源，便于报告里说明「用的是哪一个」，而不必打印密钥本身。 */
	origin: "env" | "dpapi";
}

/**
 * 取 live 模型凭据。密钥只返回给调用方，**不要把它写进日志、报告或文件名**。
 */
export function loadLiveModelCredentials(options?: {
	credentialPath?: string;
	require?: boolean;
}): LiveModelCredentials {
	const fromEnv = process.env.E2E_LLM_KEY;
	const model = process.env.E2E_LLM_MODEL ?? DEFAULT_MODEL;
	const baseUrl = process.env.E2E_LLM_BASE_URL ?? DEFAULT_BASE_URL;
	if (fromEnv) return { key: fromEnv, model, baseUrl, origin: "env" };
	const path = options?.credentialPath ?? defaultCredentialPath();
	let hex: string;
	try {
		hex = readFileSync(path, "utf8").trim();
	} catch {
		if (options?.require === false)
			return { key: "", model, baseUrl, origin: "env" };
		throw new Error(
			`找不到 live 模型凭据：${path}（可用 E2E_LLM_KEY 环境变量代替）`,
		);
	}
	return { key: decryptDpapiString(hex), model, baseUrl, origin: "dpapi" };
}

/** 供脚本自检：只打印来源与长度，绝不打印密钥。 */
if (import.meta.main) {
	const credentials = loadLiveModelCredentials();
	console.log(
		`凭据来源：${credentials.origin}；长度 ${credentials.key.length}；模型 ${credentials.model}；base ${credentials.baseUrl}`,
	);
}
