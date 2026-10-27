"""Local Vosk -> JSON lines -> Windows SAPI -> selected audio output.

No credentials or network calls. Half duplex deliberately discards captured audio
while generating/speaking; two virtual cables must isolate call input and output.
"""
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import wave


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def render_speech(text, voice, filename, settings=None):
    """Render a local WAV without playing or sending it anywhere."""
    if settings and settings.get("tts") == "edge":
        import asyncio
        import edge_tts
        import imageio_ffmpeg
        mp3 = filename + ".mp3"
        async def synthesize():
            await edge_tts.Communicate(text[:500], voice or "zh-CN-XiaoyiNeural",
                                       rate=settings.get("rate", "+5%"), pitch=settings.get("pitch", "+25Hz")).save(mp3)
        try:
            asyncio.run(asyncio.wait_for(synthesize(), timeout=18))
            subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-y", "-i", mp3,
                            "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", filename],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=10, creationflags=0x08000000)
        finally:
            if os.path.exists(mp3):
                os.remove(mp3)
        return
    ps = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32",
                      "WindowsPowerShell", "v1.0", "powershell.exe")
    # Values go through stdin JSON, never interpolated as PowerShell code.
    script = ("[Console]::InputEncoding=[Text.Encoding]::UTF8; "
              "$v=[Console]::In.ReadToEnd()|ConvertFrom-Json; Add-Type -AssemblyName System.Speech; "
              "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
              "if($v.voice){$s.SelectVoice($v.voice)}else{$s.SelectVoiceByHints("
              "[System.Speech.Synthesis.VoiceGender]::Female,[System.Speech.Synthesis.VoiceAge]::Adult,"
              "0,[Globalization.CultureInfo]::GetCultureInfo('zh-CN'))}; "
              "$s.SetOutputToWaveFile($v.file);$s.Speak($v.text);$s.Dispose()")
    payload = json.dumps({"text": text[:500], "voice": voice, "file": filename}, ensure_ascii=False)
    child = subprocess.Popen([ps, "-NoProfile", "-NonInteractive", "-Command", script],
                             stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, creationflags=0x08000000)
    try:
        child.communicate(payload.encode("utf-8"), timeout=15)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
        raise RuntimeError("TTS timeout")
    if child.returncode:
        raise RuntimeError("TTS failed")


def main():
    if "--sample" in sys.argv:
        request = json.loads(sys.stdin.readline())
        render_speech(request.get("text", "主人，小鲸鱼在这里，今天也要好好休息呀。"),
                      request["settings"]["voiceName"], request["file"], request["settings"])
        emit({"ok": True})
        return 0
    try:
        import sounddevice as sd
        from vosk import Model, KaldiRecognizer, SetLogLevel
    except ImportError:
        emit({"available": False, "error": "请在该 Python 环境安装 vosk 与 sounddevice。"})
        return 2
    if "--probe" in sys.argv:
        voices = []
        if os.name == "nt":
            ps = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
            script = ("[Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Speech; "
                      "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                      "ConvertTo-Json -InputObject @($s.GetInstalledVoices()|ForEach-Object{"
                      "@{name=$_.VoiceInfo.Name;culture=$_.VoiceInfo.Culture.Name}}) -Compress;$s.Dispose()")
            result = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", script],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=8, creationflags=0x08000000)
            if result.returncode == 0:
                voices = json.loads(result.stdout.decode("utf-8-sig"))
        emit({"available": True, "devices": [
            {"id": i, "name": row["name"], "input": row["max_input_channels"],
             "output": row["max_output_channels"], "sampleRate": row["default_samplerate"]}
            for i, row in enumerate(sd.query_devices())], "voices": voices})
        return 0
    config = json.loads(sys.stdin.readline())["settings"]
    if os.name != "nt":
        raise RuntimeError("Windows SAPI required")
    SetLogLevel(-1)
    model = Model(config["modelPath"])
    sample_rate = int(sd.query_devices(config["inputDevice"], "input")["default_samplerate"])
    recognizer = KaldiRecognizer(model, sample_rate)
    audio, commands = queue.Queue(maxsize=64), queue.Queue(maxsize=8)
    paused, stopping = threading.Event(), threading.Event()

    def control():
        for line in sys.stdin:
            try:
                item = json.loads(line)
                if item["type"] == "stop":
                    stopping.set()
                    break
                if item["type"] == "pause":
                    paused.set()
                elif item["type"] == "speak":
                    paused.set()
                    commands.put_nowait(item)
            except (ValueError, KeyError, queue.Full):
                stopping.set()
        stopping.set()

    def capture(data, frames, time, status):
        if not paused.is_set():
            try:
                audio.put_nowait(bytes(data))
            except queue.Full:
                pass

    threading.Thread(target=control, daemon=True).start()
    with tempfile.TemporaryDirectory(prefix="jingyu-audio-") as directory:
        with sd.RawInputStream(device=config["inputDevice"], samplerate=sample_rate,
                               dtype="int16", channels=1, blocksize=4000, callback=capture):
            emit({"type": "ready"})
            while not stopping.is_set():
                try:
                    command = commands.get_nowait()
                except queue.Empty:
                    command = None
                if command:
                    filename = os.path.join(directory, "reply.wav")
                    render_speech(command["text"], config["voiceName"], filename, config)
                    with wave.open(filename, "rb") as wav:
                        if wav.getsampwidth() != 2:
                            raise RuntimeError("Unsupported SAPI format")
                        with sd.RawOutputStream(device=config["outputDevice"], samplerate=wav.getframerate(),
                                                channels=wav.getnchannels(), dtype="int16") as output:
                            while not stopping.is_set():
                                chunk = wav.readframes(2048)
                                if not chunk:
                                    break
                                output.write(chunk)
                    os.remove(filename)
                    while not audio.empty():
                        audio.get_nowait()
                    recognizer.Reset()
                    paused.clear()
                    emit({"type": "spoken"})
                if paused.is_set():
                    stopping.wait(0.05)
                    continue
                try:
                    data = audio.get(timeout=0.1)
                except queue.Empty:
                    continue
                if recognizer.AcceptWaveform(data):
                    text = json.loads(recognizer.Result()).get("text", "").strip()
                    if text:
                        paused.set()
                        emit({"type": "transcript", "text": text[:500]})
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except Exception:
        emit({"type": "error"})
        sys.exit(1)
