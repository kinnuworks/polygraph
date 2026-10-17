"""Builds fixtures/contract.docx, a short services agreement between fictional companies.

Uses only the standard library so it runs anywhere: a .docx is a zip of a few XML parts.
Run: python3 apps/buyer/fixtures/make_contract.py
"""

from pathlib import Path
from xml.sax.saxutils import escape
import zipfile

OUT = Path(__file__).with_name("contract.docx")
FIXED_TIME = (2026, 10, 1, 9, 0, 0)  # constant timestamps keep the file byte-for-byte reproducible

CLIENT = "Bramblewood Example Holdings Ltd."
PROVIDER = "Quillfeather Placeholder Consulting LLC"

CLAUSES = [
    ("1. Services", [
        f"{PROVIDER} (the \"Provider\") will deliver the data migration and reporting services described in "
        f"Schedule A to {CLIENT} (the \"Client\"). The Provider will assign a named lead consultant and keep the "
        "Client informed through a written status report every second Friday.",
        "Any change to the scope must be agreed in a signed change order before work on it begins.",
    ]),
    ("2. Fees and Payment", [
        "The Client will pay the fees set out below. Invoices are issued monthly in arrears and are due within "
        "thirty (30) days of receipt. Late amounts accrue interest at one percent (1%) per month.",
    ]),
    ("3. Confidentiality", [
        "Each party will keep the other party's Confidential Information secret, use it only to perform this "
        "Agreement, and disclose it only to employees and advisers who need to know it and are bound by "
        "equivalent obligations.",
        "These obligations survive for five (5) years after this Agreement ends. They do not apply to information "
        "that is public through no fault of the receiving party, or that the receiving party must disclose by law.",
    ]),
    ("4. Term and Termination", [
        "This Agreement starts on the Effective Date and runs for twelve (12) months. Either party may terminate "
        "it on thirty (30) days' written notice, or immediately if the other party materially breaches it and "
        "fails to cure the breach within fifteen (15) days of notice.",
    ]),
    ("5. Intellectual Property", [
        "Deliverables created specifically for the Client become the Client's property on full payment. The "
        "Provider keeps ownership of its pre-existing tools and methods and grants the Client a perpetual, "
        "non-exclusive licence to use them as part of the Deliverables.",
    ]),
    ("6. Limitation of Liability", [
        "Except for breaches of Section 3, neither party is liable for indirect or consequential losses, and each "
        "party's total liability is capped at the fees paid in the twelve (12) months before the claim.",
    ]),
    ("7. Governing Law", [
        "This Agreement is governed by the laws of the State of Exampleland. The courts of Faketown have "
        "exclusive jurisdiction over any dispute arising from it.",
    ]),
]

FEES = [
    ("Item", "Rate", "Estimate"),
    ("Lead consultant", "$1,450 per day", "$17,400"),
    ("Data engineer", "$1,100 per day", "$22,000"),
    ("Reporting dashboards (fixed)", "$6,500", "$6,500"),
    ("Total estimate", "", "$45,900"),
]


def run(text, bold=False, size=None, caps=False):
    props = "".join([
        "<w:b/>" if bold else "",
        "<w:caps/>" if caps else "",
        f'<w:sz w:val="{size}"/>' if size else "",
    ])
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def para(content, style=None, align=None, after=None):
    props = "".join([
        f'<w:pStyle w:val="{style}"/>' if style else "",
        f'<w:spacing w:after="{after}"/>' if after is not None else "",
        f'<w:jc w:val="{align}"/>' if align else "",
    ])
    ppr = f"<w:pPr>{props}</w:pPr>" if props else ""
    return f"<w:p>{ppr}{content}</w:p>"


def cell(text, width, bold=False):
    return (
        f'<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="dxa"/></w:tcPr>'
        f"{para(run(text, bold=bold), after=60)}</w:tc>"
    )


def table(rows, widths):
    border = '<w:{0} w:val="single" w:sz="4" w:space="0" w:color="808080"/>'
    borders = "".join(border.format(side) for side in ("top", "left", "bottom", "right", "insideH", "insideV"))
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in widths)
    body = ""
    for i, row in enumerate(rows):
        bold = i == 0 or i == len(rows) - 1
        body += "<w:tr>" + "".join(cell(text, w, bold) for text, w in zip(row, widths)) + "</w:tr>"
    return (
        f'<w:tbl><w:tblPr><w:tblW w:w="{sum(widths)}" w:type="dxa"/><w:tblBorders>{borders}</w:tblBorders></w:tblPr>'
        f"<w:tblGrid>{grid}</w:tblGrid>{body}</w:tbl>"
    )


def document_xml():
    parts = [
        para(run("Confidential", bold=True, caps=True, size=18), align="right"),
        para(run("Confidential Services Agreement"), style="Title"),
        para(run("Agreement No. EX-2026-0417  ·  Effective Date: 1 October 2026"), after=240),
        para(
            run("This Services Agreement is made between ")
            + run(CLIENT, bold=True)
            + run(", 100 Example Street, Faketown, and ")
            + run(PROVIDER, bold=True)
            + run(", 42 Placeholder Avenue, Sampleville. All names, addresses and figures in this document are fictional.")
        ),
    ]
    for heading, paragraphs in CLAUSES:
        parts.append(para(run(heading), style="Heading1"))
        parts.extend(para(run(text)) for text in paragraphs)
        if heading.startswith("2."):
            parts.append(table(FEES, [4200, 2400, 2400]))
            parts.append(para("", after=120))
    parts.append(para(run("Signatures"), style="Heading1"))
    parts.append(table(
        [
            (f"For {CLIENT}", f"For {PROVIDER}"),
            ("Name: Jordan Sample", "Name: Riley Placeholder"),
            ("Title: Chief Operating Officer", "Title: Managing Partner"),
            ("Signature: ______________________", "Signature: ______________________"),
            ("Date: ____________", "Date: ____________"),
        ],
        [4500, 4500],
    ))
    section = (
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
        "</w:sectPr>"
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        f"<w:body>{''.join(parts)}{section}</w:body></w:document>"
    )


STYLES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Liberation Serif" w:hAnsi="Liberation Serif" w:cs="Liberation Serif"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="120"/><w:jc w:val="left"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:jc w:val="left"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
</w:styles>"""

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>"""

ROOT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>"""

DOCUMENT_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"""

CORE = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Confidential Services Agreement</dc:title>
  <dc:creator>Bramblewood Example Holdings Ltd.</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">2026-10-01T09:00:00Z</dcterms:created>
</cp:coreProperties>"""


def main():
    parts = {
        "[Content_Types].xml": CONTENT_TYPES,
        "_rels/.rels": ROOT_RELS,
        "docProps/core.xml": CORE,
        "word/_rels/document.xml.rels": DOCUMENT_RELS,
        "word/styles.xml": STYLES,
        "word/document.xml": document_xml(),
    }
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as docx:
        for name, xml in parts.items():
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            docx.writestr(info, xml)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
