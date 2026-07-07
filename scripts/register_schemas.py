#!/usr/bin/env python3
"""Registers every event schema against the Apicurio ccompat endpoint.

Subject = "<topic>-value" (TopicNameStrategy). Idempotent — identical content
returns the existing schema id. Stdlib only, so it runs from the host or as a
one-shot python:alpine compose job.

Env: SCHEMA_REGISTRY_URL (default http://apicurio-registry:8080/apis/ccompat/v7)
"""
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

REGISTRY = os.environ.get(
    "SCHEMA_REGISTRY_URL", "http://apicurio-registry:8080/apis/ccompat/v7"
).rstrip("/")
EVENTS_DIR = pathlib.Path(os.environ.get("EVENTS_DIR", "contracts/events"))


def post_schema(subject: str, schema_doc: dict) -> int:
    body = json.dumps(
        {"schemaType": "JSON", "schema": json.dumps(schema_doc, separators=(",", ":"))}
    ).encode()
    req = urllib.request.Request(
        f"{REGISTRY}/subjects/{subject}/versions",
        data=body,
        headers={"Content-Type": "application/vnd.schemaregistry.v1+json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.load(resp)["id"]


def main() -> int:
    topics = json.loads((EVENTS_DIR / "topics.json").read_text())
    # Registry may still be warming up when this job starts.
    for attempt in range(30):
        try:
            urllib.request.urlopen(f"{REGISTRY}/subjects", timeout=5)
            break
        except (urllib.error.URLError, OSError):
            time.sleep(2)
    else:
        print(f"registry unreachable at {REGISTRY}", file=sys.stderr)
        return 1

    failures = 0
    for topic, filename in sorted(topics.items()):
        subject = f"{topic}-value"
        schema_doc = json.loads((EVENTS_DIR / filename).read_text())
        try:
            schema_id = post_schema(subject, schema_doc)
            print(f"✓ {subject} → id {schema_id}")
        except urllib.error.HTTPError as e:
            print(f"✗ {subject}: HTTP {e.code} {e.read().decode()[:200]}", file=sys.stderr)
            failures += 1
    print(f"done: {len(topics) - failures}/{len(topics)} subjects registered at {REGISTRY}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
