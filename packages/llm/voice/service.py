"""Bounded local speech adapters. No credentials, disk audio, inference downloads or raw logs."""
import argparse
import hashlib
import io
import json
import logging
import os
import pathlib
import struct
import threading
import wave
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_AUDIO = 960044
MAX_OUTPUT = 4194304


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("Duplicate field")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs)


def validate_wav(data):
    if not 46 <= len(data) <= MAX_AUDIO:
        raise ValueError("Invalid audio length")
    if data[:4] != b"RIFF" or data[8:16] != b"WAVEfmt " or data[36:40] != b"data":
        raise ValueError("Invalid audio header")
    if (struct.unpack_from("<I", data, 4)[0] != len(data) - 8
            or struct.unpack_from("<IHHIIHH", data, 16) != (16, 1, 1, 16000, 32000, 2, 16)
            or struct.unpack_from("<I", data, 40)[0] != len(data) - 44
            or (len(data) - 44) % 2):
        raise ValueError("Invalid PCM")
    return (len(data) - 44) / 32000


def transcription_input(data, content_type):
    if not content_type.startswith("multipart/form-data;") or len(content_type) > 256:
        raise ValueError("Multipart form required")
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: " + content_type.encode("ascii") + b"\r\nMIME-Version: 1.0\r\n\r\n" + data)
    if not message.is_multipart():
        raise ValueError("Invalid multipart")
    parts = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name not in {"model", "file", "response_format", "timestamp_granularities[]"} or name in parts or part.is_multipart():
            raise ValueError("Invalid form field")
        parts[name] = part.get_payload(decode=True)
    if parts.get("model") != b"tiny.en" or "file" not in parts:
        raise ValueError("Unsupported model")
    if parts.get("response_format", b"verbose_json") not in {b"verbose_json", b"json"}:
        raise ValueError("Unsupported format")
    if parts.get("timestamp_granularities[]", b"segment") != b"segment":
        raise ValueError("Unsupported timestamps")
    validate_wav(parts["file"])
    return parts["file"]


def speech_input(data):
    item = strict_json(data)
    if not isinstance(item, dict) or set(item) - {"model", "input", "voice", "response_format", "speed"}:
        raise ValueError("Invalid speech request")
    if item.get("model") != "en_US-ljspeech-medium" or item.get("voice") != "ljspeech" or item.get("response_format") != "wav" or item.get("speed", 1) != 1:
        raise ValueError("Unsupported voice")
    text = item.get("input")
    if not isinstance(text, str) or not text.strip() or len(text) > 4000:
        raise ValueError("Invalid text")
    return text


def check_models(directory, manifest, engine):
    entries = [item for item in strict_json(manifest.read_text(encoding="utf-8")) if item["engine"] == engine]
    if not entries:
        raise ValueError("Model manifest is empty")
    for item in entries:
        if pathlib.PurePosixPath(item["file"]).name != item["file"]:
            raise ValueError("Invalid model path")
        data = (directory / item["file"]).read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("Model checksum mismatch")


class Engine:
    def __init__(self, kind, directory, manifest):
        check_models(directory, manifest, kind)
        self.kind = kind
        if kind == "whisper":
            from faster_whisper import WhisperModel
            self.model = WhisperModel(str(directory), device="cpu", compute_type="int8", cpu_threads=2, num_workers=1, local_files_only=True)
        else:
            import onnxruntime
            from piper import PiperVoice
            from piper.config import PiperConfig
            onnxruntime.disable_telemetry_events()
            session = onnxruntime.SessionOptions()
            session.intra_op_num_threads = 2
            session.inter_op_num_threads = 1
            config = strict_json((directory / "en_US-ljspeech-medium.onnx.json").read_text(encoding="utf-8"))
            self.model = PiperVoice(config=PiperConfig.from_dict(config), session=onnxruntime.InferenceSession(
                str(directory / "en_US-ljspeech-medium.onnx"), sess_options=session, providers=["CPUExecutionProvider"]))

    def transcribe(self, data):
        import numpy as np
        seconds = validate_wav(data)
        samples = np.frombuffer(data, dtype="<i2", offset=44).astype(np.float32) / 32768
        segments, _ = self.model.transcribe(samples, language="en", beam_size=1, vad_filter=False, condition_on_previous_text=False)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        if len(text) > 12000:
            raise ValueError("Transcript exceeds limit")
        return {"text": text, "language": "en", "duration": seconds, "segments": []}

    def speak(self, text):
        result = io.BytesIO()
        with wave.open(result, "wb") as wav:
            self.model.synthesize_wav(text, wav)
        data = result.getvalue()
        if len(data) > MAX_OUTPUT:
            raise ValueError("Speech exceeds limit")
        return data


def make_server(address, engine):
    admission = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        server_version = "SazuzVoice"
        sys_version = ""

        def log_message(self, _format, *_args):
            return  # The application keeps metadata receipts; paths, requests and model errors are private.

        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def send_error(self, code, message=None, explain=None):
            self.output(code, b'{"error":"request_rejected"}')

        def output(self, status, data, media_type="application/json"):
            self.send_response(status)
            self.send_header("Content-Type", media_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self.output(200 if self.path == "/health" else 404, b'{"ready":true}' if self.path == "/health" else b'{"error":"not_found"}')

        def do_POST(self):
            if not admission.acquire(blocking=False):
                self.output(429, b'{"error":"busy"}')
                return
            watchdog = None
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not lengths[0].isdigit() or self.headers.get("Transfer-Encoding"):
                    raise ValueError("A bounded body is required")
                length = int(lengths[0])
                if not 1 <= length <= 1_100_000:
                    self.output(413, b'{"error":"too_large"}')
                    return
                data = self.rfile.read(length)
                if len(data) != length:
                    raise ValueError("Incomplete body")
                content_type = self.headers.get("Content-Type", "")
                if self.path == "/v1/audio/transcriptions" and engine.kind == "whisper":
                    argument = transcription_input(data, content_type)
                elif self.path == "/v1/audio/speech" and engine.kind == "piper" and content_type.split(";")[0] == "application/json":
                    argument = speech_input(data)
                else:
                    raise ValueError("Unsupported speech operation")
                # Bound native inference too. Compose restarts this isolated service; the caller's durable intent remains uncertain.
                watchdog = threading.Timer(55, lambda: os._exit(2))
                watchdog.daemon = True
                watchdog.start()
                if engine.kind == "whisper":
                    self.output(200, json.dumps(engine.transcribe(argument)).encode("utf-8"))
                else:
                    self.output(200, engine.speak(argument), "audio/wav")
            except (ValueError, UnicodeError, TypeError, KeyError):
                self.output(400, b'{"error":"invalid_request"}')
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                print('voice.response_unconfirmed', flush=True)
            except Exception:
                print('voice.inference_failed', flush=True)
                self.output(503, b'{"error":"inference_failed"}')
            finally:
                if watchdog:
                    watchdog.cancel()
                admission.release()

    class Server(ThreadingHTTPServer):
        def handle_error(self, _request, _address):
            print('voice.request_failed', flush=True)
    return Server(address, Handler)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["whisper", "piper"], required=True)
    parser.add_argument("--models", type=pathlib.Path, default=pathlib.Path("/models"))
    parser.add_argument("--manifest", type=pathlib.Path, default=pathlib.Path("/app/models.json"))
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["DO_NOT_TRACK"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    logging.disable(logging.CRITICAL)
    try:
        model = Engine(args.engine, args.models, args.manifest)
        make_server((args.host, args.port), model).serve_forever()
    except Exception:
        print('voice.startup_failed', flush=True)
        raise SystemExit(1) from None
