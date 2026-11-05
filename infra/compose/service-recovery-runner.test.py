import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("runner", Path(__file__).with_name("service-recovery-runner.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def row(identity="container-one"):
    return {"Id": identity, "State": {"Status": "running", "Health": {"Status": "unhealthy"}},
            "Config": {"Labels": {"com.docker.compose.project": "test-stack", "com.docker.compose.service": "worker"}}}


class RunnerTests(unittest.TestCase):
    def invoke(self, state, docker, recover=False):
        argv = ["runner", "--project", "test-stack", "--state", str(state)] + (["--recover"] if recover else [])
        with patch("sys.argv", argv), patch.object(runner, "docker", side_effect=docker), contextlib.redirect_stdout(io.StringIO()):
            return runner.main()

    def test_observe_only_never_restarts(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            calls = []
            def docker(*args):
                calls.append(args)
                return "container-one" if args[0] == "ps" else json.dumps([row()])
            self.invoke(state, docker)
            self.invoke(state, docker)
            self.assertFalse(any(call[0] == "restart" for call in calls))

    def test_budget_is_persisted_before_restart_and_survives_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"test-stack:worker": {"consecutiveFailures": 2}}))
            def docker(*args):
                if args[0] == "ps": return "container-two"
                if args[0] == "inspect": return json.dumps([row("container-two")])
                self.assertEqual(args, ("restart", "container-two"))
                self.assertEqual(len(json.loads(state.read_text())["test-stack:worker"]["restartAttempts"]), 1)
                return "container-two"
            self.assertEqual(self.invoke(state, docker, True), 1)  # Other essential services are missing.
            self.assertIn("test-stack:worker", json.loads(state.read_text()))

    def test_missing_stack_notifies_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = ["runner", "--project", "test-stack", "--state", str(Path(directory) / "state.json"), "--notify"]
            with patch("sys.argv", argv), patch.object(runner, "docker", return_value=""), patch.object(runner, "alert") as notify, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.main(), 1)
                notify.assert_called_once_with("test-stack", "stack_missing")

    def test_corrupt_state_notifies_without_leaking_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text("private-invalid-state")
            output = io.StringIO()
            argv = ["runner", "--project", "test-stack", "--state", str(state), "--notify", "--recover"]
            with patch("sys.argv", argv), patch.object(runner, "docker") as docker, patch.object(runner, "alert") as notify, contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 1)
                docker.assert_not_called()
                notify.assert_called_once_with("test-stack", "recovery_state_invalid")
            self.assertNotIn("private-invalid-state", output.getvalue())
            self.assertEqual(json.loads(output.getvalue())["reason"], "recovery_state_invalid")

    def test_invalid_state_never_dispatches_docker(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text("invalid json")
            self.assertEqual(self.invoke(state, lambda *args: self.fail("Docker must not run with invalid state"), True), 1)
            self.assertEqual(state.read_text(), "invalid json")

    def test_inspection_outage_notifies_without_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            argv = ["runner", "--project", "test-stack", "--state", str(Path(directory) / "state.json"), "--notify", "--recover"]
            with patch("sys.argv", argv), patch.object(runner, "docker", side_effect=OSError("unavailable")) as docker, patch.object(runner, "alert") as notify, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.main(), 1)
                notify.assert_called_once_with("test-stack", "health_inspection_failed")
                self.assertEqual(docker.call_count, 1)

    def test_failed_restart_retains_reserved_budget(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"test-stack:worker": {"consecutiveFailures": 2}}))
            def docker(*args):
                if args[0] == "ps": return "container-one"
                if args[0] == "inspect": return json.dumps([row()])
                raise OSError("restart unavailable")
            self.assertEqual(self.invoke(state, docker, True), 1)
            self.assertEqual(len(json.loads(state.read_text())["test-stack:worker"]["restartAttempts"]), 1)

    def test_invalid_state_shapes_fail_before_dispatch(self):
        for state in ([], {"worker": []}, {"worker": {"restartAttempts": "bad"}}, {"worker": {"consecutiveFailures": -1}}, {"worker": {"restartAttempts": [float("nan")]}}):
            with self.subTest(state=state), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "state.json"
                original = json.dumps(state)
                path.write_text(original)
                self.assertEqual(self.invoke(path, lambda *args: self.fail("Must not dispatch Docker"), True), 1)
                self.assertEqual(path.read_text(), original)

    def test_missing_stack_requires_intervention(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.invoke(Path(directory) / "state.json", lambda *args: ""), 1)


if __name__ == "__main__":
    unittest.main()
