#!/usr/bin/env python3
import json
import os
import platform
import resource
import sys
import time

PROTOCOL_VERSION = 1
STARTED = time.monotonic()

def log(level, event, **fields):
    print(json.dumps({"timestamp": time.time(), "level": level, "event": event, **fields}), file=sys.stderr, flush=True)

def response(request_id, ok, result=None, code=None, message=None):
    payload = {"protocol": PROTOCOL_VERSION, "id": request_id, "ok": ok}
    if ok: payload["result"] = result
    else: payload["error"] = {"code": code, "message": message}
    print(json.dumps(payload), flush=True)

log("info", "worker_started", protocol=PROTOCOL_VERSION, pid=os.getpid())
for line in sys.stdin:
    try:
        request = json.loads(line)
        request_id = str(request.get("id", ""))
        if request.get("protocol") != PROTOCOL_VERSION:
            response(request_id, False, code="protocol_mismatch", message=f"Expected protocol {PROTOCOL_VERSION}")
            continue
        method = request.get("method")
        if method == "health":
            response(request_id, True, {"status": "ok", "protocol": PROTOCOL_VERSION, "pid": os.getpid(), "python": platform.python_version(), "uptimeSeconds": time.monotonic() - STARTED})
        elif method == "metrics":
            usage = resource.getrusage(resource.RUSAGE_SELF)
            response(request_id, True, {"uptimeSeconds": time.monotonic() - STARTED, "maxRssKb": usage.ru_maxrss, "userCpuSeconds": usage.ru_utime, "systemCpuSeconds": usage.ru_stime})
        elif method == "shutdown":
            response(request_id, True, {"shuttingDown": True}); log("info", "worker_shutdown"); break
        else:
            response(request_id, False, code="method_not_found", message=f"Unknown method: {method}")
    except Exception as error:
        log("error", "request_failed", error=str(error))
        response("", False, code="invalid_request", message=str(error))
