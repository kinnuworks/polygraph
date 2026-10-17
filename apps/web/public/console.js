// Renders PolygraphEvents into the three-column live console.
// All event data is untrusted network input, so text only ever goes in via textContent.

const STRIPE_PAYMENT_URL = "https://dashboard.stripe.com/test/payments/";
const PHASE_OF = {
  "seller.step": 0, "seller.test": 0, "seller.patch": 0, "seller.attack": 0, "offer.published": 0,
  "buyer.step": 1, "buyer.check": 1, "buyer.refused": 1,
  "payment.created": 2, "payment.refunded": 2,
  "worker.forked": 3, "worker.destroyed": 3, "job.completed": 3,
};
// Buyer steps that mean an attempt went wrong; they collapse into one grey line per run.
const FAILURE_STEPS = new Set(["payment-failed", "job-failed", "refund-failed", "release-failed", "no-purchase", "no-offers", "own-destroy-failed"]);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- small helpers ---------- */

/** Tiny element builder: h("p", { class: "x" }, "text", child). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Inline icon that references a <symbol> in index.html. */
export function icon(name, strokeWidth = 2) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(strokeWidth));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

const clock = (ts) => {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB", { hour12: false });
};
const hhmm = (ts) => clock(ts).slice(0, 5);
const usd = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${amount}`;
};

/** A long hash or fingerprint shown as its first 8 and last 4 characters. */
export function shortHash(value) {
  const s = String(value ?? "");
  return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

/**
 * Makes agent output fit for a public screen: local paths become their file name,
 * hashes and key fingerprints shrink to 8…4.
 */
export function clean(text) {
  return String(text ?? "")
    .replace(/(?:\/Users|\/private)\/[^\s"'`·,;()]+/g, (path) => path.split("/").filter(Boolean).pop() ?? path)
    .replace(/\b([0-9a-f]{8})[0-9a-f]{8,}([0-9a-f]{4})\b(?!…)/g, "$1…$2")
    .replace(/\b([0-9a-f]{8})[0-9a-f]{4,}…/g, "$1…")
    .replace(/SHA256:([A-Za-z0-9+/_-]{8})[A-Za-z0-9+/_-]{8,}([A-Za-z0-9+/_-]{4})(?![A-Za-z0-9+/_…-])/g, "SHA256:$1…$2")
    .replace(/SHA256:([A-Za-z0-9+/_-]{8})[A-Za-z0-9+/_-]+…/g, "SHA256:$1…");
}

