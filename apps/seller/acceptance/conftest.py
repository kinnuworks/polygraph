"""Shared helpers for the acceptance suite.

Sample inputs are generated at test time with LibreOffice itself, so the suite does not depend on
anything the converter's author wrote.
"""

import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

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


FLAT_ODS = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.spreadsheet">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="Clauses">
        <table:table-row><table:table-cell office:value-type="string"><text:p>{first}</text:p></table:table-cell></table:table-row>
      </table:table>
      <table:table table:name="Schedule">
        <table:table-row><table:table-cell office:value-type="string"><text:p>{second}</text:p></table:table-cell></table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document>
"""

SHEET_TOKENS = ("Clause sheet token 4417", "Schedule sheet token 9083")
DOCX_TITLE = "Master Services Agreement 7731"


def with_core_title(source: Path, target: Path, title: str) -> None:
    """Copies an OOXML file, setting dc:title in docProps/core.xml."""
    with zipfile.ZipFile(source) as src, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "docProps/core.xml":
                xml = data.decode("utf-8")
                xml = re.sub(r"<dc:title>.*?</dc:title>|<dc:title/>", "", xml, flags=re.S)
                xml = re.sub(r"(<cp:coreProperties[^>]*>)", lambda m: m.group(1) + f"<dc:title>{escape(title)}</dc:title>", xml, count=1)
                if 'xmlns:dc="' not in xml:
                    raise RuntimeError("core.xml has no dc namespace")
                data = xml.encode("utf-8")
            dst.writestr(item, data)


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
    (work / "two-sheets.fods").write_text(FLAT_ODS.format(first=SHEET_TOKENS[0], second=SHEET_TOKENS[1]), encoding="utf-8")
    logs["two-sheets"] = _soffice(["--convert-to", "xlsx", "two-sheets.fods"], work, profile)

    paths = {fmt: work / f"sample-{fmt}.{fmt}" for fmt in FORMATS}
    paths["two-sheets"] = work / "two-sheets.xlsx"
    if (work / "sample-docx.docx").is_file():
        paths["titled-docx"] = work / "titled.docx"
        with_core_title(work / "sample-docx.docx", paths["titled-docx"], DOCX_TITLE)
        logs["titled-docx"] = "derived from the docx sample"
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


def pdf_info(path: Path, *flags: str) -> str:
    result = subprocess.run(["pdfinfo", *flags, str(path)], capture_output=True, text=True, timeout=60)
    return result.stdout


def pdf_title(path: Path) -> str:
    for line in pdf_info(path).splitlines():
        if line.startswith("Title:"):
            return line[len("Title:"):].strip()
    return ""


def pdf_text(path: Path) -> str:
    if shutil.which("pdftotext"):
        return subprocess.run(["pdftotext", str(path), "-"], capture_output=True, text=True, timeout=60).stdout
    return path.read_bytes().decode("latin-1")
