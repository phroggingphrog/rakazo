import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

spec = importlib.util.spec_from_file_location("sender", Path(__file__).with_name("incident-webhook.py"))
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class Tests(unittest.TestCase):
    def test_context_allowlist(self):
        event = sender.payload("runner", "bot", "tool-failed", "event", {"tool": "computer.command", "run_id": "run1", "thread_id": "bad\nvalue", "error": "secret"})
        self.assertEqual(event["context"], {"tool": "computer.command", "run_id": "run1"})

    def test_contract_rejects_raw_text(self):
        for unit in ("bad\ncommand", "token=secret", "a" * 121):
            with self.assertRaises(ValueError):
                sender.payload("runner", unit, "tool-failed", "1")
        event = sender.payload("self-test", "test", "diagnostic-test", "1")
        self.assertEqual(event, sender.payload("self-test", "test", "diagnostic-test", "1"))
        self.assertEqual(event["event_ref"], "1")
        self.assertEqual(set(event), {"id", "source", "unit", "outcome", "message", "event_ref"})

    def test_error_detail_allowlist(self):
        event = sender.payload("runner", "bot", "tool-failed", "event", {"error_category":"timeout", "error":"SECRET", "url":"https://private.invalid"})
        self.assertEqual(event["context"], {"error_category":"timeout"})
        self.assertNotIn("context", sender.payload("runner", "bot", "tool-failed", "event", {"error_category":"SECRET"}))

    def test_disabled_sender_never_opens_network(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg = root / "credential.json"
            cfg.write_text(json.dumps({"enabled": False}))
            cfg.chmod(0o600)
            self.assertEqual(sender.send(cfg, root / "state.json", {}), "disabled")
            self.assertFalse((root / "state.json").exists())

    def test_delivery_and_dedup(self):
        received = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append((self.headers["Idempotency-Key"], json.loads(self.rfile.read(int(self.headers["Content-Length"])))))
                self.send_response(202)
                self.end_headers()

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as folder:
                config = Path(folder) / "credential"
                config.write_text(json.dumps({"url": f"http://127.0.0.1:{server.server_port}/webhook", "token": "fake"}))
                config.chmod(0o600)
                state = Path(folder) / "state"
                event = sender.payload("self-test", "test", "diagnostic-test", "1")
                self.assertEqual(sender.send(config, state, event), "delivered")
                self.assertEqual(sender.send(config, state, event), "already-delivered")
                self.assertEqual(len(received), 1)
                self.assertEqual(received[0][0], event["id"])
                config.chmod(0o644)
                with self.assertRaises(ValueError):
                    sender.send(config, state, event)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
