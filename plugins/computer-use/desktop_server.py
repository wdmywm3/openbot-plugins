"""OpenBot's private, window-scoped MCP adapter for the pinned Windows Cua SDK."""
import asyncio
import ctypes
from ctypes import wintypes
import json
import math
import os
import re
import subprocess
import sys
import threading
import uuid


IDLE_SECONDS = 90
CALL_SECONDS = 18
MAX_FRAME = 64 * 1024
MAX_RESULT = 5 * 1024 * 1024
VERBS = ("windows", "open_app", "view", "act", "screenshot", "finish")
TOOL = {
    "name": "desktop_step", "description": "执行由 OpenBot 绑定到当前任务的窗口操作。",
    "inputSchema": {"type": "object", "additionalProperties": False,
                    "properties": {"owner": {"type": "string", "minLength": 1, "maxLength": 2048},
                                   "operation": {"type": "string", "enum": list(VERBS)},
                                   "input": {"type": "object"}},
                    "required": ["owner", "operation", "input"]},
}

kernel = ctypes.WinDLL("kernel32", use_last_error=True)
user = ctypes.WinDLL("user32", use_last_error=True)
kernel.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
kernel.CreateMutexW.restype = wintypes.HANDLE
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.GetCurrentThreadId.argtypes = []
kernel.GetCurrentThreadId.restype = wintypes.DWORD
user.GetThreadDesktop.argtypes = [wintypes.DWORD]
user.GetThreadDesktop.restype = wintypes.HANDLE
user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p,
                                          wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
user.GetUserObjectInformationW.restype = wintypes.BOOL
user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user.GetWindowThreadProcessId.restype = wintypes.DWORD
user.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
user.GetAncestor.restype = wintypes.HWND
user.IsIconic.argtypes = [wintypes.HWND]


def integer(value, low=1, high=2**53 - 1):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("整数参数超出范围。")
    return value


def geometry(pid, hwnd):
    actual_pid, rect = wintypes.DWORD(), wintypes.RECT()
    thread = user.GetWindowThreadProcessId(hwnd, ctypes.byref(actual_pid))
    if not thread or actual_pid.value != pid or user.GetAncestor(hwnd, 2) != hwnd:
        raise ValueError("目标窗口已关闭或身份已变化，请重新查找窗口。")
    if not user.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise ValueError("无法核对目标窗口的位置。")
    return thread, rect.left, rect.top, rect.right, rect.bottom, bool(user.IsIconic(hwnd))


def require_input_desktop():
    desktop = user.GetThreadDesktop(kernel.GetCurrentThreadId())
    receiving, needed = wintypes.BOOL(), wintypes.DWORD()
    # UOI_IO checks the worker's own desktop, including an interactive RDP desktop.
    if not desktop or not user.GetUserObjectInformationW(desktop, 6, ctypes.byref(receiving),
                                                         ctypes.sizeof(receiving), ctypes.byref(needed)):
        raise ValueError("foreground_desktop_unknown：Windows 无法确认当前桌面能接收键鼠输入，本次未发送前台输入。请回到运行 OpenBot 的桌面，重新观察窗口。")
    if not receiving.value:
        raise ValueError("foreground_desktop_inactive：运行 OpenBot 的 Windows 桌面当前未接收键鼠输入，本次未发送前台输入。请回到同一个已解锁桌面。使用远程桌面时，请将客户端窗口恢复为可见并确认能手动点击，再重新观察窗口。")


def point(data, xkey, ykey, size):
    values = [data.get(xkey), data.get(ykey)]
    if any(type(v) not in (float, int) or not math.isfinite(v) or not 0 <= v <= 1 for v in values):
        raise ValueError("请提供当前窗口图片中成对的 0 到 1 坐标。")
    if not size:
        raise ValueError("坐标操作需要带图片的最新窗口观察。")
    return [round(v * (length - 1)) for v, length in zip(values, size)]


def content(value, image=None):
    blocks = [{"type": "text", "text": json.dumps(value, ensure_ascii=False, separators=(",", ":"))}]
    if image:
        blocks.append({"type": "image", "mimeType": image.mime_type, "data": image.data_base64})
    return {"content": blocks}


