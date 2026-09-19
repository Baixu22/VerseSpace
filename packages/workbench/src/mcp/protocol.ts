/**
 * MCP stdio 的最小 JSON-RPC 2.0 协议层（TF-0210）。
 *
 * MCP 在 stdio 上的传输是「每行一个 JSON 消息」（NDJSON）。本模块只定义
 * 消息形状与错误码常量，不引入任何 SDK 依赖——帧的读写和分发都在 server.ts。
 */

/** MCP 协议版本：实现方声明自己支持的版本，客户端在 initialize 里协商。 */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const JSON_RPC_VERSION = "2.0" as const;

/** JSON-RPC 2.0 标准错误码（MCP 直接沿用）。 */
export const RPC_ERROR = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
} as const;

/** 带 id 的请求（id 存在即需要回包）。 */
export interface JsonRpcRequest {
	jsonrpc: string;
	id?: number | string;
	method: string;
	params?: unknown;
}

/** 响应：要么 result，要么 error，两者互斥。 */
export interface JsonRpcResponse {
	jsonrpc: string;
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}
