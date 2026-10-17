// Scripted event sequence for ?demo=1. It only exists to preview the layout without a gateway;
// the console labels it "Preview data" whenever it runs.

const PARENT = "sbx-358cf6fbcc";
const WORKER = "sbx-ba47b7e8bb";
const DIGEST = "b962eddf4acca75382c71f7272f0ca182f4a508e9ab6c06cee255de2b2e5d501";
const PAYMENT_INTENT = "pi_3Sh4EPSbO8sUzAErPKTAqW0w";
const LOCKED = ["127.0.0.1/32"];

const sellerChecks = [
  { id: "tests", label: "Unit tests", status: "pass", detail: "13 passed, 0 failed" },
  { id: "attacks", label: "Hostile inputs", status: "pass", detail: "6 of 6 blocked" },
];

function signed(offerId, name, parentSandboxId, artifactDigest) {
  return {
    manifest: {
      offerId,
      name,
      description: "Converts .docx files to PDF with LibreOffice, inside a locked sandbox.",
      source: { repo: "github.com/LibreOffice/core", license: "MPL-2.0" },
      parentSandboxId,
      egress: LOCKED,
      artifactDigest,
      priceUsd: "0.50",
      checks: sellerChecks,
      createdAt: new Date().toISOString(),
    },
    jws: "eyJhbGciOiJFZERTQSIsInR5cCI6InBvbHlncmFwaC1vZmZlcitqd3MifQ.preview.preview",
    publicKey: { kty: "OKP", crv: "Ed25519", x: "if6mCgV8ydjTeEa7bxDAa9dB8ouZDF7lPoT5HQyjIHM" },
  };
}

const HONEST = "docx-to-pdf-358c";
const LYING = "docx-to-pdf-pro-7c13";
const TAMPERED = "docx-to-pdf-express-28ff";

const check = (offerId, id, label, status, detail) => ({ type: "buyer.check", offerId, check: { id, label, status, detail } });

const postPaymentChecks = [
  { id: "lineage", label: "Worker forked from the signed parent", status: "pass", detail: `claimed: ${PARENT} · platform: ${PARENT}` },
  { id: "worker-egress", label: "Worker egress matches the claim", status: "pass", detail: "claimed: 127.0.0.1/32 · platform: 127.0.0.1/32" },
  { id: "digest", label: "Tool digest recomputed in the worker", status: "pass", detail: "claimed: b962eddf…d501 · platform: b962eddf…d501" },
];

const firstPatch = `@@ -14,9 +14,12 @@ def convert(src: Path, out_dir: Path) -> Path:
     cmd = [
         "soffice", "--headless",
-        "--convert-to", "pdf",
+        "--convert-to", "pdf:writer_pdf_Export",
         "--outdir", str(out_dir), str(src),
     ]
-    subprocess.run(cmd, check=True)
+    env = {**os.environ, "HOME": "/tmp"}
+    subprocess.run(cmd, check=True, env=env, timeout=60)
+    if not pdf.exists() or pdf.stat().st_size == 0:
+        raise ConversionError("soffice wrote no output")
     return pdf`;

const secondPatch = `@@ -6,8 +6,10 @@ import subprocess
 MAX_INPUT_BYTES = 20 * 1024 * 1024
+MAX_IMAGE_PIXELS = 40_000_000

 def convert(src: Path, out_dir: Path) -> Path:
     check_size(src, MAX_INPUT_BYTES)
+    check_images(src, MAX_IMAGE_PIXELS)
     out_dir.mkdir(parents=True, exist_ok=True)`;