class Desktop:
    def __init__(self):
        self.driver = None
        self.handle = self.owner = self.view = self.timer = None
        self.allow_foreground = json.loads(os.environ.get("OPENBOT_COMPUTER_CONFIG", "{}")).get("allowForeground") is True

    def release(self):
        if self.timer:
            self.timer.cancel()
        if self.handle:
            kernel.CloseHandle(self.handle)
        self.handle = self.owner = self.view = self.timer = None

    def acquire(self, owner):
        if self.handle and self.owner != owner:
            raise ValueError("桌面正在由另一项任务使用，请稍后再试。")
        if not self.handle:
            # The Local namespace is tied to the actual Windows logon session.
            # Holding the sole handle reserves it across instances, even between calls.
            ctypes.set_last_error(0)
            handle = kernel.CreateMutexW(None, False, r"Local\OpenBot.ComputerUse.Desktop.v1")
            if not handle:
                raise ctypes.WinError(ctypes.get_last_error())
            if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
                kernel.CloseHandle(handle)
                raise ValueError("另一个实例正在操作此桌面，请稍后再试。")
            self.handle, self.owner = handle, owner
        if self.timer:
            self.timer.cancel()
        self.timer = asyncio.get_running_loop().call_later(IDLE_SECONDS, self.release)

    async def call(self, name, args):
        if self.driver is None:
            from cua_driver import CuaDriver
            self.driver = CuaDriver.create(embedded=True)
        result = await self.driver.call_tool(name, json.dumps(args, ensure_ascii=False))
        if result.is_error:
            if args.get("delivery_mode") == "foreground" and "foreground_unavailable" in (result.error_code or "") + result.text:
                raise ValueError("foreground_unavailable：Windows 未能将前台输入送到选定窗口。请将该窗口切到前台，重新观察并核对当前状态。\n" + result.text[:600])
            raise ValueError(f"{result.error_code or name}：{result.text[:900]}")
        data = json.loads(result.structured_json) if result.structured_json else {}
        return result, data

    async def windows(self, args):
        query = args.get("query", "").strip().casefold()
        request = {"pid": integer(args["pid"])} if "pid" in args else {}
        _, data = await self.call("list_windows", request)
        rows = [dict(pid=w["pid"], window_id=w["window_id"], app=str(w.get("app_name") or "")[:180],
                     title=str(w.get("title") or "")[:280], minimized=bool(w.get("minimized")))
                for w in data["windows"] if query in (str(w.get("title") or "") + " " + str(w.get("app_name") or "")).casefold()]
        return content({"windows": rows[:40], "more": len(rows) > 40})

    async def observe(self, args, image_requested):
        self.view = None
        pid, hwnd = integer(args.get("pid"), high=2**32 - 1), integer(args.get("window_id"))
        initial = geometry(pid, hwnd)
        if image_requested and initial[-1]:
            raise ValueError("目标窗口已最小化，无法取得可靠图片。可先读取控件文字，或请用户恢复窗口。")
        request = {"pid": pid, "window_id": hwnd, "include_screenshot": image_requested,
                   "include_accessibility_tree": True, "max_elements": 160, "max_depth": 12, "timeout_ms": 5000}
        if args.get("query"):
            # The SDK filters the tree after the bounded walk. Search farther for a named control.
            request.update(query=args["query"], max_elements=640, max_depth=20)
        for edge in (1280, 768):
            result, data = await self.call("get_window_state", {**request, "max_image_dimension": edge})
            image = result.images[0] if image_requested and result.images else None
            if not image or len(image.data_base64) <= 4 * 1024 * 1024:
                break
        if data.get("pid") != pid or data.get("window_id") != hwnd or not data.get("snapshot_id"):
            raise ValueError("驱动未核实指定窗口，请重新观察。")
        if geometry(pid, hwnd) != initial:
            raise ValueError("观察期间窗口位置或状态已变化，请重新观察。")
        size = None
        if image_requested:
            if not image or image.mime_type != "image/png" or len(image.data_base64) > 4 * 1024 * 1024:
                raise ValueError("未取得可用的窗口图片。")
            size = (integer(data.get("screenshot_width")), integer(data.get("screenshot_height")))
        token = uuid.uuid4().hex
        self.view = {"id": token, "pid": pid, "hwnd": hwnd, "geometry": initial,
                     "snapshot": data["snapshot_id"], "size": size, "capture": data.get("capture_id")}
        tree = str(data.get("tree_markdown") or result.text)
        return content({"view": token, "pid": pid, "window_id": hwnd, "title": str(data.get("window_title") or "")[:280],
                        "snapshot": data["snapshot_id"], "tree": tree[:16000],
                        "truncated": bool(data.get("truncated")) or len(tree) > 16000,
                        **({"image_size": size} if size else {})}, image)

    async def act(self, args):
        view = self.view
        if not view or args.get("view") != view["id"]:
            raise ValueError("窗口观察已失效，请先重新读取目标窗口。")
        action = args.get("action")
        extras = {"click": {"button", "count"}, "type": {"text"}, "key": {"key", "modifiers"},
                  "scroll": {"direction", "amount"}, "drag": {"to_x", "to_y"}}
        if action not in extras or set(args) - ({"view", "action", "foreground", "element", "x", "y"} | extras[action]):
            raise ValueError("动作或参数与选定的操作不匹配。")
        now = geometry(view["pid"], view["hwnd"])
        if now[0] != view["geometry"][0]:
            self.view = None
            raise ValueError("目标窗口已变化，请重新观察。")
        target = {"kind": "window", "pid": view["pid"], "window_id": view["hwnd"]}
        request = {"target": target, "delivery_mode": "foreground" if args.get("foreground") is True else "background"}
        element = args.get("element")
        pixels = "x" in args or "y" in args
        if element is not None:
            if pixels or action == "drag" or not re.fullmatch(re.escape(view["snapshot"]) + r":\d+", element):
                raise ValueError("控件编号须来自当前观察，且不能与图片坐标混用。")
            request["element_token"] = element
        if pixels:
            if now != view["geometry"] or now[-1]:
                raise ValueError("窗口位置或显示状态已变化，请重新取得窗口图片。")
            x, y = point(args, "x", "y", view["size"])
            if action == "drag":
                request["from_x"], request["from_y"] = x, y
                request["to_x"], request["to_y"] = point(args, "to_x", "to_y", view["size"])
            else:
                request["x"], request["y"] = x, y
                if action == "click" and view["capture"]:
                    request["capture_id"] = view["capture"]
        if action in ("click", "type", "drag") and not (element or pixels):
            raise ValueError("此动作需要当前控件编号或窗口图片坐标。")
        if action == "click":
            button = args.get("button", "left")
            if button not in ("left", "right", "middle"):
                raise ValueError("鼠标按键无效。")
            request.update(button=button, count=integer(args.get("count", 1), 1, 3))
        elif action == "type":
            value = args.get("text")
            if not isinstance(value, str) or not 1 <= len(value) <= 4000:
                raise ValueError("本次填写需要 1 到 4000 个字符。")
            request["text"] = value
        elif action == "key":
            key, modifiers = args.get("key", ""), args.get("modifiers", [])
            if not re.fullmatch(r"[a-zA-Z0-9]{1,24}", key) or not isinstance(modifiers, list) or any(m not in ("ctrl", "shift", "alt") for m in modifiers):
                raise ValueError("按键或修饰键无效。")
            request.update(key=key, modifiers=modifiers)
        elif action == "scroll":
            if args.get("direction") not in ("up", "down", "left", "right"):
                raise ValueError("滚动方向无效。")
            request.update(direction=args["direction"], amount=integer(args.get("amount", 3), 1, 50))
        # Once submitted, even an error may follow a partial side effect.
        self.view = None
        if request["delivery_mode"] == "foreground":
            require_input_desktop()
        name = {"type": "type_text", "key": "press_key"}.get(action, action)
        result, state = await self.call(name, request)
        return content({"action": action, "driver_result": result.text[:1800], "degraded": result.degraded,
                        **{key: state[key] for key in ("effect", "route") if key in state}})

    async def step(self, arguments):
        owner, op, args = arguments["owner"], arguments["operation"], arguments["input"]
        if not isinstance(owner, str) or not 0 < len(owner) <= 2048 or not isinstance(args, dict) or op not in VERBS:
            raise ValueError("桌面任务参数无效。")
        if op == "windows":
            return await self.windows(args)
        if op == "finish":
            released = self.owner == owner
            if released:
                self.release()
            return content({"released": released})
        if op == "act" and self.owner != owner:
            raise ValueError("本次任务没有有效窗口观察，请先读取窗口。")
        if (op == "open_app" or args.get("foreground") is True) and not self.allow_foreground:
            raise ValueError("当前实例未允许打开应用或激活窗口。")
        fresh = self.handle is None
        self.acquire(owner)
        try:
            if op == "act":
                return await self.act(args)
            if op == "open_app":
                name = args.get("name", "").strip()
                if not re.fullmatch(r"[\w][\w .()+-]{0,99}", name) or ".." in name:
                    raise ValueError("请使用应用显示名称。")
                self.view = None
                result, data = await self.call("launch_app", {"name": name})
                return content({"pid": data.get("pid"), "driver_result": result.text[:1200]})
            return await self.observe(args, op == "screenshot" or args.get("image") is True)
        except Exception:
            if fresh:
                self.release()
            raise


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode() + b"\n"


