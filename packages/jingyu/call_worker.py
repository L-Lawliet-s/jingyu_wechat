"""WeChat call adapter. Identity, account and payment permissions stay in host.

UI selectors and accessibility activation reuse jiatj/wechatapi (Apache-2.0),
04ef8cbde3862cff90b5f6b42c9ebfcea44ef48d. No coordinate-based dialing, no
auto-login, no process launch, and no optimistic 'connected' on a menu click.
"""
import ctypes
import json
import os
import re
import sys


def process_path(pid):
    from ctypes import wintypes
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.QueryFullProcessImageNameW.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        buffer, size = ctypes.create_unicode_buffer(32768), wintypes.DWORD(32768)
        return buffer.value if kernel.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)) else ""
    finally:
        kernel.CloseHandle(handle)


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def main():
    request = json.loads(sys.stdin.readline())
    expected = os.path.normcase(os.path.realpath(request["executable"]))
    if not os.path.isabs(expected) or not expected.lower().endswith("weixin.exe"):
        raise RuntimeError("CLIENT_INVALID")
    site = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
    if os.path.isdir(os.path.join(site, "pywin32_system32")):
        os.add_dll_directory(os.path.join(site, "pywin32_system32"))
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "vendor"))
    import uiautomation as auto
    from wechat_uia import WeChatUIA

    class ProjectWeChat(WeChatUIA):
        def _wechat_hwnds(self):
            return [h for h in super()._wechat_hwnds()
                    if os.path.normcase(os.path.realpath(process_path(self._pid_from_hwnd(h)))) == expected]

        def ensure_window(self, wake=False, timeout=None):
            # Do not run the upstream auto-login or launch fallback.
            return super().ensure_window(wake=False, timeout=timeout)

    driver = ProjectWeChat(timeout=4, search_timeout=0.5)
    peer, dialed = None, False

    def capabilities():
        window = driver._find_main()
        button = bool(window and window.ButtonControl(AutomationId="voip_button").Exists(0))
        return {"voice": button, "video": button, "accessible": bool(window), "connected": False}

    def call_window():
        for window in auto.GetRootControl().GetChildren():
            try:
                if os.path.normcase(os.path.realpath(process_path(window.ProcessId))) != expected:
                    continue
                if not re.search(r"voip|call", window.ClassName or "", re.I) and not re.search(r"语音通话|视频通话|通话中", window.Name or ""):
                    continue
                nodes = list(auto.WalkControl(window, maxDepth=6))[:200]
                texts = [window.Name or ""] + [control.Name or "" for control, _ in nodes]
                # Incoming calls are accepted only when their actual peer is
                # visible; an unrelated ringing window cannot match a task.
                if peer and not any(peer == text.strip() or peer in text and len(text) < len(peer)+20 for text in texts):
                    continue
                return window, nodes, texts
            except Exception:
                continue
        return None

    def state():
        found = call_window()
        if not found:
            return {"state": "waiting" if dialed else "idle", "connected": False, "windowPresent": False}
        _, _, texts = found
        timer = next((text for text in texts if re.fullmatch(r"(?:\d{1,2}:)?\d{1,2}:\d{2}", text.strip())), None)
        kind = "video" if any("视频" in text for text in texts) else "voice"
        if timer or any(text.strip() == "通话中" for text in texts):
            return {"state": "connected", "connected": True, "timer": timer, "windowPresent": True, "kind": kind}
        return {"state": "ringing", "connected": False, "windowPresent": True, "kind": kind}

    emit({"ready": True, **capabilities()})
    for line in sys.stdin:
        try:
            command = json.loads(line)
            action = command.get("action")
            if action == "quit":
                break
            if action == "probe":
                result = capabilities()
            elif action == "prepare":
                driver._wake_accessibility()
                result = capabilities()
            elif action == "watch":
                peer = command["name"]
                if not isinstance(peer, str) or not peer or len(peer) > 128:
                    raise RuntimeError("PEER_INVALID")
                result = {"state": "listening", "connected": False}
            elif action == "poll":
                result = state()
            elif action in ("accept", "hangup"):
                peer = command.get("name", peer)
                if not isinstance(peer, str) or not peer:
                    raise RuntimeError("PEER_INVALID")
                found = call_window()
                if not found:
                    raise RuntimeError("CALL_WINDOW_NOT_VERIFIED")
                _, nodes, _ = found
                names = ("接听", "接受") if action == "accept" else ("挂断", "结束通话", "取消")
                buttons = [control for control, _ in nodes if control.ControlTypeName == "ButtonControl" and control.Name in names]
                if len(buttons) != 1:
                    raise RuntimeError("CALL_BUTTON_AMBIGUOUS")
                buttons[0].Click()
                result = {"state": "connecting" if action == "accept" else "ending", "connected": False}
            else:
                raise RuntimeError("ACTION_INVALID")
            emit({"id": command.get("id"), "ok": True, **result})
        except Exception as error:
            code = str(error) if re.fullmatch(r"[A-Z_]{3,80}", str(error)) else "CALL_DRIVER_FAILED"
            emit({"id": command.get("id") if "command" in locals() else None, "ok": False, "code": code})


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        main()
    except Exception:
        emit({"ready": False, "code": "CALL_DRIVER_UNAVAILABLE"})
        sys.exit(1)