/** [delay before this event in ms, event without ts] */
const SCRIPT = [
  [400, { type: "seller.step", step: "Created a build sandbox", detail: "devbox:1 · s-2vcpu-4gb · ready in 1.4 s" }],
  [900, { type: "seller.step", step: "Installed LibreOffice Writer", detail: "libreoffice-writer-nogui, python3-uno · 23.1 s" }],
  [900, { type: "seller.step", step: "Wrote the wrapper", detail: "convert.py reads a .docx and writes a PDF" }],
  [900, { type: "seller.test", passed: 9, failed: 2 }],
  [1000, { type: "seller.patch", file: "convert.py", diff: firstPatch }],
  [1000, { type: "seller.test", passed: 11, failed: 0 }],
  [800, { type: "seller.step", step: "Attacking the tool", detail: "6 hostile documents" }],
  [600, { type: "seller.attack", attack: "Path traversal", status: "blocked", detail: "../../etc/passwd rejected" }],
  [450, { type: "seller.attack", attack: "Zip bomb .docx", status: "blocked", detail: "stopped at 64 MB expanded" }],
  [450, { type: "seller.attack", attack: "Macro auto-run", status: "blocked", detail: "macros disabled" }],
  [450, { type: "seller.attack", attack: "Outbound HTTP", status: "blocked", detail: "example.com unreachable" }],
  [450, { type: "seller.attack", attack: "XXE in document.xml", status: "blocked", detail: "external entities ignored" }],
  [450, { type: "seller.attack", attack: "Oversized image", status: "crashed", detail: "soffice ran out of memory" }],
  [1000, { type: "seller.patch", file: "convert.py", diff: secondPatch }],
  [900, { type: "seller.attack", attack: "Oversized image", status: "blocked", detail: "rejected above 40 MP" }],
  [600, { type: "seller.test", passed: 13, failed: 0 }],
  [800, { type: "seller.step", step: "Locked egress", detail: "allowlist 127.0.0.1/32, everything else denied" }],
  [700, { type: "seller.step", step: "Paused the parent sandbox", detail: PARENT }],
  [700, { type: "seller.step", step: "Signed and published the offer", detail: "EdDSA over the canonical manifest" }],
  [500, { type: "offer.published", offer: signed(HONEST, "docx-to-pdf", PARENT, DIGEST) }],
  [500, { type: "offer.published", offer: signed(LYING, "docx-to-pdf Pro", "sbx-7c1348a4bd", "5d0f7e3a91c2b84d6e0a7f13c95b2e48d1a6f03b7c4e92d58a1b6f0e3c7d2a94") }],
  [500, { type: "offer.published", offer: signed(TAMPERED, "docx-to-pdf Express", "sbx-28ff1b901a", "f0352d949f6ab43978c6a8db4e54cfe38c8c14d94641ff57fc5d8c33f840e846") }],

  [1200, { type: "buyer.step", step: "Found 3 offers", detail: "GET /offers on the gateway" }],
  [900, { type: "buyer.step", step: "Checking docx-to-pdf Pro", detail: "got a read-only CreateOS token for its parent" }],
  [800, check(LYING, "signature", "Seller signature", "pass", "EdDSA, covers the manifest shown")],
  [700, check(LYING, "parent-status", "Parent sandbox is paused", "pass", "claimed: paused · platform: paused")],
  [900, check(LYING, "egress", "Egress matches the claim", "fail", "claimed: 127.0.0.1/32 · platform: no rules, all traffic allowed")],
  [900, { type: "buyer.refused", offerId: LYING, reason: "The parent sandbox has no egress rules, so a worker could send your document anywhere." }],
  [1100, { type: "buyer.step", step: "Checking docx-to-pdf Express", detail: "got a read-only CreateOS token for its parent" }],
  [800, check(TAMPERED, "signature", "Seller signature", "fail", "The signed payload differs from the manifest shown: artifactDigest changed after signing.")],
  [900, { type: "buyer.refused", offerId: TAMPERED, reason: "Someone edited the offer after the seller signed it." }],
  [1100, { type: "buyer.step", step: "Checking docx-to-pdf", detail: "got a read-only CreateOS token for its parent" }],
  [700, check(HONEST, "signature", "Seller signature", "pass", "EdDSA, covers the manifest shown")],
  [600, check(HONEST, "parent-status", "Parent sandbox is paused", "pass", "claimed: paused · platform: paused")],
  [700, check(HONEST, "egress", "Egress matches the claim", "pass", "claimed: 127.0.0.1/32 · platform: 127.0.0.1/32")],
  [600, check(HONEST, "seller-checks", "Seller tests and attacks", "pass", "13 tests passed, 6 of 6 attacks blocked")],
  [900, { type: "buyer.step", step: "Paying $0.50", detail: "Stripe machine payments, card SPT, test mode" }],
  [1300, { type: "payment.created", paymentIntentId: PAYMENT_INTENT, amountUsd: "0.50" }],
  [900, { type: "worker.forked", workerSandboxId: WORKER, parentSandboxId: PARENT, ms: 4812 }],
  ...postPaymentChecks.map((c, i) => [i ? 650 : 900, { type: "buyer.check", offerId: HONEST, check: c }]),
  [900, { type: "buyer.step", step: "Uploaded quarterly-report.docx", detail: "48.2 KB · sha256 3daa3bfe…58fe" }],
  [1100, { type: "buyer.step", step: "Converted in the worker", detail: "soffice --headless · 1.02 s" }],
  [800, { type: "buyer.step", step: "Checked the PDF", detail: "3 pages, text present" }],
  [800, {
    type: "job.completed",
    receipt: {
      purchaseId: "pur_8d1f3a6c2e",
      offerId: HONEST,
      paymentIntentId: PAYMENT_INTENT,
      artifactDigest: DIGEST,
      parentSandboxId: PARENT,
      workerSandboxId: WORKER,
      verification: [
        { id: "signature", label: "Seller signature", status: "pass" },
        { id: "parent-status", label: "Parent sandbox is paused", status: "pass" },
        { id: "egress", label: "Egress matches the claim", status: "pass" },
        { id: "seller-checks", label: "Seller tests and attacks", status: "pass" },
        ...postPaymentChecks.map(({ id, label, status }) => ({ id, label, status })),
      ],
      inputSha256: "3daa3bfe46e479dda590fc39536491fab10f0d80e78640ca0ac354826b2c58fe",
      outputSha256: "df80bf0135fcfb5e3e4e35c35cd9839345cafc8d04501fde75e4cc3bbb063850",
      completedAt: "", // filled in when the event fires
    },
  }],
  [1200, { type: "worker.destroyed", workerSandboxId: WORKER }],
];

/** Plays the script through `emit`. Returns a function that stops it. */
export function runDemo(emit, { onDone } = {}) {
  const timers = [];
  let at = 0;
  for (const [delay, event] of SCRIPT) {
    at += delay;
    timers.push(setTimeout(() => {
      const ts = new Date().toISOString();
      const full = structuredClone(event);
      full.ts = ts;
      if (full.type === "job.completed") full.receipt.completedAt = ts;
      emit(full);
    }, at));
  }
  timers.push(setTimeout(() => onDone?.(), at + 200));
  return () => timers.forEach(clearTimeout);
}