def failure(message):
    return {"isError": True, "content": [{"type": "text", "text": message[:1200]}]}


def follow_parent(parent_pid):
    # An abruptly stopped MCP server must not leave a native action or lock behind.
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    parent = kernel.OpenProcess(0x00100000, False, parent_pid)  # SYNCHRONIZE
    if not parent:
        os._exit(1)
    kernel.WaitForSingleObject(parent, 0xFFFFFFFF)
    os._exit(0)


async def run_driver(parent_pid):
    threading.Thread(target=follow_parent, args=(parent_pid,), daemon=True).start()
    # Embedded Python has no per-monitor DPI manifest of its own.
    user.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    user.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))  # PER_MONITOR_AWARE_V2
    desktop = Desktop()
    try:
        while line := await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME + 1):
            if len(line) > MAX_FRAME:
                break
            try:
                answer = await desktop.step(json.loads(line))
            except Exception as exc:
                answer = failure(str(exc))
            sys.stdout.buffer.write(encode(answer))
            sys.stdout.buffer.flush()
    finally:
        desktop.release()
        if desktop.driver is not None:
            await desktop.driver.shutdown()


class DriverWorker:
    def __init__(self):
        self.process = None

    async def start(self):
        if self.process is None or self.process.returncode is not None:
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-I", "-B", "-u", __file__, "--driver", str(os.getpid()),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL, limit=MAX_RESULT, creationflags=subprocess.CREATE_NO_WINDOW)

    async def exchange(self, arguments):
        self.process.stdin.write(encode(arguments))
        await self.process.stdin.drain()
        line = await self.process.stdout.readline()
        if not line:
            raise ConnectionError("桌面驱动中断，操作结果未知，请重新观察。")
        return json.loads(line)

    async def stop(self):
        process, self.process = self.process, None
        if process is not None:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()


