#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile
import json
import sys

spec = importlib.util.spec_from_file_location("scan", Path(__file__).with_name("incident-scan.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)

class Filters(unittest.TestCase):
    def test_container_failures_only(self):
        def row(name="app", **state):
            return {"Name": "/" + name, "State": state}
        self.assertEqual(len(scan.containers("docker", [row(Status="exited", ExitCode=1)])), 1)
        for item in [row(Status="exited", ExitCode=0), row(Status="exited", ExitCode=1, StoppedByUser=True), row("rakazo-bot-test", Status="exited", ExitCode=1), row("app-infra", Status="exited", ExitCode=1)]:
            self.assertFalse(scan.containers("podman", [item]))
        self.assertEqual(len(scan.containers("docker", [row(Status="running", Health={"Status":"unhealthy"})])), 1)

    def test_error_classification_never_forwards_raw_details(self):
        import subprocess
        probe = scan.ERROR_CLASSIFIER + "\nconsole.log(JSON.stringify([errorDetail('Unauthorized bearer SECRET https://private.invalid'), errorDetail({message:'ETIMEDOUT',token:'SECRET'}),errorDetail('unknown SECRET')]))"
        result = subprocess.run(["node", "--input-type=module", "-e", probe], capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout), [{"error_category":"authentication"}, {"error_category":"timeout"}, {"error_category":"unknown"}])
        self.assertNotIn("SECRET", result.stdout)

    def test_service_filters(self):
        self.assertEqual(len(scan.services("systemd-user", "test.service loaded failed failed Test")), 1)
        self.assertFalse(scan.services("systemd-user", "container-watchdog.service loaded failed failed Test"))
        self.assertFalse(scan.services("systemd-user", "test.timer loaded failed failed Test"))

    def test_cursor_persists_after_confirmed_delivery(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / "config.json"
            config.write_text(json.dumps({"state": str(root / "delivery.json"), "credential": str(root / "credential.json")}))
            item = ["runner", "bot", "tool-failed", "event", "tools", "2026-11-03T12:59:00.000Z"]
            sender = type("Sender", (), {"payload": staticmethod(lambda *args: {}), "send": staticmethod(lambda *args: "delivered")})()
            with patch.object(sys, "argv", ["scan", "--config", str(config)]), patch.object(scan, "scan", return_value=([item], [])), patch.object(scan.importlib.util, "module_from_spec", return_value=sender), patch.object(scan.SourceFileLoader, "exec_module"):
                scan.main()
            self.assertEqual(json.loads((root / "scan-cursors.json").read_text())["tools"]["id"], "event")
            sender.send = lambda *args: (_ for _ in ()).throw(ValueError("offline"))
            item[3] = "next-event"
            with patch.object(sys, "argv", ["scan", "--config", str(config)]), patch.object(scan, "scan", return_value=([item], [])), patch.object(scan.importlib.util, "module_from_spec", return_value=sender), patch.object(scan.SourceFileLoader, "exec_module"), self.assertRaises(SystemExit):
                scan.main()
            self.assertEqual(json.loads((root / "scan-cursors.json").read_text())["tools"]["id"], "event")

    def test_unavailable_sources_are_reported(self):
        with patch.object(scan, "command", side_effect=OSError), patch.object(scan.subprocess, "run", side_effect=OSError):
            events, errors = scan.scan({"userId":"u", "spaceId":"s", "botId":"b"})
        self.assertFalse(events)
        self.assertEqual(set(errors), {"docker", "podman", "systemd-user", "systemd-system", "runner", "systemd-system-journal", "systemd-user-journal"})

if __name__ == "__main__":
    unittest.main()
