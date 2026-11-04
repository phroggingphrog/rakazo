import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
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
                return "container-one" if args[0] == "ps" else json.dumps(row())
            self.invoke(state, docker)
            self.invoke(state, docker)
            self.assertFalse(any(call[0] == "restart" for call in calls))

    def test_observe_only_reports_persistent_unhealthy_and_notifies_only_if_requested(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            rows = []
            for service in ("api", "supervisor", "web", "worker"):
                item = row(service)
                item["Config"]["Labels"]["com.docker.compose.service"] = service
                if service != "worker":
                    item["State"]["Health"]["Status"] = "healthy"
                rows.append(item)
            calls = []
            def docker(*args):
                calls.append(args)
                if args[0] == "ps": return "api supervisor web worker"
                if args[0] == "inspect": return "\n".join(json.dumps(item) for item in rows)
                self.fail("Observe-only mode must not restart")
            argv = ["runner", "--project", "test-stack", "--state", str(state), "--quiet-healthy"]
            output = io.StringIO()
            with patch("sys.argv", argv), patch.object(runner, "docker", side_effect=docker), patch.object(runner, "alert") as notify, contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 0)
                self.assertEqual(json.loads(output.getvalue())["action"], "observe")
                output.seek(0)
                output.truncate()
                self.assertEqual(runner.main(), 1)
                self.assertEqual(json.loads(output.getvalue())["action"], "alert")
                notify.assert_not_called()
            with patch("sys.argv", [*argv, "--notify"]), patch.object(runner, "docker", side_effect=docker), patch.object(runner, "alert") as notify, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(runner.main(), 1)
                notify.assert_called_once_with("test-stack", "services_unavailable_or_restart_budget_exhausted")
            self.assertFalse(any(call[0] == "restart" for call in calls))

    def test_docker_inspection_requests_only_nonsecret_fields(self):
        with patch("subprocess.run") as run:
            run.return_value.stdout = ""
            runner.docker("inspect", "--format", runner.INSPECT_FORMAT, "container-one")
            argv = run.call_args.args[0]
            self.assertEqual(argv[0], "docker")
            self.assertNotIn(".Config.Env", runner.INSPECT_FORMAT)
            self.assertNotIn(".State.Health.Log", runner.INSPECT_FORMAT)
            self.assertIn('index (index .State "Health") "Status"', runner.INSPECT_FORMAT)

    def test_quiet_mode_suppresses_healthy_services(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            healthy = row()
            healthy["State"]["Health"]["Status"] = "healthy"
            all_healthy = []
            for service in ("api", "supervisor", "web", "worker"):
                item = json.loads(json.dumps(healthy))
                item["Id"] = service
                item["Config"]["Labels"]["com.docker.compose.service"] = service
                all_healthy.append(item)
            def docker(*args):
                if args[0] == "ps": return "api supervisor web worker"
                if args[0] == "inspect": return "\n".join(json.dumps(item) for item in all_healthy)
                self.fail("Observe-only mode must not restart")
            output = io.StringIO()
            argv = ["runner", "--project", "test-stack", "--state", str(state), "--quiet-healthy"]
            with patch("sys.argv", argv), patch.object(runner, "docker", side_effect=docker), contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 0)
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(len(json.loads(state.read_text())), 4)

    def test_duplicate_service_cannot_supply_two_failure_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            calls = []
            def docker(*args):
                calls.append(args)
                if args[0] == "ps": return "container-one container-two"
                if args[0] == "inspect": return "\n".join(json.dumps(item) for item in [row(), row("container-two")])
                self.fail("Ambiguous services must never restart")
            self.assertEqual(self.invoke(state, docker, True), 1)
            self.assertFalse(any(call[0] == "restart" for call in calls))
            self.assertFalse(state.exists())

    def test_replacement_requires_two_new_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"test-stack:worker": {"lastContainerId": "container-old", "consecutiveFailures": 9, "verifiedHealthyAt": 123, "restartAttempts": []}}))
            calls = []
            def docker(*args):
                calls.append(args)
                if args[0] == "ps": return "container-two"
                if args[0] == "inspect": return json.dumps(row("container-two"))
                return "container-two"
            self.invoke(state, docker, True)
            self.assertEqual(json.loads(state.read_text())["test-stack:worker"]["consecutiveFailures"], 1)
            self.assertNotIn("verifiedHealthyAt", json.loads(state.read_text())["test-stack:worker"])
            self.assertFalse(any(call[0] == "restart" for call in calls))
            self.invoke(state, docker, True)
            self.assertIn(("restart", "container-two"), calls)

    def test_budget_is_persisted_before_restart_and_survives_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            state.write_text(json.dumps({"test-stack:worker": {"consecutiveFailures": 2, "lastContainerId": "container-two"}}))
            def docker(*args):
                if args[0] == "ps": return "container-two"
                if args[0] == "inspect": return json.dumps(row("container-two"))
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
            with sqlite3.connect(runner.history_path(state, "test-stack")) as database:
                outcome = database.execute("SELECT outcomes FROM observations").fetchone()[0]
            self.assertEqual(outcome, runner.policy.pack_observation({name: "state_invalid" for name in runner.policy.OBSERVATION_SERVICES}))

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
            state.write_text(json.dumps({"test-stack:worker": {"consecutiveFailures": 2, "lastContainerId": "container-one"}}))
            def docker(*args):
                if args[0] == "ps": return "container-one"
                if args[0] == "inspect": return json.dumps(row())
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

    def test_history_survives_restarts_and_does_not_store_container_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            private_id = "private-container-identity-123"
            def docker(*args):
                if args[0] == "ps": return private_id
                return json.dumps(row(private_id))
            self.invoke(state, docker)
            self.invoke(state, docker)
            path = runner.history_path(state, "test-stack")
            with sqlite3.connect(path) as database:
                samples = database.execute("SELECT wall_ns, mono_ns, outcomes FROM observations ORDER BY rowid").fetchall()
            self.assertEqual(len(samples), 2)
            self.assertTrue(all(sample[0] > 0 and sample[1] > 0 for sample in samples))
            self.assertNotIn(private_id.encode(), path.read_bytes())
            self.assertNotIn(b"test-stack", path.read_bytes())
            journal = Path(str(path) + "-journal")
            self.assertTrue(journal.exists())
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_history_scopes_projects_without_storing_names(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            outcomes = {name: "healthy" for name in runner.policy.OBSERVATION_SERVICES}
            first = runner.history_path(state, "first")
            second = runner.history_path(state, "second")
            runner.append_observation(first, outcomes)
            runner.append_observation(second, outcomes)
            self.assertNotEqual(first, second)
            for path in (first, second):
                with sqlite3.connect(path) as database:
                    self.assertEqual(database.execute("SELECT count(*) FROM observations").fetchone()[0], 1)
            with self.assertRaises(ValueError):
                runner.history_path(state, "../other")

    def test_history_records_missing_ambiguous_and_inspection_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            def duplicate(*args):
                if args[0] == "ps": return "one two"
                return "\n".join(json.dumps(item) for item in [row("one"), row("two")])
            self.invoke(state, duplicate)
            self.invoke(state, lambda *_args: (_ for _ in ()).throw(OSError("private failure")))
            with sqlite3.connect(runner.history_path(state, "test-stack")) as database:
                packed = [item[0] for item in database.execute("SELECT outcomes FROM observations ORDER BY rowid")]
            first = {name: "ambiguous" if name == "worker" else "missing" for name in runner.policy.OBSERVATION_SERVICES}
            self.assertEqual(packed[0], runner.policy.pack_observation(first))
            self.assertEqual(packed[1], runner.policy.pack_observation({name: "inspection_failed" for name in runner.policy.OBSERVATION_SERVICES}))

    def test_invalid_inspection_identity_cannot_record_a_healthy_service(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            item = row("")
            item["State"]["Health"]["Status"] = "healthy"
            def docker(*args):
                return "one" if args[0] == "ps" else json.dumps(item)
            self.assertEqual(self.invoke(state, docker), 1)
            with sqlite3.connect(runner.history_path(state, "test-stack")) as database:
                packed = database.execute("SELECT outcomes FROM observations").fetchone()[0]
            outcomes = {name: "unknown" if name == "worker" else "missing" for name in runner.policy.OBSERVATION_SERVICES}
            self.assertEqual(packed, runner.policy.pack_observation(outcomes))

    def test_history_failure_is_visible_and_does_not_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            history = runner.history_path(state, "test-stack")
            history.write_text("not a database")
            calls = []
            def docker(*args):
                calls.append(args)
                return "container-one" if args[0] == "ps" else json.dumps(row())
            output = io.StringIO()
            with patch("sys.argv", ["runner", "--project", "test-stack", "--state", str(state), "--recover"]), patch.object(runner, "docker", side_effect=docker), contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 1)
            self.assertEqual(json.loads(output.getvalue())["reason"], "observation_history_unavailable")
            self.assertEqual(history.read_text(), "not a database")
            self.assertFalse(any(call[0] == "restart" for call in calls))

    def test_invalid_clock_is_visible_without_creating_history(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            output = io.StringIO()
            def docker(*args):
                return "container-one" if args[0] == "ps" else json.dumps(row())
            with patch("sys.argv", ["runner", "--project", "test-stack", "--state", str(state)]), patch.object(runner, "docker", side_effect=docker), patch.object(runner.time, "time_ns", return_value=-1), contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 1)
            self.assertEqual(json.loads(output.getvalue())["reason"], "observation_history_unavailable")
            self.assertFalse(runner.history_path(state, "test-stack").exists())

    def test_history_report_without_history_is_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            output = io.StringIO()
            with patch("sys.argv", ["runner", "--project", "test-stack", "--state", str(state), "--history-report"]), patch.object(runner, "docker") as docker, contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 1)
            docker.assert_not_called()
            self.assertEqual(list(Path(directory).iterdir()), [])
            self.assertEqual(json.loads(output.getvalue())["reason"], "observation_history_unavailable")

    def test_history_report_has_seven_incomplete_windows_and_separate_outcomes(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state.json"
            path = runner.history_path(state, "test-stack")
            now = 1_800_000_000_000_000_000
            mono = 900_000_000_000_000
            outcomes = {name: "healthy" for name in runner.policy.OBSERVATION_SERVICES}
            outcomes["web"] = "no_healthcheck"
            with patch.object(runner.time, "time_ns", return_value=now - 60_000_000_000), patch.object(runner.time, "monotonic_ns", return_value=mono - 60_000_000_000):
                runner.append_observation(path, outcomes)
            output = io.StringIO()
            with patch("sys.argv", ["runner", "--project", "test-stack", "--state", str(state), "--history-report"]), patch.object(runner.time, "time_ns", return_value=now), patch.object(runner.time, "monotonic_ns", return_value=mono), contextlib.redirect_stdout(output):
                self.assertEqual(runner.main(), 0)
            report = json.loads(output.getvalue())
            self.assertEqual(report["source"], "container_health_only")
            self.assertEqual(len(report["windows"]), 7)
            self.assertTrue(all(not day["sampling_complete"] for day in report["windows"]))
            self.assertEqual(report["windows"][-1]["service_outcomes"]["web"]["no_healthcheck"], 1)

    def test_unrelated_sqlite_file_is_not_rewritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "history.sqlite3"
            with sqlite3.connect(path) as database:
                database.execute("CREATE TABLE other(value TEXT)")
                database.execute("INSERT INTO other VALUES ('keep')")
                database.execute("PRAGMA user_version=1")
            original = path.read_bytes()
            with self.assertRaises(ValueError):
                runner.append_observation(path, {name: "healthy" for name in runner.policy.OBSERVATION_SERVICES})
            self.assertEqual(path.read_bytes(), original)
            self.assertFalse(Path(str(path) + "-journal").exists())


if __name__ == "__main__":
    unittest.main()
