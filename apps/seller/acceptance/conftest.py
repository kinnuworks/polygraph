"""Shared helpers for the acceptance suite.

Sample inputs are generated at test time with LibreOffice itself, so the suite does not depend on
anything the converter's author wrote.
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

CONVERTER = "/opt/tool/convert.py"
FORMATS = ("docx", "odt", "rtf", "pptx", "xlsx")


def token(fmt: str) -> str:
    return f"Polygraph acceptance {fmt} 7731"


def _soffice(args: list[str], cwd: Path, profile: Path) -> str:
    env = dict(os.environ, HOME=str(profile))
    result = subprocess.run(
        ["soffice", f"-env:UserInstallation=file://{profile}/lo", "--headless", *args],
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(f"sample generation failed: soffice {' '.join(args)}: {result.stderr[-500:]}")
    return result.stdout + result.stderr


FLAT_ODP = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.presentation">
  <office:body>
    <office:presentation>
      <draw:page draw:name="page1">
        <draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="3cm">
          <draw:text-box><text:p>{text}</text:p></draw:text-box>
        </draw:frame>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document>
"""


@pytest.fixture(scope="session")
def samples(tmp_path_factory) -> dict[str, Path]:
    """One small document per supported format, each containing that format's token."""
    work = tmp_path_factory.mktemp("samples")
    profile = tmp_path_factory.mktemp("profile")
    logs = {}
    for fmt, target in (("docx", "docx:MS Word 2007 XML"), ("odt", "odt"), ("rtf", "rtf")):
        source = work / f"sample-{fmt}.txt"
        source.write_text(token(fmt) + "\n", encoding="utf-8")
        logs[fmt] = _soffice(["--convert-to", target, source.name], work, profile)
    (work / "sample-xlsx.csv").write_text(f"{token('xlsx')},42\n", encoding="utf-8")
    logs["xlsx"] = _soffice(["--convert-to", "xlsx", "sample-xlsx.csv"], work, profile)
    (work / "sample-pptx.fodp").write_text(FLAT_ODP.format(text=token("pptx")), encoding="utf-8")
    logs["pptx"] = _soffice(["--convert-to", "pptx", "sample-pptx.fodp"], work, profile)

    paths = {fmt: work / f"sample-{fmt}.{fmt}" for fmt in FORMATS}
    missing = [fmt for fmt, path in paths.items() if not path.is_file() or path.stat().st_size == 0]
    if missing:
        detail = "; ".join(f"{fmt}: {logs[fmt].strip()[-300:]!r}" for fmt in missing)
        raise RuntimeError(f"sample generation produced no file for {', '.join(missing)}: {detail}")
    return paths


def convert(input_path: Path, outdir: Path, timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["python3", CONVERTER, str(input_path), str(outdir)],
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def describe(result: subprocess.CompletedProcess) -> str:
    """What the converter did, for assertion messages: exit code and the tail of its output."""
    return f"exit {result.returncode}; stdout: {result.stdout[-600:]!r}; stderr: {result.stderr[-600:]!r}"


def last_line(text: str) -> str:
    lines = [line for line in text.splitlines() if line.strip()]
    return lines[-1].strip() if lines else ""


def pdf_text(path: Path) -> str:
    if shutil.which("pdftotext"):
        return subprocess.run(["pdftotext", str(path), "-"], capture_output=True, text=True, timeout=60).stdout
    return path.read_bytes().decode("latin-1")
