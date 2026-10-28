"""MCP stdio transport for the package's public dictionary and PNG renderer."""
import argparse
import json
import sys
from library import Library, card


def schema(properties=None, required=None):
    return {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}


TOOLS = [
    {"name": "memewiki_lookup", "description": "查询公共梗词库。当前聊天的自定义黑话请使用 memewiki 插件的 search_meme_wiki。",
     "inputSchema": schema({"query": {"type": "string", "minLength": 1, "maxLength": 80}, "online": {"type": "boolean"}}, ["query"])},
    {"name": "memewiki_card", "description": "将查到的词条绘制成图片卡片。",
     "inputSchema": schema({key: {"type": "string", "maxLength": 4000} for key in ("title", "usage", "origin", "other", "summary", "source")}, ["title"])},
    {"name": "memewiki_sync_step", "description": "从 cnmeme.wiki 增量检查一页词条；保留已存在的词库，可继续执行直到 done。", "inputSchema": schema()},
    {"name": "memewiki_info", "description": "读取随包词库条目数与快照摘要。", "inputSchema": schema()},
]
for tool in TOOLS:
    tool["annotations"] = {"readOnlyHint": tool["name"] != "memewiki_sync_step", "destructiveHint": False,
                           "openWorldHint": tool["name"] in {"memewiki_lookup", "memewiki_sync_step"}}


def call(library, name, args):
    tool = next((t for t in TOOLS if t["name"] == name), None)
    if not tool or not isinstance(args, dict):
        raise ValueError("工具或参数无效")
    shape = tool["inputSchema"]
    if set(args) - set(shape["properties"]) or any(k not in args for k in shape["required"]):
        raise ValueError("工具参数缺失或包含未知字段")
    for key, value in args.items():
        prop = shape["properties"][key]
        if prop["type"] == "boolean" and not isinstance(value, bool):
            raise ValueError("开关参数须为布尔值")
        if prop["type"] == "string" and (not isinstance(value, str) or len(value) > prop["maxLength"]):
            raise ValueError("文本参数无效或过长")
    if name == "memewiki_card":
        return {"content": [{"type": "image", "mimeType": "image/png", "data": card(args)}], "isError": False}
    if name == "memewiki_lookup":
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
        except Exception as exc:
            print(f"memewiki: {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            value = {"content": [{"type": "text", "text": "词库操作失败，请检查参数、网络或插件依赖。"}], "isError": True}
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
