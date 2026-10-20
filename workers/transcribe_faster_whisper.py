#!/usr/bin/env python3
"""Local transcription worker for dsh-voice-memo (engine: command).

Reads one canonical 16 kHz mono PCM16 WAV, transcribes it with faster-whisper
and prints exactly one JSON object on stdout. Diagnostics go to stderr, so a
caller can always parse stdout.

    {"engine":"faster-whisper","model":"small","language":"zh",
     "segments":[{"start":0.0,"end":2.4,"text":"..."}],"text":"..."}

Setup (the plugin never installs anything for you):

    python -m venv .venv
    .venv\\Scripts\\pip install faster-whisper
    .venv\\Scripts\\python workers/transcribe_faster_whisper.py --model small sample.wav

Then point the plugin at it (flags such as --model belong in the command array,
because the Plugin Config deliberately only carries mode/command/providerId/
timeoutSec):

    asr:
      mode: command
      command:
        - "D:\\\\path\\\\.venv\\\\Scripts\\\\python.exe"
        - "D:\\\\Projects\\\\dsh-voice-memo\\\\workers\\\\transcribe_faster_whisper.py"
        - "--model"
        - "small"
"""

from __future__ import annotations

import argparse
import json
import sys
import time


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="faster-whisper worker for dsh-voice-memo")
    parser.add_argument("wav", help="16 kHz mono PCM16 WAV path (produced by the plugin)")
    parser.add_argument("--model", default="small", help="faster-whisper model name or local path (default: small)")
    parser.add_argument("--language", default=None, help="language hint, e.g. zh / en; auto when omitted")
    parser.add_argument("--device", default="cpu", help="cpu or cuda (default: cpu)")
    parser.add_argument("--compute-type", default="int8", help="int8 / float16 / float32 (default: int8)")
    parser.add_argument("--beam-size", type=int, default=5)
    parser.add_argument("--vad", action="store_true", help="enable faster-whisper's built-in VAD filter")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    # Windows pipes default to the ANSI code page (cp936 here), which would hand
    # the plugin mojibake. The contract is UTF-8 JSON on stdout, so say so.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    args = parse_args(argv)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "faster-whisper is not installed for this interpreter.\n"
            "Install it with: python -m pip install faster-whisper",
            file=sys.stderr,
        )
        return 2

    started = time.monotonic()
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
        segments, info = model.transcribe(
            args.wav,
            language=args.language,
            beam_size=args.beam_size,
            vad_filter=args.vad,
        )
        collected = []
        for segment in segments:
            text = (segment.text or "").strip()
            if not text:
                continue
            collected.append(
                {
                    "start": round(float(segment.start), 3),
                    "end": round(float(segment.end), 3),
                    "text": text,
                }
            )
    except Exception as error:  # noqa: BLE001 - the caller needs the message, not a traceback
        print(f"transcription failed: {error}", file=sys.stderr)
        return 1

    language = getattr(info, "language", None) or args.language or "auto"
    print(
        json.dumps(
            {
                "engine": "faster-whisper",
                "model": args.model,
                "language": language,
                "segments": collected,
                "text": "".join(item["text"] for item in collected),
                "audioSeconds": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
                "elapsedSeconds": round(time.monotonic() - started, 3),
            },
            ensure_ascii=False,
        ),
        file=sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
