#!/usr/bin/env python3
"""One pass for an existing host timer. Observe-only unless --recover is set.

Writes metadata only; never captures container environment, requests or logs.
"""
import argparse
import fcntl
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location("policy", Path(__file__).with_name("service-recovery.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


INSPECT_FORMAT = (
    '{"Id":{{json .Id}},"State":{"Status":{{json .State.Status}},'
    '"Health":{"Status":{{if (index .State "Health")}}{{json (index (index .State "Health") "Status")}}{{else}}null{{end}}}},'
    '"Config":{"Labels":{"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},'
    '"com.docker.compose.service":{{json (index .Config.Labels "com.docker.compose.service")}}}}}'
)


def docker(*args):
    return subprocess.run(["docker", *args], capture_output=True, text=True, timeout=20, check=True).stdout


def save(path, state):
    # An interrupted write may leave invalid JSON; the next pass fails closed.
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "r+") as handle:
        handle.seek(0)
        json.dump(state, handle)
        handle.truncate()
        handle.flush()
        os.fsync(handle.fileno())


def alert(project, reason):
    """Reuse the existing deduplicated host notification transport."""
    spec = importlib.util.spec_from_file_location("host_alert", Path(__file__).with_name("host-alert.py"))
    transport = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    transport.notify("service-recovery:" + project + ":" + reason,
                     "Application service recovery requires intervention: " + reason)


def validate_state(state):
    if not isinstance(state, dict):
        raise ValueError("Invalid recovery state")
    for record in state.values():
        if not isinstance(record, dict):
            raise ValueError("Invalid recovery record")
        for field in ("consecutiveFailures", "verifiedHealthyAt", "unverifiedSince"):
            value = record.get(field, 0)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise ValueError("Invalid recovery counter")
        attempts = record.get("restartAttempts", [])
        if not isinstance(attempts, list) or any(type(at) not in (int, float) or not math.isfinite(at) or at < 0 for at in attempts):
            raise ValueError("Invalid recovery budget")
        if "lastContainerId" in record and (not isinstance(record["lastContainerId"], str) or not record["lastContainerId"] or len(record["lastContainerId"]) > 128):
            raise ValueError("Invalid container identity")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--recover", action="store_true")
    parser.add_argument("--notify", action="store_true", help="Use existing host-alert configuration")
    parser.add_argument("--quiet-healthy", action="store_true", help="Suppress routine healthy observations")
    args = parser.parse_args()
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.state.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            state = json.loads(args.state.read_text()) if args.state.exists() else {}
            validate_state(state)
        except (OSError, ValueError):
            print(json.dumps({"status": "intervention_required", "reason": "recovery_state_invalid"}))
            if args.notify:
                alert(args.project, "recovery_state_invalid")
            return 1
        try:
            ids = docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + args.project).split()
            rows = [json.loads(line) for line in docker("inspect", "--format", INSPECT_FORMAT, *ids).splitlines()] if ids else []
        except (OSError, ValueError, subprocess.SubprocessError):
            print(json.dumps({"status": "intervention_required", "reason": "health_inspection_failed"}))
            if args.notify:
                alert(args.project, "health_inspection_failed")
            return 1
        if not ids:
            print(json.dumps({"status": "intervention_required", "reason": "stack_missing"}))
            if args.notify:
                alert(args.project, "stack_missing")
            return 1
        expected = {"api", "worker", "web", "supervisor"}
        grouped = {service: [] for service in expected}
        for row in rows:
            labels = row.get("Config", {}).get("Labels", {}) or {}
            service = labels.get("com.docker.compose.service")
            if labels.get("com.docker.compose.project") == args.project and service in grouped:
                grouped[service].append(row)
        failed = False
        for service in sorted(expected):
            matches = grouped[service]
            if len(matches) != 1:
                failed = True
                print(json.dumps({"status": "intervention_required", "reason": "service_missing" if not matches else "service_ambiguous", "service": service}))
                continue
            row = matches[0]
            container_id = row["Id"]
            key = args.project + ":" + service
            prior = dict(state.get(key, {}))
            if prior.get("lastContainerId") != container_id:
                prior.pop("consecutiveFailures", None)
                prior.pop("unverifiedSince", None)
                prior.pop("verifiedHealthyAt", None)
            prior["lastContainerId"] = container_id
            action, record = policy.recovery_decision(row, prior, time.time(), args.recover, args.project)
            state[key] = record
            # Persist reserved restart budget before dispatching any effect.
            save(args.state, state)
            if action == "restart":
                try:
                    docker("restart", container_id)
                    action = "restarted_pending_health_verification"
                except (OSError, subprocess.SubprocessError):
                    action = "alert"
            failed |= action == "alert"
            if action != "healthy" or not args.quiet_healthy:
                print(json.dumps({"service": service, "action": action}))
        if failed and args.notify:
            alert(args.project, "services_unavailable_or_restart_budget_exhausted")
        return int(failed)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({"status": "intervention_required", "reason": "health_inspection_failed"}))
        raise SystemExit(1)
