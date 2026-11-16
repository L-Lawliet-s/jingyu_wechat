"""Play a clip while the owner holds the native recording shortcut."""
import base64
import ctypes
from ctypes import wintypes
import io
import json
import os
import sys
import time
import wave

from call_worker import process_path

CHAT_INPUT = "chat_input_field"


def main(request):
    import uiautomation as auto
    import sounddevice as sd

    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetForegroundWindow.restype = wintypes.HWND
    user.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user.GetAsyncKeyState.restype = ctypes.c_short
    executable = os.path.normcase(os.path.realpath(request["executable"]))
    pid = request["pid"]
    peer = request["name"]
    device = request["device"]
    if not pid or not executable.endswith("weixin.exe") or not isinstance(device, int) or device < 0:
        raise RuntimeError("CONFIG")

    def checked_window():
        hwnd = user.GetForegroundWindow()
        actual = wintypes.DWORD()
        if not hwnd or not user.GetWindowThreadProcessId(hwnd, ctypes.byref(actual)) or actual.value != pid:
            return None
        if os.path.normcase(os.path.realpath(process_path(pid))) != executable:
            return None
        return hwnd

    def key_held():
        return bool(user.GetAsyncKeyState(0x12) & 0x8000)

    with wave.open(io.BytesIO(base64.b64decode(request["audio"], validate=True)), "rb") as clip:
        sample_rate, channels, frames = clip.getframerate(), clip.getnchannels(), clip.getnframes()
        if clip.getsampwidth() != 2 or not 1 <= channels <= 2 or not 0 < frames / sample_rate <= 25:
            raise RuntimeError("CLIP_LENGTH")
        deadline = time.monotonic() + 18
        hwnd = None
        verified = (None, 0)
        while time.monotonic() < deadline:
            candidate = checked_window()
            if candidate:
                edit = auto.ControlFromHandle(candidate).EditControl(AutomationId=CHAT_INPUT, searchDepth=14)
                tick = time.monotonic()
                if edit.Exists(0, 0):
                    verified = (candidate, tick) if edit.Name == peer else (None, 0)
                # Some builds replace the chat edit while recording is visible.
                if key_held() and verified[0] == candidate and tick - verified[1] < 0.45:
                    hwnd = candidate
                    break
            else:
                verified = (None, 0)
            time.sleep(0.16)
        if not hwnd:
            raise RuntimeError("FOREGROUND")
        with sd.RawOutputStream(device=device, samplerate=sample_rate, channels=channels, dtype="int16") as output:
            time.sleep(0.35)
            while True:
                if not key_held() or user.GetForegroundWindow() != hwnd:
                    output.abort()
                    raise RuntimeError("INTERRUPTED")
                data = clip.readframes(1024)
                if not data:
                    break
                output.write(data)


if __name__ == "__main__":
    try:
        main(json.loads(sys.stdin.readline()))
        print('{"played":true}', flush=True)
    except Exception as error:
        code = str(error)
        print(json.dumps({"played": False, "code": code if code in {
            "CONFIG", "CLIP_LENGTH", "FOREGROUND", "INTERRUPTED"
        } else "DEVICE"}), flush=True)
