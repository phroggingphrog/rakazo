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
import re
import sqlite3
import struct
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


def history_path(state_path, project):
    # Compose project names are configuration scope, never container or account IDs.
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", project):
        raise ValueError("Invalid Compose project")
    return state_path.with_name(state_path.name + "." + project + ".history.sqlite3")


def validate_history_database(database):
    if (database.execute("PRAGMA user_version").fetchone()[0] != 1 or
            database.execute("PRAGMA application_id").fetchone()[0] != 0x52414B48):
        raise ValueError("Unsupported observation history")
    columns = database.execute("PRAGMA table_info(observations)").fetchall()
    if [(row[1], row[2], row[3], row[5]) for row in columns] != [
        ("wall_ns", "INTEGER", 1, 0), ("mono_ns", "INTEGER", 1, 0), ("outcomes", "INTEGER", 1, 0)
    ]:
        raise ValueError("Invalid observation history schema")


def append_observation(path, outcomes):
    """Append one fixed-size sample; do not rotate or prune history."""
    wall, mono = time.time_ns(), time.monotonic_ns()
    if any(type(value) is not int or value < 0 or value > 2 ** 63 - 1 for value in (wall, mono)):
        raise ValueError("Invalid observation clock")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = True
    except FileExistsError:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        created = False
    try:
        if not created:
            header = os.read(fd, 100)
            if (len(header) != 100 or header[:16] != b"SQLite format 3\x00" or
                    struct.unpack_from(">I", header, 60)[0] != 1 or
                    struct.unpack_from(">I", header, 68)[0] != 0x52414B48):
                raise ValueError("Unsupported observation history")
    finally:
        os.close(fd)
    database = sqlite3.connect(path, timeout=5)
    try:
        if not created:
            validate_history_database(database)
        if database.execute("PRAGMA journal_mode=PERSIST").fetchone()[0] != "persist":
            raise ValueError("Persistent history journal unavailable")
        database.execute("PRAGMA synchronous=FULL")
        with database:
            if created:
                database.execute("BEGIN IMMEDIATE")
                database.execute("CREATE TABLE observations (wall_ns INTEGER NOT NULL, mono_ns INTEGER NOT NULL, outcomes INTEGER NOT NULL)")
                database.execute("PRAGMA user_version=1")
                database.execute("PRAGMA application_id=1380010824")
            database.execute("INSERT INTO observations (wall_ns, mono_ns, outcomes) VALUES (?, ?, ?)",
                             (wall, mono, policy.pack_observation(outcomes)))
    finally:
        database.close()
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def report_history(path):
    if not path.is_file():
        raise ValueError("Observation history not found")
    database = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
    try:
        validate_history_database(database)
        rows = database.execute("SELECT wall_ns, mono_ns, outcomes FROM observations ORDER BY rowid")
        windows = policy.history_windows(rows, time.time_ns(), time.monotonic_ns())
    finally:
        database.close()
    return {
        "source": "container_health_only",
        "max_sample_gap_seconds": 90,
        "clock_tolerance_seconds": 5,
        "reboot_identity_checked": False,
        "delivery_verified": False,
        "windows": windows,
    }


def record_history(path, outcomes):
    try:
        append_observation(path, outcomes)
        return True
    except (OSError, ValueError, sqlite3.Error):
        print(json.dumps({"status": "intervention_required", "reason": "observation_history_unavailable"}))
        return False


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
    parser.add_argument("--history-report", action="store_true", help="Report the last seven 24-hour sampling windows")
    args = parser.parse_args()
    history = history_path(args.state, args.project)
    if args.history_report:
        try:
            print(json.dumps(report_history(history)))
            return 0
        except (OSError, ValueError, sqlite3.Error):
            print(json.dumps({"status": "intervention_required", "reason": "observation_history_unavailable"}))
            return 1
    args.state.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with args.state.with_suffix(".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            state = json.loads(args.state.read_text()) if args.state.exists() else {}
            validate_state(state)
        except (OSError, ValueError):
            record_history(history, {service: "state_invalid" for service in policy.OBSERVATION_SERVICES})
            print(json.dumps({"status": "intervention_required", "reason": "recovery_state_invalid"}))
            if args.notify:
                alert(args.project, "recovery_state_invalid")
            return 1
        try:
            ids = docker("ps", "-aq", "--filter", "label=com.docker.compose.project=" + args.project).split()
            rows = [json.loads(line) for line in docker("inspect", "--format", INSPECT_FORMAT, *ids).splitlines()] if ids else []
            if not all(isinstance(row, dict) and isinstance(row.get("Config"), dict) and isinstance(row["Config"].get("Labels"), dict) for row in rows):
                raise ValueError("Invalid inspection output")
        except (OSError, ValueError, subprocess.SubprocessError):
            record_history(history, {service: "inspection_failed" for service in policy.OBSERVATION_SERVICES})
            print(json.dumps({"status": "intervention_required", "reason": "health_inspection_failed"}))
            if args.notify:
                alert(args.project, "health_inspection_failed")
            return 1
        if not ids:
            record_history(history, {service: "missing" for service in policy.OBSERVATION_SERVICES})
            print(json.dumps({"status": "intervention_required", "reason": "stack_missing"}))
            if args.notify:
                alert(args.project, "stack_missing")
            return 1
        expected = {"api", "worker", "web", "supervisor"}
        grouped = {service: [] for service in expected}
        for row in rows:
            labels = row.get("Config", {}).get("Labels", {}) or {}
            service = labels.get("com.docker.compose.service")
            if (labels.get("com.docker.compose.project") == args.project and
                    isinstance(service, str) and service in grouped):
                grouped[service].append(row)
        outcomes = {
            service: ("missing" if not matches else "ambiguous" if len(matches) != 1
                      else "unknown" if not isinstance(matches[0].get("Id"), str)
                      or not matches[0]["Id"] or len(matches[0]["Id"]) > 128
                      else policy.observation_outcome(matches[0]))
            for service, matches in grouped.items()
        }
        if not record_history(history, outcomes):
            return 1
        failed = False
        for service in sorted(expected):
            matches = grouped[service]
            if len(matches) != 1:
                failed = True
                print(json.dumps({"status": "intervention_required", "reason": "service_missing" if not matches else "service_ambiguous", "service": service}))
                continue
            row = matches[0]
            if outcomes[service] == "unknown":
                failed = True
                print(json.dumps({"status": "intervention_required", "reason": "service_inspection_invalid", "service": service}))
                continue
            container_id = row.get("Id")
            if not isinstance(container_id, str) or not container_id or len(container_id) > 128:
                failed = True
                print(json.dumps({"status": "intervention_required", "reason": "service_inspection_invalid", "service": service}))
                continue
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
