import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("recovery", Path(__file__).with_name("service-recovery.py"))
recovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recovery)


def container(status="running", health="unhealthy", service="worker"):
    return {"State": {"Status": status, "Health": {"Status": health}},
            "Config": {"Labels": {"com.docker.compose.service": service, "com.docker.compose.project": "test-stack"}}}


def decide(container, previous, now, enabled=False):
    return recovery.recovery_decision(container, previous, now, enabled, project="test-stack")


class RecoveryTests(unittest.TestCase):
    def test_history_classifies_local_states_without_asserting_delivery(self):
        self.assertEqual(recovery.observation_outcome(container(health="healthy")), "healthy")
        self.assertEqual(recovery.observation_outcome(container(health="starting")), "starting")
        self.assertEqual(recovery.observation_outcome(container(health=None)), "no_healthcheck")
        self.assertEqual(recovery.observation_outcome(container(status="exited")), "stopped")
        self.assertEqual(recovery.observation_outcome({"State": {"Status": "running", "Health": None}}), "unknown")

    def test_24h_history_uses_real_coverage_and_ignores_exact_duplicates(self):
        now = 1_800_000_000_000_000_000
        mono = 900_000_000_000_000
        step = 60_000_000_000
        healthy = recovery.pack_observation({name: "healthy" for name in recovery.OBSERVATION_SERVICES})
        records = [(now - (1440 - i) * step, mono - (1440 - i) * step, healthy) for i in range(1440)]
        records.insert(200, records[199])
        result = recovery.history_windows(records, now, mono, days=1)[0]
        self.assertEqual(result["samples"], 1440)
        self.assertEqual(result["duplicates"], 1)
        self.assertEqual(result["max_gap_seconds"], 60)
        self.assertTrue(result["sampling_complete"])
        self.assertEqual(result["service_outcomes"]["api"]["healthy"], 1440)
        gap_result = recovery.history_windows(records[:500] + records[502:], now, mono, days=1)[0]
        self.assertFalse(gap_result["sampling_complete"])
        self.assertEqual(gap_result["max_gap_seconds"], 180)
        sparse = [record for i, record in enumerate(records) if i % 2 == 0]
        duplicated = [item for record in sparse for item in (record, record)]
        sparse_result = recovery.history_windows(duplicated, now, mono, days=1)[0]
        self.assertFalse(sparse_result["sampling_complete"])
        self.assertGreaterEqual(sparse_result["max_gap_seconds"], 120)

    def test_history_rejects_clock_changes_even_across_window_boundaries(self):
        now = 1_800_000_000_000_000_000
        mono = 900_000_000_000_000
        step = 60_000_000_000
        healthy = recovery.pack_observation({name: "healthy" for name in recovery.OBSERVATION_SERVICES})
        records = [(now - (1440 - i) * step, mono - (1440 - i) * step, healthy) for i in range(1440)]
        changed = list(records)
        wall, tick, status = changed[500]
        changed[500] = (wall, tick - 30 * step, status)
        result = recovery.history_windows(changed, now, mono, days=1)[0]
        self.assertGreater(result["clock_anomalies"], 0)
        self.assertFalse(result["sampling_complete"])
        rebooted = list(records)
        rebooted[-1] = (rebooted[-1][0], 1, healthy)
        self.assertFalse(recovery.history_windows(rebooted, now, mono, days=1)[0]["sampling_complete"])

    def test_full_sampling_gap_spanning_two_windows_invalidates_both(self):
        now = 1_800_000_000_000_000_000
        mono = 900_000_000_000_000
        step = 60_000_000_000
        healthy = recovery.pack_observation({name: "healthy" for name in recovery.OBSERVATION_SERVICES})
        records = ((now - (2880 - i) * step, mono - (2880 - i) * step, healthy)
                   for i in range(2880) if i != 1440)
        first, second = recovery.history_windows(records, now, mono, days=2)
        self.assertEqual(first["max_gap_seconds"], 120)
        self.assertEqual(second["max_gap_seconds"], 120)
        self.assertFalse(first["sampling_complete"])
        self.assertFalse(second["sampling_complete"])
        clock_jump = [(now - (2880 - i) * step, mono - (2880 - i) * step, healthy)
                      for i in range(2880)]
        wall, tick, value = clock_jump[1440]
        clock_jump[1440] = (wall, tick - 10 * step, value)
        first, second = recovery.history_windows(iter(clock_jump), now, mono, days=2)
        self.assertGreater(first["clock_anomalies"], 0)
        self.assertGreater(second["clock_anomalies"], 0)
        self.assertFalse(first["sampling_complete"])
        self.assertFalse(second["sampling_complete"])

    def test_history_stream_has_bounded_memory(self):
        import tracemalloc
        now = 1_800_000_000_000_000_000
        mono = 900_000_000_000_000_000
        step = 60_000_000_000
        healthy = recovery.pack_observation({name: "healthy" for name in recovery.OBSERVATION_SERVICES})
        records = ((now - (100_000 - i) * step, mono - (100_000 - i) * step, healthy)
                   for i in range(100_000))
        tracemalloc.start()
        try:
            windows = recovery.history_windows(records, now, mono)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(len(windows), 7)
        self.assertTrue(all(window["sampling_complete"] for window in windows))
        self.assertLess(peak, 2_000_000)

    def test_project_scope_is_mandatory(self):
        self.assertEqual(recovery.recovery_decision(container(), {}, 1000, True)[0], "ignore")
        self.assertEqual(recovery.recovery_decision(container(), {}, 1000, True, project="other")[0], "ignore")

    def test_requires_enable_and_repeated_failure(self):
        action, state = decide(container(), {}, 1000, True)
        self.assertEqual(action, "observe")
        self.assertEqual(decide(container(), state, 1060)[0], "alert")
        action, state = decide(container(), state, 1060, True)
        self.assertEqual(action, "restart")
        self.assertEqual(state["restartAttempts"], [1060])

    def test_observation_only_escalates_persistent_failure_and_clears_on_health(self):
        action, state = decide(container(), {}, 1000)
        self.assertEqual(action, "observe")
        action, state = decide(container(), state, 1060)
        self.assertEqual(action, "alert")
        self.assertEqual(state["restartAttempts"], [])
        action, state = decide(container(health="healthy"), state, 1120)
        self.assertEqual(action, "healthy")
        self.assertEqual(state["consecutiveFailures"], 0)
        self.assertEqual(decide(container(), state, 1180)[0], "observe")

    def test_stopped_and_database_never_restarted(self):
        self.assertEqual(decide(container(status="exited"), {}, 1, True)[0], "alert")
        self.assertEqual(decide(container(service="db"), {}, 1, True)[0], "ignore")

    def test_cooldown_and_restart_loop_budget(self):
        state = {"consecutiveFailures": 3, "restartAttempts": [1000]}
        self.assertEqual(decide(container(), state, 1100, True)[0], "observe")
        state["restartAttempts"] = [1000, 1400, 1800]
        self.assertEqual(decide(container(), state, 2200, True)[0], "alert")

    def test_missing_or_starting_health_eventually_requires_intervention(self):
        for health in (None, "starting"):
            action, state = decide(container(health=health), {}, 1000, True)
            self.assertEqual(action, "observe")
            self.assertEqual(decide(container(health=health), state, 1600, True)[0], "alert")
            action, state = decide(container(health="healthy"), state, 1700, True)
            self.assertEqual(action, "healthy")
            self.assertNotIn("unverifiedSince", state)

    def test_healthy_verification_preserves_budget(self):
        action, state = decide(container(health="healthy"), {"restartAttempts": [1000]}, 1100, True)
        self.assertEqual(action, "healthy")
        self.assertEqual(state["verifiedHealthyAt"], 1100)
        self.assertEqual(state["restartAttempts"], [1000])


if __name__ == "__main__":
    unittest.main()
