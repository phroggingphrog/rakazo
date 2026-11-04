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
