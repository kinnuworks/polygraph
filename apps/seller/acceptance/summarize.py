"""Turns a pytest JUnit XML report into JSON the seller can feed back without revealing test source."""

import json
import re
import sys
import xml.etree.ElementTree as ET

cases = []
for case in ET.parse(sys.argv[1]).getroot().iter("testcase"):
    problem = case.find("failure")
    if problem is None:
        problem = case.find("error")
    skipped = case.find("skipped") is not None
    outcome = "failed" if problem is not None else ("skipped" if skipped else "passed")
    raw = "\n".join(node.text or "" for node in case if node.tag in ("system-out", "system-err"))
    captured = "\n".join(line for line in raw.splitlines() if line.strip() and not re.fullmatch(r"-+ Captured \w+ -+", line.strip()))
    cases.append({
        "test": case.get("name", ""),
        "outcome": outcome,
        "message": (problem.get("message") or "") if problem is not None else "",
        "captured": captured[-2000:],
    })
json.dump(cases, sys.stdout)
