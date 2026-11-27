"""MCP stdio transport for the package's public dictionary and PNG renderer."""
import argparse
import json
import sys
from urllib.error import HTTPError
from library import Library, card


def schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


TOOLS = [
    {"name": "memewiki_entries", "description": "分页读取公共词库以建立本地检索索引。", "inputSchema": schema({"offset": {"type": "integer", "minimum": 0}, "limit": {"type": "integer", "minimum": 1, "maximum": 32}})},
    {"name": "memewiki_lookup", "description": "查询公共梗词库，返回含义、用法和出处。",
     "inputSchema": schema({"query": {"type": "string", "minLength": 1, "maxLength": 80}, "online": {"type": "boolean"}}, ["query"])},
    {"name": "memewiki_card", "description": "将查到的词条绘制成图片卡片。",
     "inputSchema": schema({key: {"type": "string", "maxLength": 4000} for key in ("title", "usage", "origin", "other", "summary", "source")}, ["title"])},
    {"name": "memewiki_sync_step", "description": "从 cnmeme.wiki 增量检查一页词条；保留已存在的词库，可继续执行直到 done。", "inputSchema": schema()},
    {"name": "memewiki_info", "description": "读取随包词库条目数与快照摘要。", "inputSchema": schema()},
]
for tool in TOOLS:
    tool["annotations"] = {"readOnlyHint": tool["name"] != "memewiki_sync_step", "destructiveHint": False,
                           "openWorldHint": tool["name"] in {"memewiki_lookup", "memewiki_sync_step"}}


class ToolInputError(ValueError):
    pass


def tool_error(code, message, **fields):
    return {"content": [{"type": "text", "text": message}], "isError": True,
            "structuredContent": {"error": {"code": code, "message": message, **fields}}}


def call(library, name, args):
    tool = next((t for t in TOOLS if t["name"] == name), None)
    if not tool:
        raise ToolInputError("工具名称不存在")
    if not isinstance(args, dict):
        raise ToolInputError("工具参数必须为对象")
    shape = tool["inputSchema"]
    if set(args) - set(shape["properties"]):
        raise ToolInputError("工具参数包含未知字段")
    for key in shape["required"]:
        if key not in args:
            raise ToolInputError(f"缺少必需参数 {key}")
    for key, value in args.items():
        prop = shape["properties"][key]
        if prop["type"] == "boolean" and not isinstance(value, bool):
            raise ToolInputError("开关参数须为布尔值")
        if prop["type"] == "string":
            if not isinstance(value, str):
                raise ToolInputError(f"参数 {key} 必须为文本")
            if len(value) > prop["maxLength"]:
                raise ToolInputError(f"参数 {key} 超过 {prop['maxLength']} 个字符")
        if prop["type"] == "integer" and (type(value) is not int or value < prop.get("minimum", 0) or value > prop.get("maximum", 1000000)):
            raise ToolInputError("分页参数无效")
    if name == "memewiki_card":
        return {"content": [{"type": "image", "mimeType": "image/png", "data": card(args)}], "isError": False}
    if name == "memewiki_entries":
        value = library.entries(args.get("offset", 0), args.get("limit", 16))
    elif name == "memewiki_lookup":
        value = library.lookup(args["query"], args.get("online", False))
    elif name == "memewiki_sync_step":
        value = library.sync_step()
    else:
        value = {k: library.snapshot[k] for k in ("entries", "sha256", "source", "commit")}
    return {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}], "structuredContent": value, "isError": False}


def dispatch(library, message):
    if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
    if "id" not in message:
        return None
    identity, method, params = message["id"], message.get("method"), message.get("params", {})
    if not isinstance(params, dict):
        return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32602, "message": "Invalid params"}}
    if method == "initialize":
        version = params.get("protocolVersion")
        value = {"protocolVersion": version if version in {"2024-11-05", "2025-03-26", "2025-06-18"} else "2025-03-26",
                 "capabilities": {"tools": {}}, "serverInfo": {"name": "openbot-memewiki", "version": "0.1.0"}}
    elif method == "ping":
        value = {}
    elif method == "tools/list":
        value = {"tools": TOOLS}
    elif method == "tools/call":
        try:
            value = call(library, params.get("name"), params.get("arguments", {}))
        except ToolInputError as exc:
            value = tool_error("MEMEWIKI_TOOL_INPUT", str(exc))
        except HTTPError as exc:
            value = tool_error("MEMEWIKI_HTTP_ERROR", f"读取线上词库失败（HTTP {exc.code}）。", status=exc.code)
        except Exception as exc:
            print(f"memewiki: {type(exc).__name__}", file=sys.stderr, flush=True)
            value = tool_error("MEMEWIKI_TOOL_FAILED", "词库操作失败。")
    else:
        return {"jsonrpc": "2.0", "id": identity, "error": {"code": -32601, "message": "Method not found"}}
    return {"jsonrpc": "2.0", "id": identity, "result": value}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    library = Library(args.data_dir)
    for line in sys.stdin:
        if len(line) > 128000:
            break
        try:
            response = dispatch(library, json.loads(line))
        except ValueError:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if response is not None:
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
