#!/usr/bin/env python3
"""Read failure metadata from local supervisors; never restart services."""
import argparse
import importlib.util
from importlib.machinery import SourceFileLoader
import json
import os
from pathlib import Path
import subprocess
import time


def command(args):
    return subprocess.run(args, text=True, capture_output=True, timeout=15, check=True).stdout


def containers(engine, rows):
    result = []
    for row in rows:
        state = row.get("State", {})
        status = state.get("Status")
        unhealthy = state.get("Health", {}).get("Status") == "unhealthy"
        failed = status in ("exited", "stopped", "dead") and state.get("ExitCode", 0) != 0
        if state.get("StoppedByUser") or not (failed or unhealthy):
            continue
        name = row.get("Name", "").lstrip("/")
        if not name or name.startswith("rakazo-bot-") or name.endswith("-infra"):
            continue
        result.append((engine, name, "container-failed", str(int(time.time()) // 86400)))
    return result


def services(source, text):
    return [(source, line.split()[0], "service-failed", str(int(time.time()) // 86400))
            for line in text.splitlines() if line.split() and line.split()[0].endswith(".service") and line.split()[0] != "container-watchdog.service"]


ERROR_CLASSIFIER = r"""
function errorDetail(error) {
 const text=(typeof error==='string'?error:JSON.stringify(error??'')).slice(0,16000).toLowerCase();
 const rules=[['authentication',/unauthorized|invalid.api.key|authentication|\b401\b/],['permission',/forbidden|permission.denied|\b403\b/],['rate-limit',/rate.limit|too.many.requests|\b429\b/],['timeout',/timed?.out|timeout|etimedout/],['connection',/econnrefused|enotfound|econnreset|connection.refused/],['not-found',/not.found|\b404\b/],['invalid-input',/invalid.argument|validation.error|\b400\b/],['unavailable',/service.unavailable|bad.gateway|\b50[234]\b/]];
 const category=rules.find(([,re])=>re.test(text))?.[0]??'unknown';
 return {error_category:category};
}
"""

RUNNER_QUERY = ERROR_CLASSIFIER + r"""
import {createDb} from '/app/packages/db/src/client.ts';
import {runAsTenant} from '/app/packages/db/src/row-security.ts';
const {prisma,pool}=createDb(process.env.DATABASE_URL);
const owner=JSON.parse(process.env.INCIDENT_TENANT);
try { await runAsTenant(owner,async()=>{
 const after=(key,field)=>{const c=owner.cursors[key];return {OR:[{[field]:{gt:new Date(c.time)}},{[field]:new Date(c.time),id:{gt:c.id}}]};};
 const runs=await prisma.run.findMany({where:{spaceId:owner.spaceId,botId:{not:owner.botId},status:'failed',...after('runs','updatedAt')},orderBy:[{updatedAt:'asc'},{id:'asc'}],take:5,select:{id:true,botId:true,updatedAt:true,threadId:true}});
 const events=await prisma.event.findMany({where:{spaceId:owner.spaceId,botId:{not:owner.botId},type:'agent.tool.completed',...after('tools','createdAt')},orderBy:[{createdAt:'asc'},{id:'asc'}],take:100,select:{id:true,botId:true,createdAt:true,runId:true,threadId:true,payload:true}});
 console.log(JSON.stringify([...runs.map(r=>['runner',r.botId,'run-failed',r.id,'runs',r.updatedAt.toISOString(),{run_id:r.id,thread_id:r.threadId}]),...events.map(e=>['runner',e.botId,e.payload?.outcome==='error'?'tool-failed':'skip',e.id,'tools',e.createdAt.toISOString(),{tool:e.payload?.name,run_id:e.runId,thread_id:e.threadId,...(e.payload?.outcome==='error'?errorDetail(e.payload?.error):{})}])]));
 }); } finally {await prisma.$disconnect();await pool.end();}
"""


def scan(config):
    events = []
    errors = []
    for engine in ("podman", "docker"):
        try:
            ids = command([engine, "ps", "-aq"]).split()
            if ids:
                events += containers(engine, json.loads(command([engine, "inspect", *ids])))
        except (OSError, ValueError, subprocess.SubprocessError):
            errors.append(engine)
    for source, args in (("systemd-system", []), ("systemd-user", ["--user"])):
        try:
            events += services(source, command(["systemctl", *args, "list-units", "--type=service", "--state=failed", "--plain", "--no-legend", "--no-pager"]))
        except (OSError, subprocess.SubprocessError):
            errors.append(source)
    try:
        tenant = {key: config[key] for key in ("userId", "spaceId", "botId")}
        tenant["cursors"] = config.get("cursors", {key: {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-300)), "id": ""} for key in ("runs", "tools")})
        result = subprocess.run(["docker", "exec", "-i", "-e", "INCIDENT_TENANT=" + json.dumps(tenant), "rakazo-api-1", "node", "--import", "tsx", "--input-type=module"], input=RUNNER_QUERY, text=True, capture_output=True, timeout=20, check=True)
        events += json.loads(result.stdout.strip().splitlines()[-1])
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        errors.append("runner")
    # Structured journal metadata catches failed units that recovered between ticks.
    for source, scope in (("systemd-system", ["_PID=1"]), ("systemd-user", ["--user"])):
        try:
            text = command(["journalctl", *scope, "--since", "@" + str(int(max(config.get("journal_since", time.time()), time.time()-86400))), "MESSAGE_ID=d9b373ed55a64feb8242e02dbe79a49c", "-o", "json", "--output-fields=UNIT,USER_UNIT,__REALTIME_TIMESTAMP", "--no-pager"])
            seen = set()
            for line in text.splitlines():
                row = json.loads(line)
                unit = row.get("USER_UNIT") or row.get("UNIT")
                if not unit or unit == "container-watchdog.service" or not unit.endswith(".service"):
                    continue
                bucket = str(int(row["__REALTIME_TIMESTAMP"]) // 86400000000)
                if (unit, bucket) not in seen:
                    events.append((source, unit, "service-failed", bucket))
                    seen.add((unit, bucket))
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            errors.append(source + "-journal")
    return events, errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if config.get("enabled") is False:
        print(json.dumps({"delivered": 0, "disabled": True}))
        return
    cursor_path = Path(config["state"]).with_name("scan-cursors.json")
    if cursor_path.exists():
        config["cursors"] = json.loads(cursor_path.read_text())
    else:
        config["cursors"] = {key: {"time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()-300)), "id": ""} for key in ("runs", "tools")}
        if not args.dry_run:
            cursor_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with os.fdopen(os.open(cursor_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as handle:
                json.dump(config["cursors"], handle)
    events, errors = scan(config)
    if args.dry_run:
        print(json.dumps({"events": events, "unavailable_sources": errors}))
        return
    sender_path = Path(__file__).with_name("incident-webhook.py")
    if not sender_path.exists():
        sender_path = Path(__file__).with_name("phrogvps-incident")
    spec = importlib.util.spec_from_loader("sender", SourceFileLoader("sender", str(sender_path)))
    sender = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sender)
    # Advance each runner cursor only after delivery or confirmed deduplication.
    delivered = 0
    for item in events:
        source, unit, outcome, event_id = item[:4]
        try:
            result = "skipped"
            if outcome != "skip":
                event = sender.payload(source, unit, outcome, event_id, item[6] if len(item) > 6 else None)
                result = sender.send(Path(config["credential"]), Path(config["state"]), event)
            if len(item) >= 6:
                config["cursors"][item[4]] = {"time": item[5], "id": event_id}
                with cursor_path.open("w") as handle:
                    json.dump(config["cursors"], handle)
                    handle.flush()
                    os.fsync(handle.fileno())
            if result == "delivered":
                delivered += 1
                if delivered >= 5:
                    break
        except (ValueError, OSError, KeyError):
            errors.append("delivery")
            break
    print(json.dumps({"delivered": delivered, "unavailable_sources": errors}))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
