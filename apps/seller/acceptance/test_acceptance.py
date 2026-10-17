"""Acceptance tests for the converter, written against the published interface only."""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

from conftest import CONVERTER, FORMATS, convert, describe, last_line, pdf_text, token


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
