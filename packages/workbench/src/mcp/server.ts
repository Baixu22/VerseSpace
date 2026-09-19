/**
 * MCP stdio 服务（TF-0210）。
 *
 * 帧协议：stdin 每行一个 JSON（NDJSON），响应写到 stdout。
 * 零依赖：只用 node:readline 与 JSON 序列化。
 */

import { createInterface } from "node:readline";

import type { Blackboard } from "../blackboard";
import { WORKBENCH_VERSION } from "../version";

import {
	JSON_RPC_VERSION,
	type JsonRpcRequest,
	type JsonRpcResponse,
	MCP_PROTOCOL_VERSION,
	RPC_ERROR,
} from "./protocol";
import { findMcpTool, MCP_TOOLS } from "./tools";

function ok(id: number | string, result: unknown): JsonRpcResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, result };
}

function err(
	id: number | string | null,
	code: number,
	message: string,
): JsonRpcResponse {
	return { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } };
}

/**
 * 处理一条 MCP 消息。
 *
 * - 通知（无 id）：返回 null，调用方不应回包。
 * - 请求：返回对应的 JSON-RPC 响应。
 * 纯函数，便于协议测试直接驱动，无需真的开子进程。
 */
export async function handleRequest(
	message: JsonRpcRequest,
	bb: Blackboard,
): Promise<JsonRpcResponse | null> {
	if (message.id === undefined) {
		// notifications/initialized、notifications/cancelled 等都无需回包。
		return null;
	}
	const id = message.id;
	try {
		switch (message.method) {
			case "initialize":
				return ok(id, {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "workbench", version: WORKBENCH_VERSION },
				});
			case "ping":
				return ok(id, {});
			case "tools/list":
				return ok(id, {
					tools: MCP_TOOLS.map((tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				});
			case "tools/call": {
				const params = (message.params ?? {}) as {
					name?: string;
					arguments?: Record<string, unknown>;
				};
				const tool = params.name ? findMcpTool(params.name) : undefined;
				if (!tool) {
					return err(id, RPC_ERROR.INVALID_PARAMS, `未知工具：${params.name}`);
				}
				const text = await tool.run(params.arguments ?? {}, bb);
				return ok(id, {
					content: [{ type: "text", text }],
					isError: false,
				});
			}
			default:
				return err(
					id,
					RPC_ERROR.METHOD_NOT_FOUND,
					`方法不存在：${message.method}`,
				);
		}
	} catch (error) {
		return err(id, RPC_ERROR.INTERNAL_ERROR, `内部错误：${String(error)}`);
	}
}

function writeResponse(response: JsonRpcResponse): void {
	process.stdout.write(`${JSON.stringify(response)}\n`);
}

/**
 * 在 stdio 上运行 MCP 服务，直到 stdin 关闭。
 * `workbench mcp` 的入口。
 */
export async function serveMcp(bb: Blackboard): Promise<void> {
	const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
	for await (const line of rl) {
		if (!line.trim()) {
			continue;
		}
		let message: JsonRpcRequest;
		try {
			message = JSON.parse(line) as JsonRpcRequest;
		} catch {
			writeResponse(err(null, RPC_ERROR.PARSE_ERROR, "Parse error"));
			continue;
		}
		if (
			typeof message !== "object" ||
			message === null ||
			typeof message.method !== "string"
		) {
			writeResponse(err(null, RPC_ERROR.INVALID_REQUEST, "Invalid Request"));
			continue;
		}
		const response = await handleRequest(message, bb);
		if (response) {
			writeResponse(response);
		}
	}
}
