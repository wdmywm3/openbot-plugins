"""Read the test desktop's input state and optionally wait for focus to return."""
import ctypes
from ctypes import wintypes
import json
import sys
import time

user = ctypes.WinDLL("user32", use_last_error=True)
kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.GetCurrentThreadId.restype = wintypes.DWORD
user.GetThreadDesktop.argtypes = [wintypes.DWORD]
user.GetThreadDesktop.restype = wintypes.HANDLE
user.GetForegroundWindow.restype = wintypes.HWND
user.GetUserObjectInformationW.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD)]

desktop = user.GetThreadDesktop(kernel.GetCurrentThreadId())
receives_input, needed = wintypes.BOOL(), wintypes.DWORD()
if not user.GetUserObjectInformationW(desktop, 6, ctypes.byref(receives_input), 4, ctypes.byref(needed)):
    raise ctypes.WinError(ctypes.get_last_error())
if len(sys.argv) == 3 and sys.argv[1] == "--watch":
    target = int(sys.argv[2])
    # Observe only whether the test HWND takes the Windows foreground. A renderer
    # may report document.hasFocus() even when a background click was posted.
    print("ready", flush=True)
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        if user.GetForegroundWindow() == target:
            sys.exit(0)
        time.sleep(0.002)
    sys.exit(1)
expected = int(sys.argv[1]) if len(sys.argv) > 1 else None
deadline = time.monotonic() + 3
while expected and user.GetForegroundWindow() != expected and time.monotonic() < deadline:
    time.sleep(0.05)
print(json.dumps({"receivesInput": bool(receives_input.value), "foreground": user.GetForegroundWindow() or 0}))
