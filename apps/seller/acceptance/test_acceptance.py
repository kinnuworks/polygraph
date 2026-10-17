"""Acceptance tests for the converter, written against the published interface only."""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import CONVERTER, DOCX_TITLE, FORMATS, SHEET_TOKENS, convert, describe, last_line, pdf_info, pdf_text, pdf_title, token


def outdir_in(tmp_path: Path) -> Path:
    out = tmp_path / "out"
    out.mkdir()
    return out


def assert_converted(result: subprocess.CompletedProcess, expected_pdf: Path, expected_text: str) -> None:
    assert result.returncode == 0, f"expected exit 0. {describe(result)}"
    assert last_line(result.stdout) == str(expected_pdf), (
        f"last stdout line should be the absolute PDF path {str(expected_pdf)!r}. {describe(result)}"
    )
    assert expected_pdf.is_file(), f"{expected_pdf.name} was not written to the output directory. {describe(result)}"
    assert expected_pdf.read_bytes()[:5] == b"%PDF-", f"{expected_pdf.name} is not a PDF"
    text = " ".join(pdf_text(expected_pdf).split())
    assert expected_text in text, f"PDF text does not contain {expected_text!r}; extracted: {text[:300]!r}"


@pytest.mark.parametrize("fmt", FORMATS)
def test_converts_each_supported_format(fmt, samples, tmp_path):
    source = tmp_path / f"input.{fmt}"
    shutil.copy(samples[fmt], source)
    out = outdir_in(tmp_path)
    assert_converted(convert(source, out), out / "input.pdf", token(fmt))


def test_spaces_and_non_ascii_in_file_name(samples, tmp_path):
    source = tmp_path / "Résumé final – ünïcode 文件.docx"
    shutil.copy(samples["docx"], source)
    out = outdir_in(tmp_path)
    assert_converted(convert(source, out), out / "Résumé final – ünïcode 文件.pdf", token("docx"))


def test_two_conversions_at_the_same_time(samples, tmp_path):
    first = tmp_path / "first job.docx"
    second = tmp_path / "second job.odt"
    shutil.copy(samples["docx"], first)
    shutil.copy(samples["odt"], second)
    out = outdir_in(tmp_path)
    procs = [
        subprocess.Popen(["python3", CONVERTER, str(path), str(out)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        for path in (first, second)
    ]
    results = []
    for proc in procs:
        stdout, stderr = proc.communicate(timeout=240)
        results.append(subprocess.CompletedProcess(proc.args, proc.returncode, stdout, stderr))
    assert_converted(results[0], out / "first job.pdf", token("docx"))
    assert_converted(results[1], out / "second job.pdf", token("odt"))


def test_unsupported_extension_exits_2(tmp_path):
    source = tmp_path / "notes.xyz"
    source.write_text("plain text with an unsupported extension\n", encoding="utf-8")
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 2, f"expected exit 2 for an unsupported extension. {describe(result)}"
    assert not any(out.iterdir()), "nothing should be written for a rejected input"


def test_missing_input_exits_2(tmp_path):
    out = outdir_in(tmp_path)
    result = convert(tmp_path / "does-not-exist.docx", out)
    assert result.returncode == 2, f"expected exit 2 for an unreadable input. {describe(result)}"


def test_random_bytes_input_exits_2(tmp_path):
    source = tmp_path / "broken.docx"
    source.write_bytes(os.urandom(4096))
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 2, f"expected exit 2 for a corrupt input. {describe(result)}"
    assert not any(out.iterdir()), "nothing should be written for a corrupt input"


def test_truncated_document_exits_2(samples, tmp_path):
    data = samples["docx"].read_bytes()
    source = tmp_path / "truncated.docx"
    source.write_bytes(data[: len(data) // 2])
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 2, f"expected exit 2 for a truncated input. {describe(result)}"


def test_input_over_25_mb_exits_3(tmp_path):
    source = tmp_path / "big.docx"
    with source.open("wb") as handle:
        handle.truncate(26 * 1024 * 1024)
    out = outdir_in(tmp_path)
    result = convert(source, out, timeout=120)
    assert result.returncode == 3, f"expected exit 3 for an input over 25 MB. {describe(result)}"
    assert not any(out.iterdir()), "nothing should be written for an oversized input"


def pdfa_identification(pdf: Path) -> tuple[str, str]:
    """Reads pdfaid:part and pdfaid:conformance from the XMP packet, in element or attribute form."""
    xmp = pdf_info(pdf, "-meta") or pdf.read_bytes().decode("latin-1")
    def field(name: str) -> str:
        match = re.search(rf"pdfaid:{name}>\s*([^<\s]+)\s*<|pdfaid:{name}=[\"']([^\"']+)[\"']", xmp)
        return (match.group(1) or match.group(2)) if match else ""
    return field("part"), field("conformance")


@pytest.mark.parametrize("fmt", ("docx", "xlsx"))
def test_output_is_pdfa_2b(fmt, samples, tmp_path):
    source = tmp_path / f"archive.{fmt}"
    shutil.copy(samples[fmt], source)
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 0, f"expected exit 0. {describe(result)}"
    part, conformance = pdfa_identification(out / "archive.pdf")
    assert (part, conformance.upper()) == ("2", "B"), (
        f"XMP metadata should identify PDF/A-2b (pdfaid:part 2, pdfaid:conformance B); found part={part!r} conformance={conformance!r}"
    )


def test_title_comes_from_document_metadata(samples, tmp_path):
    source = tmp_path / "msa-final.docx"
    shutil.copy(samples["titled-docx"], source)
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 0, f"expected exit 0. {describe(result)}"
    title = pdf_title(out / "msa-final.pdf")
    assert title == DOCX_TITLE, f"PDF Title should be the document's title metadata {DOCX_TITLE!r}; found {title!r}"


def test_title_falls_back_to_file_stem(samples, tmp_path):
    source = tmp_path / "Lease renewal 2026.odt"
    shutil.copy(samples["odt"], source)
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 0, f"expected exit 0. {describe(result)}"
    title = pdf_title(out / "Lease renewal 2026.pdf")
    assert title == "Lease renewal 2026", f"PDF Title should fall back to the file stem 'Lease renewal 2026' when the input has no title; found {title!r}"


def test_every_sheet_is_exported(samples, tmp_path):
    source = tmp_path / "workbook.xlsx"
    shutil.copy(samples["two-sheets"], source)
    out = outdir_in(tmp_path)
    result = convert(source, out)
    assert result.returncode == 0, f"expected exit 0. {describe(result)}"
    text = " ".join(pdf_text(out / "workbook.pdf").split())
    missing = [t for t in SHEET_TOKENS if t not in text]
    assert not missing, f"text from every sheet should appear in the PDF; missing {missing}; extracted: {text[:300]!r}"
