import hashlib
import http.client
import json
import pathlib
import struct
import tempfile
import threading
import unittest
from types import SimpleNamespace
from service import Engine, check_models, make_server, speech_input, transcription_input, validate_wav


def wav():
    return b"RIFF" + struct.pack("<I", 32036) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16) + b"data" + struct.pack("<I", 32000) + bytes(32000)


class FakeEngine:
    kind = "piper"
    calls = 0

    def speak(self, text):
        self.calls += 1
        return wav()


class VoiceBoundaryTests(unittest.TestCase):
    def test_whisper_receives_validated_raw_samples_without_media_decoder(self):
        import numpy as np
        captured = []

        class Model:
            def transcribe(self, samples, **options):
                captured.append((samples, options))
                return iter([SimpleNamespace(text=" Local voice ready. ")]), None

        engine = Engine.__new__(Engine)
        engine.model = Model()
        data = bytearray(wav())
        struct.pack_into("<hhh", data, 44, -32768, 0, 32767)
        self.assertEqual(engine.transcribe(data), {"text": "Local voice ready.", "language": "en", "duration": 1, "segments": []})
        samples, options = captured[0]
        self.assertIsInstance(samples, np.ndarray)
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.shape, (16000,))
        np.testing.assert_allclose(samples[:3], [-1, 0, 32767 / 32768])
        self.assertFalse(options["vad_filter"])
        with self.assertRaises(ValueError):
            engine.transcribe(b"OggS" + bytes(data[4:]))
        self.assertEqual(len(captured), 1)

    def test_pcm_bounds_and_duration(self):
        self.assertEqual(validate_wav(wav()), 1)
        for data in [b"", wav() + b"xx", bytes(960046), b"OggS" + wav()[4:]]:
            with self.assertRaises(ValueError):
                validate_wav(data)

    def test_strict_speech_fields(self):
        request = {"model": "en_US-ljspeech-medium", "voice": "ljspeech", "input": "Hello.", "response_format": "wav"}
        self.assertEqual(speech_input(json.dumps(request)), "Hello.")
        for modified in [dict(request, input="x" * 4001), dict(request, model="../../outside"), dict(request, instructions="secret"), dict(request, speed=2)]:
            with self.assertRaises(ValueError):
                speech_input(json.dumps(modified))
        with self.assertRaises(ValueError):
            speech_input('{"input":"a","input":"b"}')

    def test_bounded_multipart(self):
        body = b'--fixture\r\nContent-Disposition: form-data; name="model"\r\n\r\ntiny.en\r\n--fixture\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n' + wav() + b'\r\n--fixture--\r\n'
        self.assertEqual(transcription_input(body, "multipart/form-data; boundary=fixture"), wav())
        with self.assertRaises(ValueError):
            transcription_input(body.replace(b'name="model"', b'name="execute"'), "multipart/form-data; boundary=fixture")

    def test_model_integrity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "model.bin").write_bytes(b"model")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps([{"engine": "whisper", "file": "model.bin", "bytes": 5, "sha256": hashlib.sha256(b"model").hexdigest()}]))
            check_models(root, manifest, "whisper")
            (root / "model.bin").write_bytes(b"wrong")
            with self.assertRaises(ValueError):
                check_models(root, manifest, "whisper")

    def request(self, method, path, data=None, headers=None):
        engine = FakeEngine()
        server = make_server(("127.0.0.1", 0), engine)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
            client.request(method, path, data, headers or {})
            response = client.getresponse()
            result = response.status, response.read(), response.getheader("Cache-Control"), engine.calls
            client.close()
            return result
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_real_http_synthesis(self):
        result = self.request("POST", "/v1/audio/speech", json.dumps({"model": "en_US-ljspeech-medium", "voice": "ljspeech", "input": "Hello.", "response_format": "wav"}), {"Content-Type": "application/json"})
        self.assertEqual(result, (200, wav(), "no-store", 1))

    def test_http_errors_do_not_echo_requests(self):
        for method in ["POST", "SECRET_CANARY_METHOD"]:
            status, data, _, calls = self.request(method, "/SECRET_CANARY_PATH", "SECRET_CANARY_BODY", {"Content-Type": "application/json"})
            self.assertGreaterEqual(status, 400)
            self.assertNotIn(b"SECRET_CANARY", data)
            self.assertEqual(calls, 0)

    def test_http_size_gate(self):
        result = self.request("POST", "/v1/audio/speech", "x", {"Content-Type": "application/json", "Content-Length": "1100001"})
        self.assertEqual(result[0], 413)
        self.assertEqual(result[3], 0)


if __name__ == "__main__":
    unittest.main()