def send(request_id, result=None, error=None):
    message = {"jsonrpc": "2.0", "id": request_id}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    sys.stdout.buffer.write(encode(message))
    sys.stdout.buffer.flush()


async def serve():
    worker = DriverWorker()
    active = active_id = None

    async def run(request_id, arguments):
        try:
            result = await asyncio.wait_for(worker.exchange(arguments), CALL_SECONDS)
            send(request_id, result)
        except asyncio.CancelledError:
            await worker.stop()
        except TimeoutError:
            await worker.stop()
            send(request_id, failure("桌面驱动超时，操作结果未知，请重新观察。"))
        except Exception as exc:
            await worker.stop()
            send(request_id, failure(str(exc)))

    while True:
        line = await asyncio.to_thread(sys.stdin.buffer.readline, MAX_FRAME + 1)
        if not line or len(line) > MAX_FRAME:
            break
        try:
            packet = json.loads(line)
            method, request_id, params = packet["method"], packet.get("id"), packet.get("params", {})
            if not isinstance(method, str) or not isinstance(params, dict):
                raise ValueError("Invalid request")
        except (ValueError, KeyError, TypeError, AttributeError):
            send(None, error={"code": -32600, "message": "Invalid request"})
            continue
        if request_id is None:
            if method == "notifications/cancelled" and active and not active.done() and params.get("requestId") == active_id:
                active.cancel()
            continue
        if method == "initialize":
            versions = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
            version = params.get("protocolVersion")
            send(request_id, {"protocolVersion": version if version in versions else versions[0],
                              "capabilities": {"tools": {}}, "serverInfo": {"name": "openbot-computer-use", "version": "0.1.0"}})
        elif method == "ping":
            send(request_id, {})
        elif method == "tools/list":
            send(request_id, {"tools": [TOOL]})
        elif method == "tools/call" and params.get("name") == TOOL["name"]:
            if active and not active.done():
                send(request_id, failure("桌面调用正在执行，请稍后再试。"))
            else:
                try:
                    await worker.start()
                except OSError as exc:
                    send(request_id, failure(str(exc)))
                    continue
                active_id = request_id
                active = asyncio.create_task(run(request_id, params.get("arguments", {})))
        else:
            send(request_id, error={"code": -32601, "message": "Unsupported method or tool"})
    if active and not active.done():
        active.cancel()
        await asyncio.gather(active, return_exceptions=True)
    await worker.stop()


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--driver":
        asyncio.run(run_driver(int(sys.argv[2])))
    else:
        asyncio.run(serve())