/** First line of a failure message, without HTML or JSON dumps. */
function summarize(text, max = 96) {
  let s = clean(text).split("\n")[0];
  const cut = s.search(/:\s*[[{<]| HTML\b/);
  if (cut > 0) s = s.slice(0, cut);
  s = s.replace(/[\s:;,·]+$/, "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const EVIDENCE_LABELS = ["signed parent", "claimed", "CreateOS", "signed", "worker", "buyer", "grant", "paid", "receipt", "forked_from", "pinned", "platform"];

/**
 * Turns a check detail such as "claimed [127.0.0.1:9] · CreateOS []" into labelled rows.
 * Returns null when the detail is not a comparison.
 */
export function parseEvidence(detail) {
  if (typeof detail !== "string") return null;
  const parts = clean(detail).split(/\s+·\s+/);
  if (parts.length < 2) return null;
  const rows = [];
  const notes = [];
  for (const part of parts) {
    const label = EVIDENCE_LABELS.find((l) => part.toLowerCase().startsWith(`${l.toLowerCase()} `) || part.toLowerCase().startsWith(`${l.toLowerCase()}:`));
    if (label) rows.push({ label, value: part.slice(label.length).replace(/^[:\s]+/, "") });
    else notes.push(part);
  }
  return rows.length >= 2 ? { rows, note: notes.join(" · ") } : null;
}

/** Builds the receipt card. `light` switches to the page palette for the receipts section. */
export function renderReceipt(receipt, { light = false } = {}) {
  const verification = Array.isArray(receipt.verification) ? receipt.verification : [];
  const passed = verification.filter((c) => c.status === "pass").length;
  const piLink = h("a", { href: STRIPE_PAYMENT_URL + encodeURIComponent(receipt.paymentIntentId), target: "_blank", rel: "noopener" }, receipt.paymentIntentId);
  const hash = (value) => h("span", { title: value }, shortHash(value));
  const completed = new Date(receipt.completedAt);
  const rows = [
    ["Purchase", receipt.purchaseId],
    ["Offer", receipt.offerId],
    ["PaymentIntent", piLink],
    ["Parent sandbox", receipt.parentSandboxId],
    ["Worker", receipt.workerSandboxId],
    ["Tool digest", hash(receipt.artifactDigest)],
    ["Input sha256", hash(receipt.inputSha256)],
    ["Output sha256", hash(receipt.outputSha256)],
    ["Verification", verification.length ? h("span", { class: passed === verification.length ? "ok" : "" }, `${passed} of ${verification.length} checks passed`) : "none recorded"],
    ["Completed", receipt.completedAt],
  ];
  return h("article", { class: `receipt${light ? " receipt--light" : ""}`, "aria-label": "Receipt" },
    h("header", { class: "receipt__head" },
      h("span", { class: "receipt__seal" }, icon("check", 3)),
      h("div", {},
        h("p", { class: "receipt__title" }, "Receipt"),
        h("p", { class: "receipt__sub" }, Number.isNaN(completed.getTime()) ? "Job completed" : `Job completed at ${clock(receipt.completedAt)}`)),
    ),
    h("dl", { class: "receipt__rows" },
      rows.map(([label, value]) => h("div", { class: "receipt__row" }, h("dt", {}, label), h("dd", {}, value ?? "")))),
  );
}

/* ---------- step wording ---------- */

const titleCase = (slug) => {
  const s = String(slug ?? "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const SELLER_STEPS = {
  acceptance: "Sealed the acceptance suite",
  provision: "Provisioning the build sandbox",
  draft: "Drafting the tool",
  fix: "Fixing from the test output",
  harden: "Hardening",
  egress: "Locking the network",
  publish: "Publishing the offer",
};

/* ---------- the console ---------- */

export function createConsole(root, { onReceipt } = {}) {
  const el = (name) => root.querySelector(`[data-el="${name}"]`);
  const dom = {
    conn: el("conn"), live: el("live"),
    phases: [...root.querySelectorAll("[data-phase]")],
    sellerCol: el("seller-col"),
    sellerPill: el("seller-pill"), trustPill: el("trust-pill"), buyerPill: el("buyer-pill"),
    tests: el("tests"), testPass: el("test-pass"), testFail: el("test-fail"), testRuns: el("test-runs"),
    barPass: el("test-bar-pass"), barFail: el("test-bar-fail"),
    attacks: el("attacks"), attackSum: el("attack-sum"),
    sellerFeed: el("seller-feed"), sellerScroll: el("seller-scroll"),
    offers: el("offers"), offersScroll: el("offers-scroll"), tally: el("tally"),
    pay: el("pay"), payBody: el("pay-body"), payNote: el("pay-note"),
    vm: el("vm"), vmDigit: el("vm-digit"), vmMeta: el("vm-meta"),
    runs: el("buyer-feed"), buyerScroll: el("buyer-scroll"),
  };

  let state;
  let emptyOffersHint = null;

  function reset() {
    state = {
      phase: -1, done: false,
      sellerSeen: false,
      tests: { runs: 0 },
      attacks: new Map(),
      offers: new Map(),
      offerNames: new Map(),
      activeOfferId: null,
      payingOfferId: null,
      payments: [],
      runs: [],
      vm: 0,
    };
    dom.sellerFeed.replaceChildren(sellerEmptyCard());
    dom.sellerCol.dataset.empty = "";
    dom.runs.replaceChildren(h("p", { class: "runs__empty" }, "Waiting for the buyer agent to start."));
    dom.attacks.replaceChildren();
    dom.offers.replaceChildren();
    dom.tally.replaceChildren();
    dom.attackSum.textContent = "";
    dom.testPass.textContent = "0";
    dom.testFail.textContent = "0";
    dom.testRuns.textContent = "no runs yet";
    dom.barPass.style.width = "0";
    dom.barFail.style.width = "0";
    delete dom.tests.dataset.failing;
    delete dom.tests.dataset.runs;
    renderPayments(true);
    dom.vm.dataset.state = "0";
    dom.vmDigit.replaceChildren(h("span", { class: "vm__num" }, "0"));
    dom.vmDigit.setAttribute("aria-label", "Workers running: 0");
    dom.vmMeta.textContent = "No worker forked yet";
    setPill(dom.sellerPill, "Idle");
    setPill(dom.trustPill, "Idle");
    setPill(dom.buyerPill, "Waiting");
    renderPhases();
    renderOffersEmpty();
  }

  /* ---------- shared helpers ---------- */

  function setPill(pill, text, tone) {
    pill.textContent = text;
    if (tone) pill.dataset.tone = tone;
    else delete pill.dataset.tone;
  }

  function announce(text, instant) {
    if (instant) return;
    dom.live.textContent = "";
    requestAnimationFrame(() => { dom.live.textContent = text; });
  }

  // Feeds follow new items until the viewer scrolls up to read something; scrolling back
  // to the bottom resumes following. Only user input counts, never our own smooth scrolls.
  const following = new WeakMap();
  for (const scroller of [dom.sellerScroll, dom.buyerScroll]) {
    following.set(scroller, true);
    let userUntil = 0;
    const mark = () => { userUntil = performance.now() + 900; };
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach((type) => scroller.addEventListener(type, mark, { passive: true }));
    scroller.addEventListener("scroll", () => {
      if (performance.now() > userUntil) return;
      following.set(scroller, scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60);
    }, { passive: true });
  }

  function follow(scroller, instant) {
    if (following.get(scroller)) scrollTo(scroller, scroller.scrollHeight, instant);
  }

  function append(scroller, list, node, instant) {
    if (instant) node.classList.add("is-instant");
    list.append(node);
    follow(scroller, instant);
  }

  function scrollTo(scroller, top, instant) {
    scroller.scrollTo({ top, behavior: instant || reducedMotion.matches ? "auto" : "smooth" });
  }

  const tweens = new WeakMap();
  function tween(node, to, instant) {
    const running = tweens.get(node);
    if (running) { cancelAnimationFrame(running.frame); clearTimeout(running.settle); }
    const from = Number(node.textContent) || 0;
    if (instant || reducedMotion.matches || from === to) { node.textContent = String(to); return; }
    const start = performance.now();
    const job = {};
    const step = (now) => {
      const t = Math.min(1, (now - start) / 600);
      node.textContent = String(Math.round(from + (to - from) * (1 - (1 - t) ** 3)));
      if (t < 1) job.frame = requestAnimationFrame(step);
    };
    job.frame = requestAnimationFrame(step);
    // Background tabs pause animation frames; make sure the final number still lands.
    job.settle = setTimeout(() => { cancelAnimationFrame(job.frame); node.textContent = String(to); }, 650);
    tweens.set(node, job);
  }

  function feedItem(ev, text, detail, variant) {
    return h("li", { class: `feed__item${variant ? ` feed__item--${variant}` : ""}` },
      h("time", { class: "feed__time", datetime: ev.ts }, clock(ev.ts)),
      h("div", {},
        text instanceof Node ? text : h("p", { class: "feed__text" }, clean(text)),
        detail ? h("p", { class: "feed__detail" }, clean(detail)) : null));
  }

  function setPhase(type) {
    const phase = PHASE_OF[type];
    if (phase === undefined || phase <= state.phase) return;
    state.phase = phase;
    renderPhases();
  }

  function renderPhases() {
    dom.phases.forEach((node) => {
      const i = Number(node.dataset.phase);
      const mark = node.querySelector(".phase__mark");
      const status = state.done || i < state.phase ? "done" : i === state.phase ? "active" : "todo";
      if (node.dataset.state === status) return;
      node.dataset.state = status;
      node.setAttribute("aria-current", status === "active" ? "step" : "false");
      mark.replaceChildren(status === "done" ? icon("check", 3.2) : String(i + 1));
    });
  }

  const offerName = (offerId) => state.offers.get(offerId)?.manifest?.name ?? state.offerNames.get(offerId) ?? offerId;

  /* ---------- seller ---------- */

  function sellerEmptyCard() {
    return h("li", { class: "seller-empty" },
      h("p", { class: "seller-empty__title" }, "No seller run in this session yet."),
      h("p", {}, "The last recorded run: draft failed 1 test, fixed from the real pytest output, 25 agent tests and 17 hidden archival tests passed, network locked."));
  }

  function sellerActivity() {
    if (state.sellerSeen) return;
    state.sellerSeen = true;
    delete dom.sellerCol.dataset.empty;
    dom.sellerFeed.replaceChildren();
  }

  function sellerStep(ev, instant) {
    sellerActivity();
    setPill(dom.sellerPill, "Building", "work");
    const label = SELLER_STEPS[ev.step] ?? (/\s/.test(ev.step) ? ev.step : titleCase(ev.step));
    append(dom.sellerScroll, dom.sellerFeed, feedItem(ev, label, ev.detail), instant);
  }

  function sellerTest(ev, instant) {
    sellerActivity();
    const passed = Number(ev.passed) || 0;
    const failed = Number(ev.failed) || 0;
    state.tests.runs += 1;
    tween(dom.testPass, passed, instant);
    tween(dom.testFail, failed, instant);
    const total = passed + failed || 1;
    dom.barPass.style.width = `${(passed / total) * 100}%`;
    dom.barFail.style.width = `${(failed / total) * 100}%`;
    dom.tests.toggleAttribute("data-failing", failed > 0);
    dom.tests.dataset.runs = String(state.tests.runs);
    dom.testRuns.textContent = `run ${state.tests.runs}`;
    const line = h("p", { class: "feed__text" },
      h("span", {}, `Test run ${state.tests.runs}`),
      h("span", { class: "t-pass" }, `${passed} passed`),
      h("span", { class: failed ? "t-fail" : "t-zero" }, `${failed} failed`));
    append(dom.sellerScroll, dom.sellerFeed, feedItem(ev, line, ev.output ? summarize(ev.output, 140) : null, "test"), instant);
    announce(`Seller test run: ${passed} passed, ${failed} failed.`, instant);
  }

  function sellerPatch(ev, instant) {
    sellerActivity();
    const lines = String(ev.diff ?? "").replace(/\n$/, "").split("\n");
    let adds = 0;
    let dels = 0;
    const body = h("pre", { class: "diff__body", tabindex: "0", "aria-label": `Diff for ${clean(ev.file)}` });
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
      let kind = "ctx";
      let text = line;
      if (line.startsWith("@@")) kind = "hunk";
      else if (line.startsWith("+")) { kind = "add"; text = line.slice(1); adds++; }
      else if (line.startsWith("-")) { kind = "del"; text = line.slice(1); dels++; }
      else if (line.startsWith(" ")) text = line.slice(1);
      body.append(h("span", { class: `diff__line diff__line--${kind}` }, clean(text) || " "));
    }
    const diff = h("div", { class: "diff" },
      h("div", { class: "diff__head" },
        h("span", {}, clean(ev.file)),
        h("span", { class: "diff__stat" }, h("span", { class: "add" }, `+${adds}`), h("span", { class: "del" }, `−${dels}`))),
      body);
    const item = feedItem(ev, `Patched ${ev.file}`, ev.model ? `fix written by ${ev.model}` : null);
    item.append(diff);
    append(dom.sellerScroll, dom.sellerFeed, item, instant);
    announce(`Seller patched ${clean(ev.file)}.`, instant);
  }

  function sellerAttack(ev, instant) {
    sellerActivity();
    const status = ["blocked", "crashed", "passed"].includes(ev.status) ? ev.status : "passed";
    let node = state.attacks.get(ev.attack);
    const fresh = !node;
    if (fresh) {
      node = h("li", { class: "attack" });
      state.attacks.set(ev.attack, node);
    }
    node.dataset.status = status;
    node.title = clean(ev.detail ? `${ev.attack}: ${ev.detail}` : ev.attack);
    node.replaceChildren(
      h("span", { class: "attack__dot" }, icon(status === "blocked" ? "check" : "x", 3.2)),
      h("span", { class: "attack__name" }, clean(ev.attack)),
      h("span", { class: "attack__status" }, status));
    if (instant) node.classList.add("is-instant");
    if (fresh) dom.attacks.append(node);
    else if (!instant) {
      node.classList.remove("is-updated");
      void node.offsetWidth;
      node.classList.add("is-updated");
    }
    const all = [...state.attacks.values()];
    const blocked = all.filter((n) => n.dataset.status === "blocked").length;
    dom.attackSum.textContent = `${blocked}/${all.length} blocked`;
    announce(`Attack ${clean(ev.attack)}: ${status}.`, instant);
  }

  /* ---------- offers and trust checks ---------- */

  function renderOffersEmpty() {
    if (dom.offers.childElementCount) return;
    emptyOffersHint = h("div", { class: "offers-empty" },
      h("span", { class: "offers-empty__icon" }, icon("shield", 1.8)),
      h("p", { class: "offers-empty__title" }, "No offers yet"),
      h("p", {}, "Each offer the seller publishes gets checked here, claim by claim."),
      root.dataset.mode === "preview" ? null : h("a", { href: "?demo=1" }, "Watch a replay of a recorded run"));
    dom.offers.append(emptyOffersHint);
  }

  /** Adds or refreshes a card from a SignedManifest (or a bare OfferManifest). */
  function addOffer(signed, instant) {
    const manifest = signed?.manifest ?? signed;
    if (!manifest?.offerId) return;
    const offer = ensureOffer(manifest.offerId, instant);
    offer.manifest = manifest;
    offer.name.textContent = manifest.name || manifest.offerId;
    offer.meta.textContent = `${manifest.offerId} · ${usd(manifest.priceUsd ?? "0.50")}`;
    const egress = Array.isArray(manifest.egress) && manifest.egress.length ? manifest.egress.join(", ") : "open";
    offer.claims.replaceChildren(
      h("li", { class: "claim", title: `Claimed egress: ${egress}` }, h("span", {}, "egress"), egress),
      h("li", { class: "claim", title: `Parent sandbox: ${manifest.parentSandboxId}` }, h("span", {}, "parent"), manifest.parentSandboxId ?? ""),
      h("li", { class: "claim", title: `Tool digest: ${manifest.artifactDigest}` }, h("span", {}, "digest"), shortHash(manifest.artifactDigest)));
    renderTally();
  }

  function removeOffer(offerId) {
    const offer = state.offers.get(offerId);
    if (!offer) return;
    offer.card.remove();
    state.offers.delete(offerId);
    renderOffersEmpty();
    renderTally();
  }

  function freshRunState(offer) {
    offer.checkMap = new Map();
    offer.refused = null;
    offer.refusedAfterPayment = false;
    offer.payment = null;
    offer.done = false;
    offer.checking = false;
    offer.expanded = false;
  }

  function ensureOffer(offerId, instant) {
    let offer = state.offers.get(offerId);
    if (offer) return offer;
    emptyOffersHint?.remove();
    emptyOffersHint = null;
    const name = h("h3", { class: "offer__name" }, offerId);
    const meta = h("p", { class: "offer__meta" }, offerId);
    const verdictSlot = h("div", {});
    const claims = h("ul", { class: "offer__claims", "aria-label": "Signed claims" });
    const failed = h("ol", { class: "checks checks--failed", "aria-label": "Failed checks" });
    const toggle = h("button", { class: "checks-toggle", type: "button", "aria-expanded": "false" });
    const passed = h("ol", { class: "checks checks--passed", "aria-label": "Passed checks" });
    const footer = h("div", {});
    const card = h("article", { class: "offer", dataset: { state: "listed" } },
      h("header", { class: "offer__head" }, h("div", { class: "offer__id" }, name, meta), verdictSlot),
      claims, failed, toggle, passed, footer);
    offer = { id: offerId, card, name, meta, claims, failed, toggle, passed, verdictSlot, footer, verdict: null };
    freshRunState(offer);
    toggle.addEventListener("click", () => {
      offer.expanded = !offer.expanded;
      renderChecks(offer, true);
    });
    state.offers.set(offerId, offer);
    if (instant) card.classList.add("is-instant");
    dom.offers.append(card);
    renderChecks(offer, instant);
    renderVerdict(offer, instant);
    return offer;
  }

  function checkRow(check, instant) {
    const pass = check.status === "pass";
    const evidence = parseEvidence(check.detail);
    const body = h("div", {}, h("p", { class: "check__label" }, clean(check.label || check.id)));
    if (evidence) {
      if (evidence.note) body.append(h("p", { class: "check__detail" }, evidence.note));
      const dl = h("dl", { class: "evidence" });
      evidence.rows.forEach((row, i) => dl.append(h("dt", {}, row.label), h("dd", { class: i > 0 ? "is-observed" : "" }, row.value)));
      body.append(dl);
    } else if (check.detail) {
      body.append(h("p", { class: "check__detail" }, clean(check.detail)));
    }
    const item = h("li", { class: `check check--${pass ? "pass" : "fail"}` },
      h("span", { class: "check__icon", role: "img", "aria-label": pass ? "Passed" : "Failed" }, icon(pass ? "check" : "x", 3.2)),
      body);
    if (instant) item.classList.add("is-instant");
    return item;
  }

  function renderChecks(offer, instant) {
    const checks = [...offer.checkMap.values()];
    const passed = checks.filter((c) => c.status === "pass");
    const failed = checks.filter((c) => c.status !== "pass");
    offer.failed.replaceChildren(...failed.map((c) => checkRow(c, instant || c.rendered)));
    failed.forEach((c) => { c.rendered = true; });
    offer.failed.hidden = failed.length === 0;
    offer.toggle.hidden = passed.length === 0;
    offer.passed.hidden = !offer.expanded || passed.length === 0;
    offer.toggle.setAttribute("aria-expanded", String(offer.expanded));
    if (passed.length) {
      const latest = passed[passed.length - 1];
      offer.toggle.replaceChildren(...[
        h("span", { class: "checks-toggle__icon" }, icon("check", 3.2)),
        h("span", { class: "checks-toggle__text" },
          h("b", {}, `${passed.length} of ${checks.length}`), failed.length ? " passed" : " checks passed"),
        offer.checking && !offer.expanded ? h("span", { class: "checks-toggle__latest" }, clean(latest.label)) : null,
        h("span", { class: "checks-toggle__chev", "aria-hidden": "true" }, offer.expanded ? "▾" : "▸"),
      ].filter(Boolean));
      if (!instant) {
        offer.toggle.classList.remove("is-bumped");
        void offer.toggle.offsetWidth;
        offer.toggle.classList.add("is-bumped");
      }
    }
    if (offer.expanded) offer.passed.replaceChildren(...passed.map((c) => checkRow(c, true)));
  }

  function buyerCheck(ev, instant) {
    const offer = ensureOffer(ev.offerId, instant);
    const check = ev.check ?? {};
    state.activeOfferId = ev.offerId;
    offer.checking = !offer.payment;
    offer.checkMap.set(check.id || check.label, { ...check });
    renderChecks(offer, instant);
    renderVerdict(offer, instant);
    focusOffer(offer, instant);
    setPill(dom.buyerPill, "Verifying", "work");
    announce(`${check.status === "pass" ? "Check passed" : "Check failed"}: ${clean(check.label || check.id)}.`, instant);
  }

  function buyerRefused(ev, instant) {
    const offer = ensureOffer(ev.offerId, instant);
    const reason = String(ev.reason ?? "");
    const after = /^after payment/i.test(reason);
    offer.refused = clean(reason.replace(/^after payment,?\s*(document withheld)?\s*:?\s*/i, "")) || "A claim did not match CreateOS.";
    offer.refusedAfterPayment = after || Boolean(offer.payment);
    offer.checking = false;
    renderChecks(offer, instant);
    renderVerdict(offer, instant);
    focusOffer(offer, instant);
    const name = offerName(ev.offerId);
    const title = offer.refusedAfterPayment ? `Refused ${name} after payment, document withheld` : `Refused ${name}`;
    runAppend(ev, feedItem(ev, title, summarize(offer.refused, 140), "refused"), instant);
    announce(`${title}. ${offer.refused}`, instant);
  }

  const failedChecks = (offer) => [...offer.checkMap.values()].filter((c) => c.status !== "pass");

  function renderVerdict(offer, instant) {
    const fails = failedChecks(offer).length;
    const pay = offer.payment;
    let verdict;
    let band = null;
    if (offer.done) {
      verdict = "pass";
      band = { tone: "pass", title: "Paid · job done · receipt written", side: pay ? shortPi(pay.id) : "" };
    } else if (offer.refusedAfterPayment || (pay && fails)) {
      verdict = "fail";
      const money = pay?.refunded ? `${usd(pay.amount)} refunded (${shortPi(pay.id)})` : "refund requested";
      band = { tone: "fail", title: `Refused after payment · document withheld · ${money}`, reason: offer.refused };
    } else if (offer.refused && fails) {
      verdict = "fail";
      band = { tone: "fail", title: "Refused, no payment created", reason: offer.refused };
    } else if (offer.refused) {
      verdict = "neutral";
      band = { tone: "neutral", title: "Not bought, no payment created", reason: offer.refused };
    } else if (pay?.refunded) {
      verdict = "neutral";
      band = { tone: "neutral", title: `Paid, then ${usd(pay.amount)} refunded (${shortPi(pay.id)})`, reason: pay.reason };
    } else if (pay) {
      verdict = "pass";
      band = { tone: "pass", title: "Paid · job running", side: shortPi(pay.id) };
    } else if (fails) {
      verdict = "fail";
    } else if (offer.checkMap.size) {
      verdict = offer.checking ? "checking" : "pass";
    } else {
      verdict = "listed";
    }

    offer.card.dataset.state = verdict;
    if (offer.verdict !== verdict) {
      offer.verdict = verdict;
      const labels = { listed: "Listed", checking: "Checking", pass: "Pass", fail: "Fail", neutral: "Not bought" };
      const label = verdict === "neutral" && pay?.refunded && !offer.refused ? "Refunded" : labels[verdict];
      const badge = h("span", { class: `verdict verdict--${verdict}` },
        verdict === "pass" ? icon("check", 3) : verdict === "fail" ? icon("x", 3) : null, label);
      if (instant) badge.classList.add("is-instant");
      offer.verdictSlot.replaceChildren(badge);
    }

    const key = band ? `${band.tone}|${band.title}|${band.reason ?? ""}` : "";
    if (offer.footer.dataset.key !== key) {
      offer.footer.dataset.key = key;
      if (!band) offer.footer.replaceChildren();
      else if (band.tone === "pass") {
        offer.footer.replaceChildren(h("div", { class: `paid-band${instant ? " is-instant" : ""}` }, h("span", {}, band.title), h("span", {}, band.side ?? "")));
      } else {
        offer.footer.replaceChildren(h("div", { class: `refusal refusal--${band.tone}${instant ? " is-instant" : ""}`, role: "status" },
          icon(band.tone === "fail" ? "x" : "replay", 2.4),
          h("div", {},
            h("p", { class: "refusal__title" }, band.title),
            band.reason ? h("p", { class: "refusal__reason" }, summarize(band.reason.split("; ")[0], 160)) : null)));
      }
    }
    renderTally();
  }

  const shortPi = (id) => (id && id.length > 16 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id ?? "");

  function renderTally() {
    const offers = [...state.offers.values()];
    const paid = offers.filter((o) => o.done || (o.payment && !o.payment.refunded && !o.refusedAfterPayment)).length;
    const before = offers.filter((o) => o.refused && !o.payment && failedChecks(o).length).length;
    const refunded = offers.filter((o) => o.payment?.refunded).length;
    const parts = [
      paid && { tone: "pass", text: `${paid} paid` },
      before && { tone: "fail", text: `${before} refused before paying` },
      refunded && { tone: "warn", text: `${refunded} refunded` },
    ].filter(Boolean);
    dom.tally.replaceChildren(...parts.map((p) => h("li", { class: `tally__item tally__item--${p.tone}` }, p.text)));
    const checking = offers.some((o) => o.verdict === "checking");
    if (checking) setPill(dom.trustPill, "Checking", "work");
    else if (parts.length) setPill(dom.trustPill, "Checked", paid ? "pass" : "fail");
    else setPill(dom.trustPill, offers.length ? `${offers.length} listed` : "Idle");
  }

  function focusOffer(offer, instant) {
    // Wait a frame so new rows have their final height. The scroller is the card's offset parent.
    requestAnimationFrame(() => {
      const scroller = dom.offersScroll;
      if (scroller.scrollHeight <= scroller.clientHeight) return;
      const top = offer.card.offsetTop - 12;
      const showBottom = offer.card.offsetTop + offer.card.offsetHeight + 12 - scroller.clientHeight;
      // Keep the newest row in view; keep the card's header in view too when it fits.
      const target = showBottom > top ? showBottom : Math.min(Math.max(scroller.scrollTop, showBottom), top);
      if (Math.abs(target - scroller.scrollTop) > 2) scrollTo(scroller, Math.max(0, target), instant);
    });
  }

  /* ---------- buyer runs ---------- */

  function currentRun(ev) {
    return state.runs[state.runs.length - 1] ?? startRun(ev, null);
  }

  function startRun(ev, detail) {
    const previous = state.runs[state.runs.length - 1];
    if (previous) {
      previous.details.open = false;
      renderRunSummary(previous);
    } else {
      dom.runs.replaceChildren();
    }
    const list = h("ol", { class: "feed" });
    const summary = h("summary", { class: "run__summary" });
    const details = h("details", { class: "run", open: true }, summary, list);
    const run = { n: state.runs.length + 1, ts: ev.ts, file: detail ? clean(String(detail).split(" · ")[0]) : "", details, summary, list, failLine: null, failures: 0, failReason: "", attemptStart: null, awaiting: [], payments: [], done: false };
    state.runs.push(run);
    renderRunSummary(run);
    dom.runs.append(details);

    // Offer cards, payments and the buyer badge describe the latest run only.
    for (const offer of state.offers.values()) {
      freshRunState(offer);
      renderChecks(offer, true);
      renderVerdict(offer, true);
    }
    state.activeOfferId = null;
    state.payingOfferId = null;
    state.payments = [];
    renderPayments(true);
    // The phase strip follows the latest run: creation is behind us, the doubting starts again.
    state.done = false;
    state.phase = 1;
    renderPhases();
    return run;
  }

  function runOutcome(run) {
    if (run.done) {
      const refunds = run.payments.filter((p) => p.refunded).length;
      return `receipt written${refunds ? `, ${refunds} refunded` : ""}`;
    }
    if (run.failures) {
      const refunded = run.payments.some((p) => p.refunded);
      return `earlier attempt failed: ${run.failReason}${refunded ? ", refunded" : ""}`;
    }
    if (run.awaiting.length) return "waiting for approval in the Link app";
    return run.details.open ? "in progress" : "no purchase";
  }

  function renderRunSummary(run) {
    run.summary.replaceChildren(
      h("span", { class: "run__chev", "aria-hidden": "true" }),
      h("span", { class: "run__name" }, `Run ${run.n}`),
      h("span", { class: "run__time" }, hhmm(run.ts)),
      h("span", { class: "run__outcome" }, run.details.open && !run.done ? run.file || "in progress" : runOutcome(run)));
    run.details.dataset.outcome = run.done ? "done" : run.failures ? "failed" : "open";
  }

  function runAppend(ev, node, instant) {
    const run = currentRun(ev);
    append(dom.buyerScroll, run.list, node, instant);
    return node;
  }

  function parseOfferDetail(detail) {
    const [offerId, name, price] = String(detail ?? "").split(" · ");
    return { offerId, name: name ?? offerId, price };
  }

  function buyerStep(ev, instant) {
    const step = String(ev.step ?? "");
    const detail = ev.detail ?? "";
    if (step === "start") {
      const run = startRun(ev, detail);
      setPill(dom.buyerPill, "Working", "work");
      const parts = String(detail).split(" · ").filter((p) => !p.startsWith("gateway "));
      append(dom.buyerScroll, run.list, feedItem(ev, "Run started", parts.join(" · ")), instant);
      follow(dom.buyerScroll, instant);
      announce("Buyer run started.", instant);
      return;
    }
    const run = currentRun(ev);
    if (FAILURE_STEPS.has(step)) return attemptFailed(ev, run, instant);

    if (!run.done && step !== "awaiting-approval") setPill(dom.buyerPill, state.payments.some((p) => !p.refunded) ? "Paid" : "Working", "work");
    let text;
    let sub = detail;
    let variant;
    switch (step) {
      case "discover": text = "Reading the gateway's llms.txt, OpenAPI and offers"; sub = ""; break;
      case "discovered": text = "Found the gateway"; break;
      case "verify-offer": {
        const { offerId, name, price } = parseOfferDetail(detail);
        if (name) state.offerNames.set(offerId, name);
        stopChecking();
        const offer = ensureOffer(offerId, instant);
        offer.checking = true;
        if (!offer.manifest && name) offer.name.textContent = name;
        renderVerdict(offer, instant);
        text = `Checking ${name}`;
        sub = [offerId, price].filter(Boolean).join(" · ");
        break;
      }
      case "pay": {
        const m = String(detail).match(/^(\$[\d.]+) for (\S+)(?: via (.+))?$/);
        if (m) state.payingOfferId = m[2];
        stopChecking();
        text = m ? `Paying ${m[1]} for ${offerName(m[2])}` : "Paying";
        sub = m?.[3] ? `via ${m[3]}` : detail;
        break;
      }
      case "awaiting-approval": {
        text = "Waiting for approval in the Link app";
        const id = String(detail).match(/lsrq_\w+/)?.[0];
        sub = id ? `spend request ${id}` : "";
        variant = "waiting";
        setPill(dom.buyerPill, "Awaiting approval", "work");
        break;
      }
      case "paid": text = "Paid, worker ready"; removeAwaiting(run); break;
      case "verify-worker": text = "Checking the worker before uploading"; break;
      case "upload": text = "Uploaded the document"; break;
      case "convert": text = "Converting in the worker"; break;
      case "downloaded": text = "Downloaded the PDF"; variant = "good"; break;
      case "refund-requested": text = "Refund requested"; sub = summarize(detail.split(" · ").slice(1).join(" · ") || detail, 120); break;
      case "released": text = "Worker released"; break;
      default: text = /\s/.test(step) ? step : titleCase(step);
    }
    const item = feedItem(ev, text, sub, variant);
    if (step === "pay") run.attemptStart = item;
    if (step === "awaiting-approval") run.awaiting.push(item);
    runAppend(ev, item, instant);
    renderRunSummary(run);
  }

  function stopChecking() {
    for (const offer of state.offers.values()) {
      if (!offer.checking) continue;
      offer.checking = false;
      renderChecks(offer, true);
      renderVerdict(offer, true);
    }
  }

  // One grey line per run stands in for every failed attempt and the raw output behind it.
  function attemptFailed(ev, run, instant) {
    const step = String(ev.step);
    if (step !== "no-purchase" && step !== "no-offers") {
      const detail = String(ev.detail ?? "");
      const reason = summarize(detail.includes(" · ") ? detail.split(" · ").slice(1).join(" · ") : detail, 90);
      run.failures += 1;
      run.failReason = reason;
      // Drop the lines of the attempt that failed (its pay step and anything after it).
      if (run.attemptStart?.isConnected) {
        let node = run.attemptStart;
        while (node) {
          const next = node.nextSibling;
          if (node !== run.failLine) node.remove();
          node = next;
        }
      }
      run.attemptStart = null;
      run.awaiting = run.awaiting.filter((n) => n.isConnected);
    } else if (!run.failures) {
      run.failReason = step === "no-offers" ? "no usable offers listed" : "no offer passed every check";
    }
    const refunded = run.payments.some((p) => p.refunded);
    const text = run.failures
      ? `${run.failures > 1 ? `${run.failures} attempts failed` : "Attempt failed"}: ${run.failReason}${refunded ? ", refunded" : ""}`
      : `No purchase: ${run.failReason}`;
    if (!run.failLine) {
      run.failLine = h("li", { class: "feed__item feed__item--muted" },
        h("time", { class: "feed__time", datetime: ev.ts }, clock(ev.ts)),
        h("div", {}, h("p", { class: "feed__text" })));
    }
    run.failLine.querySelector(".feed__text").textContent = text;
    if (run.failLine.parentNode !== run.list || run.list.lastChild !== run.failLine) runAppend(ev, run.failLine, instant);
    if (!run.done) setPill(dom.buyerPill, "No purchase");
    renderRunSummary(run);
  }

  function removeAwaiting(run) {
    run.awaiting.forEach((node) => node.remove());
    run.awaiting = [];
  }

  /* ---------- payments and workers ---------- */

  function renderPayments(instant) {
    if (!state.payments.length) {
      dom.pay.dataset.state = "empty";
      dom.payNote.textContent = "none yet";
      dom.payBody.replaceChildren(h("p", { class: "pay__empty" }, "Nothing is paid until every check passes."));
      return;
    }
    dom.pay.dataset.state = state.payments.some((p) => !p.refunded) ? "paid" : "refunded";
    dom.payNote.textContent = "Stripe test mode";
    dom.payBody.replaceChildren(...state.payments.map((p) => {
      const row = h("div", { class: `pay__row${p.refunded ? " is-refunded" : ""}${instant || p.rendered ? " is-instant" : ""}` },
        h("div", { class: "pay__amount" },
          h("b", {}, usd(p.amount)),
          h("span", { class: `pay__status pay__status--${p.refunded ? "refunded" : "paid"}` }, p.refunded ? "Refunded" : "Paid"),
          h("span", { class: "pay__for" }, offerName(p.offerId) ?? "")),
        h("a", { class: "pay__pi", href: STRIPE_PAYMENT_URL + encodeURIComponent(p.id), target: "_blank", rel: "noopener", title: "Open in the Stripe dashboard" },
          p.id, icon("arrow", 2)));
      p.rendered = true;
      return row;
    }));
  }

  function paymentCreated(ev, instant) {
    const run = currentRun(ev);
    // Payments carry no offer id; they belong to the offer named in the last "pay" step.
    const offerId = state.payingOfferId ?? state.activeOfferId;
    const payment = { id: ev.paymentIntentId, amount: ev.amountUsd, offerId, refunded: false, reason: "" };
    state.payments.push(payment);
    run.payments.push(payment);
    renderPayments(instant);
    setPill(dom.buyerPill, "Paid", "pass");
    const offer = offerId && state.offers.get(offerId);
    if (offer) {
      offer.payment = payment;
      offer.checking = false;
      renderVerdict(offer, instant);
    }
    runAppend(ev, feedItem(ev, `Paid ${usd(ev.amountUsd)} with Stripe`, ev.paymentIntentId, "good"), instant);
    announce(`Payment created: ${usd(ev.amountUsd)}.`, instant);
  }

  function paymentRefunded(ev, instant) {
    const payment = state.payments.find((p) => p.id === ev.paymentIntentId)
      ?? state.runs.flatMap((r) => r.payments).find((p) => p.id === ev.paymentIntentId);
    if (payment) {
      payment.refunded = true;
      payment.reason = clean(ev.reason ?? "");
      const offer = state.offers.get(payment.offerId);
      if (offer?.payment === payment) renderVerdict(offer, instant);
    }
    renderPayments(instant);
    runAppend(ev, feedItem(ev, `Refunded ${payment ? usd(payment.amount) : ""}`.trim(), summarize(ev.reason ?? "", 120), "refund"), instant);
    announce("Payment refunded.", instant);
  }

  function setVm(count, instant) {
    const next = Math.max(0, count);
    const prev = state.vm;
    state.vm = next;
    dom.vm.dataset.state = next > 0 ? "1" : "0";
    dom.vmDigit.setAttribute("aria-label", `Workers running: ${next}`);
    if (instant || reducedMotion.matches || prev === next) {
      dom.vmDigit.replaceChildren(h("span", { class: "vm__num" }, String(next)));
      return;
    }
    const dir = next > prev ? "up" : "down";
    dom.vmDigit.querySelectorAll(".vm__num").forEach((old) => {
      old.className = `vm__num out-${dir}`;
      old.addEventListener("animationend", () => old.remove(), { once: true });
      setTimeout(() => old.remove(), 600);
    });
    dom.vmDigit.append(h("span", { class: `vm__num in-${dir}` }, String(next)));
  }

  function workerForked(ev, instant) {
    setVm(state.vm + 1, instant);
    const mode = ev.mode ? ` · ${ev.mode}` : "";
    dom.vmMeta.replaceChildren("forked in ", h("b", {}, `${Number(ev.ms).toLocaleString("en-US")} ms`), mode, h("br"), ev.workerSandboxId);
    dom.vmMeta.title = `Worker ${ev.workerSandboxId}, forked from ${ev.parentSandboxId}`;
    setPill(dom.buyerPill, "Running", "work");
    runAppend(ev, feedItem(ev, "Worker forked from the signed parent", `${ev.workerSandboxId} ← ${ev.parentSandboxId}`), instant);
    announce(`Worker forked in ${ev.ms} milliseconds.`, instant);
  }

  function workerDestroyed(ev, instant) {
    setVm(state.vm - 1, instant);
    dom.vmMeta.replaceChildren("destroyed after the job", h("br"), ev.workerSandboxId);
    runAppend(ev, feedItem(ev, "Worker destroyed", ev.workerSandboxId), instant);
    announce("Worker destroyed.", instant);
  }

  function jobCompleted(ev, instant) {
    const receipt = ev.receipt;
    if (!receipt) return;
    const run = currentRun(ev);
    run.done = true;
    removeAwaiting(run);
    if (run.failLine) { run.failLine.remove(); run.failLine = null; }
    state.done = true;
    renderPhases();
    const offer = state.offers.get(receipt.offerId);
    if (offer) {
      offer.done = true;
      offer.checking = false;
      renderChecks(offer, instant);
      renderVerdict(offer, instant);
    }
    setPill(dom.buyerPill, "Done", "pass");
    runAppend(ev, h("li", { class: "feed__item feed__item--wide feed__item--receipt" }, renderReceipt(receipt)), instant);
    renderRunSummary(run);
    announce("Job completed. Receipt written.", instant);
    onReceipt?.(receipt);
  }

  /* ---------- public ---------- */

  const handlers = {
    "seller.step": sellerStep,
    "seller.test": sellerTest,
    "seller.patch": sellerPatch,
    "seller.attack": sellerAttack,
    "offer.published": (ev, instant) => {
      addOffer(ev.offer, instant);
      if (state.sellerSeen) setPill(dom.sellerPill, "Published", "pass");
      announce(`Offer published: ${ev.offer?.manifest?.name ?? "new offer"}.`, instant);
    },
    "offer.removed": (ev) => removeOffer(ev.offerId),
    "buyer.step": buyerStep,
    "buyer.check": buyerCheck,
    "buyer.refused": buyerRefused,
    "payment.created": paymentCreated,
    "payment.refunded": paymentRefunded,
    "worker.forked": workerForked,
    "worker.destroyed": workerDestroyed,
    "job.completed": jobCompleted,
  };

  function apply(ev, { instant = false } = {}) {
    const handler = handlers[ev?.type];
    if (!handler) return;
    setPhase(ev.type);
    handler(ev, instant);
  }

  function setConnection(stateName) {
    const labels = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Gateway offline", preview: "Replay of a recorded run" };
    dom.conn.dataset.state = stateName;
    dom.conn.textContent = labels[stateName] ?? stateName;
  }

  reset();
  return { apply, addOffer: (signed, opts = {}) => addOffer(signed, opts.instant ?? true), reset, setConnection };
}
