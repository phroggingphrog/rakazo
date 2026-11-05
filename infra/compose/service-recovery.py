#!/usr/bin/env python3
"""Bounded recovery policy for the existing host scheduler; no runtime dependency.

Caller must scope input to its configured Compose project, persist returned state
before restart, and verify a later healthy observation. Never restart databases
or deliberately stopped containers. Docker owns crashed-process restart policy.
"""


def recovery_decision(container, previous, now, enabled=False, project=None):
    state = dict(previous)
    runtime = container.get("State", {})
    labels = container.get("Config", {}).get("Labels", {}) or {}
    if not project or labels.get("com.docker.compose.project") != project:
        return "ignore", state
    if labels.get("com.docker.compose.service") not in ("api", "worker", "web", "supervisor"):
        return "ignore", state
    if runtime.get("Status") != "running":
        return "alert", state
    health = runtime.get("Health", {}).get("Status")
    if health == "healthy":
        state.pop("unverifiedSince", None)
        state["consecutiveFailures"] = 0
        state["verifiedHealthyAt"] = now
        return "healthy", state
    if health != "unhealthy":
        # Missing or stuck-starting probes cannot establish recovery indefinitely.
        since = state.setdefault("unverifiedSince", now)
        return ("alert" if now - since >= 600 else "observe"), state
    state.pop("unverifiedSince", None)
    state["consecutiveFailures"] = state.get("consecutiveFailures", 0) + 1
    attempts = [at for at in state.get("restartAttempts", []) if now - at < 3600]
    state["restartAttempts"] = attempts
    if len(attempts) >= 3:
        return "alert", state
    if attempts and now - attempts[-1] < 300:
        return "observe", state
    if not enabled or state["consecutiveFailures"] < 2:
        return "observe", state
    state["restartAttempts"] = [*attempts, now]
    return "restart", state
