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
    if not enabled:
        return ("alert" if state["consecutiveFailures"] >= 2 else "observe"), state
    if attempts and now - attempts[-1] < 300:
        return "observe", state
    if state["consecutiveFailures"] < 2:
        return "observe", state
    state["restartAttempts"] = [*attempts, now]
    return "restart", state

# Four fixed service states are packed into one integer in the observation history.
OBSERVATION_SERVICES = ("api", "supervisor", "web", "worker")
OBSERVATION_CODES = {
    "healthy": 1,
    "unhealthy": 2,
    "starting": 3,
    "no_healthcheck": 4,
    "stopped": 5,
    "missing": 6,
    "ambiguous": 7,
    "inspection_failed": 8,
    "state_invalid": 9,
    "unknown": 10,
}


def observation_outcome(container):
    """Describe only local container state, never endpoint or delivery success."""
    runtime = container.get("State")
    if not isinstance(runtime, dict):
        return "unknown"
    status = runtime.get("Status")
    if status != "running":
        return "stopped" if status in ("created", "restarting", "removing", "paused", "exited", "dead") else "unknown"
    probe = runtime.get("Health")
    if not isinstance(probe, dict):
        return "unknown"
    health = probe.get("Status")
    if health is None:
        return "no_healthcheck"
    return health if health in ("healthy", "unhealthy", "starting") else "unknown"


def pack_observation(outcomes):
    return sum(OBSERVATION_CODES[outcomes[name]] << (index * 4)
               for index, name in enumerate(OBSERVATION_SERVICES))


def history_windows(records, now_wall_ns, now_mono_ns, days=7, max_gap_seconds=90):
    """Stream real 24-hour windows, preserving gaps, duplicates and clock anomalies."""
    from itertools import chain

    day_ns = 86_400_000_000_000
    max_gap_ns = max_gap_seconds * 1_000_000_000
    tolerance_ns = 5_000_000_000
    codes = {value: key for key, value in OBSERVATION_CODES.items()}
    windows = []
    for day in range(days - 1, -1, -1):
        windows.append({
            "start_ns": now_wall_ns - (day + 1) * day_ns,
            "end_ns": now_wall_ns - day * day_ns,
            "samples": 0, "duplicates": 0, "clock_anomalies": 0,
            "max_gap_ns": 0, "first_ns": None, "last_ns": None,
            "service_outcomes": {name: {key: 0 for key in OBSERVATION_CODES}
                                 for name in OBSERVATION_SERVICES},
        })
    previous = None
    anchor = None
    for wall, mono, packed in chain(records, [(now_wall_ns, now_mono_ns, None)]):
        sample = packed is not None
        if (type(wall) is not int or type(mono) is not int or wall < 0 or mono < 0 or
                (sample and (type(packed) is not int or packed < 0 or packed >= 2 ** 16 or
                             any(((packed >> (i * 4)) & 15) not in codes for i in range(4))))):
            raise ValueError("Invalid observation history")
        matching = next((window for window in windows if window["start_ns"] <= wall < window["end_ns"]), None)
        if previous and (wall, mono) == previous:
            if sample and matching:
                matching["duplicates"] += 1
            continue
        if previous:
            wall_delta, mono_delta = wall - previous[0], mono - previous[1]
            drift = abs((wall - anchor[0]) - (mono - anchor[1]))
            anomaly = wall_delta <= 0 or mono_delta <= 0 or abs(wall_delta - mono_delta) > tolerance_ns or drift > tolerance_ns
            lo, hi = min(wall, previous[0]), max(wall, previous[0])
            for window in windows:
                if anomaly and lo <= window["end_ns"] and hi >= window["start_ns"]:
                    window["clock_anomalies"] += 1
                # A single missing interval can cross a day boundary. Count the
                # full interval in both windows, not just its half at each edge.
                if wall_delta > 0 and previous[0] < window["end_ns"] and wall > window["start_ns"]:
                    window["max_gap_ns"] = max(window["max_gap_ns"], wall_delta)
            if anomaly:
                anchor = (wall, mono)
        else:
            anchor = (wall, mono)
        previous = (wall, mono)
        if sample and matching:
            matching["samples"] += 1
            if matching["first_ns"] is None:
                matching["first_ns"] = wall
            matching["last_ns"] = wall
            for index, name in enumerate(OBSERVATION_SERVICES):
                matching["service_outcomes"][name][codes[(packed >> (index * 4)) & 15]] += 1
    for window in windows:
        first = window.pop("first_ns")
        last = window.pop("last_ns")
        gap = window.pop("max_gap_ns")
        if first is None:
            gap = max(gap, day_ns)
        else:
            gap = max(gap, first - window["start_ns"], window["end_ns"] - last)
        window["max_gap_seconds"] = gap / 1_000_000_000
        window["sampling_complete"] = bool(window["samples"] and not window["clock_anomalies"] and gap <= max_gap_ns)
    return windows
