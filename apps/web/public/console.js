// Renders PolygraphEvents into the three-column live console.
// All event data is untrusted network input, so text only ever goes in via textContent.

const STRIPE_PAYMENT_URL = "https://dashboard.stripe.com/test/payments/";
const PHASE_OF = {
  "seller.step": 0, "seller.test": 0, "seller.patch": 0, "seller.attack": 0, "offer.published": 0,
  "buyer.step": 1, "buyer.check": 1, "buyer.refused": 1,
  "payment.created": 2,
  "worker.forked": 3, "worker.destroyed": 3, "job.completed": 3,
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

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
const shortId = (id, head = 10, tail = 4) =>
  typeof id === "string" && id.length > head + tail + 1 ? `${id.slice(0, head)}…${tail ? id.slice(-tail) : ""}` : String(id ?? "");
const usd = (amount) => {
  const n = Number(amount);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : `$${amount}`;
};

/**
 * Splits a check detail of the form "claimed: X · platform: Y" (separator may also be ";" or "|")
 * into its two sides so the card can show them as evidence rows.
 */
export function parseEvidence(detail) {
  if (typeof detail !== "string") return null;
  const m = detail.match(/claimed\s*[:=]\s*(.+?)\s*(?:·|;|\|)\s*platform\s*[:=]\s*(.+)$/i);
  return m ? { claimed: m[1], platform: m[2] } : null;
}

/** Builds the receipt card. `light` switches to the page palette for the receipts section. */
export function renderReceipt(receipt, { light = false } = {}) {
  const verification = Array.isArray(receipt.verification) ? receipt.verification : [];
  const passed = verification.filter((c) => c.status === "pass").length;
  const piLink = h("a", { href: STRIPE_PAYMENT_URL + encodeURIComponent(receipt.paymentIntentId), target: "_blank", rel: "noopener" }, receipt.paymentIntentId);
  const completed = new Date(receipt.completedAt);
  const rows = [
    ["Purchase", receipt.purchaseId],
    ["Offer", receipt.offerId],
    ["PaymentIntent", piLink],
    ["Parent sandbox", receipt.parentSandboxId],
    ["Worker", receipt.workerSandboxId],
    ["Tool digest", receipt.artifactDigest],
    ["Input sha256", receipt.inputSha256],
    ["Output sha256", receipt.outputSha256],
    ["Verification", verification.length ? h("span", { class: passed === verification.length ? "ok" : "" }, `${passed} of ${verification.length} checks passed`) : "none recorded"],
    ["Completed", receipt.completedAt],
  ];
  return h("article", { class: `receipt${light ? " receipt--light" : ""}`, "aria-label": "Receipt" },
    h("header", { class: "receipt__head" },
      h("span", { class: "receipt__seal" }, icon("check", 3)),
      h("div", {},
        h("p", { class: "receipt__title" }, "Receipt"),
        h("p", { class: "receipt__sub" }, Number.isNaN(completed.getTime()) ? "Job completed" : `Job completed at ${completed.toLocaleTimeString("en-GB", { hour12: false })}`)),
    ),
    h("dl", { class: "receipt__rows" },
      rows.map(([label, value]) => h("div", { class: "receipt__row" }, h("dt", {}, label), h("dd", {}, value ?? "")))),
  );
}

export function createConsole(root, { onReceipt } = {}) {
  const el = (name) => root.querySelector(`[data-el="${name}"]`);
  const dom = {
    conn: el("conn"), live: el("live"),
    phases: [...root.querySelectorAll("[data-phase]")],
    sellerPill: el("seller-pill"), trustPill: el("trust-pill"), buyerPill: el("buyer-pill"),
    tests: el("tests"), testPass: el("test-pass"), testFail: el("test-fail"), testRuns: el("test-runs"),
    barPass: el("test-bar-pass"), barFail: el("test-bar-fail"),
    attacks: el("attacks"), attackSum: el("attack-sum"),
    sellerFeed: el("seller-feed"), sellerScroll: el("seller-scroll"),
    offers: el("offers"), offersScroll: el("offers-scroll"),
    pay: el("pay"), payBody: el("pay-body"), payNote: el("pay-note"),
    vm: el("vm"), vmDigit: el("vm-digit"), vmMeta: el("vm-meta"),
    buyerFeed: el("buyer-feed"), buyerScroll: el("buyer-scroll"),
  };
  dom.sellerFeed.dataset.empty = "Waiting for the seller agent to start.";
  dom.buyerFeed.dataset.empty = "Waiting for the buyer agent to start.";

  let state;
  let emptyOffersHint = null;

  function reset() {
    state = {
      phase: -1, done: false,
      tests: { passed: 0, failed: 0, runs: 0 },
      attacks: new Map(),
      offers: new Map(),
      activeOfferId: null,
      payment: null,
      vm: 0,
    };
    dom.sellerFeed.replaceChildren();
    dom.buyerFeed.replaceChildren();
    dom.attacks.replaceChildren();
    dom.offers.replaceChildren();
    dom.attackSum.textContent = "";
    dom.testPass.textContent = "0";
    dom.testFail.textContent = "0";
    dom.testRuns.textContent = "no runs yet";
    dom.barPass.style.width = "0";
    dom.barFail.style.width = "0";
    delete dom.tests.dataset.failing;
    delete dom.tests.dataset.runs;
    dom.pay.dataset.state = "empty";
    dom.payNote.textContent = "none yet";
    dom.payBody.replaceChildren(h("p", { class: "pay__empty" }, "Nothing is paid until every check passes."));
    dom.vm.dataset.state = "0";
    dom.vmDigit.replaceChildren(h("span", { class: "vm__num" }, "0"));
    dom.vmDigit.setAttribute("aria-label", "Workers running: 0");
    dom.vmMeta.textContent = "No worker forked yet";
    setPill(dom.sellerPill, "Waiting");
    setPill(dom.trustPill, "Idle");
    setPill(dom.buyerPill, "Waiting");
    renderPhases();
    renderOffersEmpty();
  }

  /* ---------- helpers ---------- */

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

  function append(scroller, list, node, instant) {
    if (instant) node.classList.add("is-instant");
    list.append(node);
    if (following.get(scroller)) scrollTo(scroller, scroller.scrollHeight, instant);
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
        text instanceof Node ? text : h("p", { class: "feed__text" }, text),
        detail ? h("p", { class: "feed__detail" }, detail) : null));
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

  /* ---------- seller ---------- */

  function sellerStep(ev, instant) {
    setPill(dom.sellerPill, "Building", "work");
    append(dom.sellerScroll, dom.sellerFeed, feedItem(ev, ev.step, ev.detail), instant);
  }

  function sellerTest(ev, instant) {
    const passed = Number(ev.passed) || 0;
    const failed = Number(ev.failed) || 0;
    state.tests = { passed, failed, runs: state.tests.runs + 1 };
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
    append(dom.sellerScroll, dom.sellerFeed, feedItem(ev, line, ev.output, "test"), instant);
    announce(`Seller test run: ${passed} passed, ${failed} failed.`, instant);
  }

  function sellerPatch(ev, instant) {
    const lines = String(ev.diff ?? "").replace(/\n$/, "").split("\n");
    let adds = 0;
    let dels = 0;
    const body = h("pre", { class: "diff__body", tabindex: "0", "aria-label": `Diff for ${ev.file}` });
    for (const line of lines) {
      if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) continue;
      let kind = "ctx";
      let text = line;
      if (line.startsWith("@@")) kind = "hunk";
      else if (line.startsWith("+")) { kind = "add"; text = line.slice(1); adds++; }
      else if (line.startsWith("-")) { kind = "del"; text = line.slice(1); dels++; }
      else if (line.startsWith(" ")) text = line.slice(1);
      body.append(h("span", { class: `diff__line diff__line--${kind}` }, text || " "));
    }
    const diff = h("div", { class: "diff" },
      h("div", { class: "diff__head" },
        h("span", {}, ev.file),
        h("span", { class: "diff__stat" }, h("span", { class: "add" }, `+${adds}`), h("span", { class: "del" }, `−${dels}`))),
      body);
    const item = feedItem(ev, `Patched ${ev.file}`, null);
    item.append(diff);
    append(dom.sellerScroll, dom.sellerFeed, item, instant);
    announce(`Seller patched ${ev.file}.`, instant);
  }

  function sellerAttack(ev, instant) {
    const status = ["blocked", "crashed", "passed"].includes(ev.status) ? ev.status : "passed";
    let node = state.attacks.get(ev.attack);
    const fresh = !node;
    if (fresh) {
      node = h("li", { class: "attack" });
      state.attacks.set(ev.attack, node);
    }
    node.dataset.status = status;
    node.title = ev.detail ? `${ev.attack}: ${ev.detail}` : ev.attack;
    node.replaceChildren(
      h("span", { class: "attack__dot" }, icon(status === "blocked" ? "check" : "x", 3.2)),
      h("span", { class: "attack__name" }, ev.attack),
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
    announce(`Attack ${ev.attack}: ${status}.`, instant);
  }

  /* ---------- offers and trust checks ---------- */

  function renderOffersEmpty() {
    if (dom.offers.childElementCount) return;
    emptyOffersHint = h("div", { class: "offers-empty" },
      h("span", { class: "offers-empty__icon" }, icon("shield", 1.8)),
      h("p", { class: "offers-empty__title" }, "No offers yet"),
      h("p", {}, "Each offer the seller publishes gets checked here, claim by claim."),
      root.dataset.mode === "preview" ? null : h("a", { href: "?demo=1" }, "Preview with sample data"));
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
      h("li", { class: "claim", title: `Parent sandbox: ${manifest.parentSandboxId}` }, h("span", {}, "parent"), shortId(manifest.parentSandboxId, 16, 0)),
      h("li", { class: "claim", title: `Tool digest: ${manifest.artifactDigest}` }, h("span", {}, "digest"), shortId(manifest.artifactDigest, 8, 4)));
  }

  function ensureOffer(offerId, instant) {
    let offer = state.offers.get(offerId);
    if (offer) return offer;
    emptyOffersHint?.remove();
    emptyOffersHint = null;
    const name = h("h3", { class: "offer__name" }, offerId);
    const meta = h("p", { class: "offer__meta" }, offerId);
    const verdictSlot = h("div", {});
    const claims = h("ul", { class: "offer__claims", "aria-label": "Seller claims" });
    const checks = h("ol", { class: "checks", "aria-label": "Checks" });
    const footer = h("div", {});
    const card = h("article", { class: "offer", dataset: { state: "listed" } },
      h("header", { class: "offer__head" }, h("div", { class: "offer__id" }, name, meta), verdictSlot),
      claims, checks, footer);
    checks.hidden = true;
    offer = { id: offerId, card, name, meta, claims, checks, verdictSlot, footer, checkMap: new Map(), refused: null, paid: false, done: false, verdict: null };
    state.offers.set(offerId, offer);
    if (instant) card.classList.add("is-instant");
    dom.offers.append(card);
    renderVerdict(offer, instant);
    return offer;
  }

  function buyerCheck(ev, instant) {
    const offer = ensureOffer(ev.offerId, instant);
    const check = ev.check ?? {};
    state.activeOfferId = ev.offerId;
    const pass = check.status === "pass";
    const evidence = parseEvidence(check.detail);
    const body = h("div", {}, h("p", { class: "check__label" }, check.label || check.id));
    if (evidence) {
      body.append(h("dl", { class: "evidence" },
        h("dt", {}, "claimed"), h("dd", {}, evidence.claimed),
        h("dt", {}, "platform"), h("dd", { class: "is-platform" }, evidence.platform)));
    } else if (check.detail) {
      body.append(h("p", { class: "check__detail" }, check.detail));
    }
    const item = h("li", { class: `check check--${pass ? "pass" : "fail"}` },
      h("span", { class: "check__icon", role: "img", "aria-label": pass ? "Passed" : "Failed" }, icon(pass ? "check" : "x", 3.2)),
      body);
    if (instant) item.classList.add("is-instant");
    const key = check.id || check.label;
    const previous = offer.checkMap.get(key);
    if (previous) previous.replaceWith(item);
    else offer.checks.append(item);
    offer.checkMap.set(key, item);
    offer.checks.hidden = false;
    renderVerdict(offer, instant);
    focusOffer(offer, instant);
    setPill(dom.buyerPill, "Verifying", "work");
    announce(`${pass ? "Check passed" : "Check failed"}: ${check.label || check.id}.`, instant);
  }

  function buyerRefused(ev, instant) {
    const offer = ensureOffer(ev.offerId, instant);
    offer.refused = ev.reason || "A claim did not match the platform.";
    renderVerdict(offer, instant);
    focusOffer(offer, instant);
    const title = offer.paid ? "Refused after payment, refund requested" : "Refused, no payment created";
    append(dom.buyerScroll, dom.buyerFeed, feedItem(ev, `Refused ${offer.manifest?.name ?? ev.offerId}`, offer.refused, "refused"), instant);
    announce(`${offer.manifest?.name ?? "Offer"}: ${title}. ${offer.refused}`, instant);
  }

  function hasFail(offer) {
    return [...offer.checkMap.values()].some((n) => n.classList.contains("check--fail"));
  }

  function renderVerdict(offer, instant) {
    let verdict;
    if (offer.refused || hasFail(offer)) verdict = "fail";
    else if (offer.paid) verdict = "pass";
    else if (offer.checkMap.size) verdict = "checking";
    else verdict = "listed";

    offer.card.dataset.state = verdict;
    if (offer.verdict !== verdict) {
      offer.verdict = verdict;
      const labels = { listed: "Listed", checking: "Checking", pass: "Pass", fail: "Fail" };
      const badge = h("span", { class: `verdict verdict--${verdict}` },
        verdict === "pass" ? icon("check", 3) : verdict === "fail" ? icon("x", 3) : null, labels[verdict]);
      if (instant) badge.classList.add("is-instant");
      offer.verdictSlot.replaceChildren(badge);
    }

    const footer = [];
    if (offer.refused) {
      footer.push(h("div", { class: "refusal", role: "status" },
        icon("x", 2.4),
        h("div", {},
          h("p", { class: "refusal__title" }, offer.paid ? "Refused after payment, refund requested" : "Refused, no payment created"),
          h("p", { class: "refusal__reason" }, offer.refused))));
    } else if (offer.paid) {
      footer.push(h("div", { class: "paid-band" },
        h("span", {}, offer.done ? "Paid, job done, receipt written" : "Paid, job running"),
        h("span", {}, state.payment ? shortId(state.payment.id, 12, 4) : "")));
    }
    if (footer.length || offer.footer.childElementCount) {
      const same = offer.footer.firstChild?.textContent === footer[0]?.textContent;
      if (!same) {
        if (instant) footer.forEach((n) => n.classList.add("is-instant"));
        offer.footer.replaceChildren(...footer);
      }
    }
    renderTrustPill();
  }

  function renderTrustPill() {
    const offers = [...state.offers.values()];
    const failed = offers.filter((o) => o.verdict === "fail").length;
    const passed = offers.filter((o) => o.verdict === "pass").length;
    const checking = offers.some((o) => o.verdict === "checking");
    if (checking) setPill(dom.trustPill, "Checking", "work");
    else if (passed) setPill(dom.trustPill, `${passed} passed · ${failed} refused`, "pass");
    else if (failed) setPill(dom.trustPill, `${failed} refused`, "fail");
    else setPill(dom.trustPill, offers.length ? `${offers.length} listed` : "Idle");
  }

  function focusOffer(offer, instant) {
    // Wait a frame so new rows have their final height. The scroller is the card's offset parent.
    requestAnimationFrame(() => {
      const scroller = dom.offersScroll;
      if (scroller.scrollHeight <= scroller.clientHeight) return;
      const top = offer.card.offsetTop - 12;
      const showBottom = offer.card.offsetTop + offer.card.offsetHeight + 12 - scroller.clientHeight;
      // Keep the newest check in view; keep the card's header in view too when it fits.
      const target = showBottom > top ? showBottom : Math.min(Math.max(scroller.scrollTop, showBottom), top);
      if (Math.abs(target - scroller.scrollTop) > 2) scrollTo(scroller, Math.max(0, target), instant);
    });
  }

  /* ---------- buyer ---------- */

  function buyerStep(ev, instant) {
    if (!state.payment) setPill(dom.buyerPill, "Working", "work");
    append(dom.buyerScroll, dom.buyerFeed, feedItem(ev, ev.step, ev.detail), instant);
  }

  function paymentCreated(ev, instant) {
    state.payment = { id: ev.paymentIntentId, amount: ev.amountUsd };
    dom.pay.dataset.state = "paid";
    dom.payNote.textContent = "Stripe test mode";
    const link = h("a", { class: "pay__pi", href: STRIPE_PAYMENT_URL + encodeURIComponent(ev.paymentIntentId), target: "_blank", rel: "noopener", title: "Open in the Stripe dashboard" },
      ev.paymentIntentId, icon("arrow", 2));
    const amount = h("div", { class: "pay__amount" }, h("b", {}, usd(ev.amountUsd)), h("span", {}, "PaymentIntent"));
    if (instant) amount.classList.add("is-instant");
    dom.payBody.replaceChildren(amount, link);
    setPill(dom.buyerPill, "Paid", "pass");

    // Payments carry no offer id; they follow the offer the buyer was just checking.
    const offer = state.activeOfferId && state.offers.get(state.activeOfferId);
    if (offer && !offer.refused) {
      offer.paid = true;
      renderVerdict(offer, instant);
    }
    append(dom.buyerScroll, dom.buyerFeed, feedItem(ev, `Paid ${usd(ev.amountUsd)} with Stripe`, ev.paymentIntentId, "good"), instant);
    announce(`Payment created: ${usd(ev.amountUsd)}, PaymentIntent ${ev.paymentIntentId}.`, instant);
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
    const old = dom.vmDigit.querySelector(".vm__num:last-child");
    const incoming = h("span", { class: `vm__num in-${dir}` }, String(next));
    if (old) {
      old.className = `vm__num out-${dir}`;
      old.addEventListener("animationend", () => old.remove(), { once: true });
    }
    dom.vmDigit.append(incoming);
  }

  function workerForked(ev, instant) {
    setVm(state.vm + 1, instant);
    dom.vmMeta.replaceChildren(
      "forked in ", h("b", {}, `${Number(ev.ms).toLocaleString("en-US")} ms`), h("br"), shortId(ev.workerSandboxId, 18, 0));
    dom.vmMeta.title = `Worker ${ev.workerSandboxId}, forked from ${ev.parentSandboxId}`;
    setPill(dom.buyerPill, "Running", "work");
    append(dom.buyerScroll, dom.buyerFeed,
      feedItem(ev, "Worker forked from the checked parent", `${ev.workerSandboxId} ← ${ev.parentSandboxId}`), instant);
    announce(`Worker forked in ${ev.ms} milliseconds.`, instant);
  }

  function workerDestroyed(ev, instant) {
    setVm(state.vm - 1, instant);
    dom.vmMeta.replaceChildren("destroyed after the job", h("br"), shortId(ev.workerSandboxId, 18, 0));
    append(dom.buyerScroll, dom.buyerFeed, feedItem(ev, "Worker destroyed", ev.workerSandboxId), instant);
    announce("Worker destroyed.", instant);
  }

  function jobCompleted(ev, instant) {
    const receipt = ev.receipt;
    if (!receipt) return;
    state.done = true;
    renderPhases();
    const offer = state.offers.get(receipt.offerId);
    if (offer) {
      offer.paid = true;
      offer.done = true;
      renderVerdict(offer, instant);
    }
    setPill(dom.buyerPill, "Done", "pass");
    const item = h("li", { class: "feed__item feed__item--wide feed__item--receipt" }, renderReceipt(receipt));
    append(dom.buyerScroll, dom.buyerFeed, item, instant);
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
      setPill(dom.sellerPill, "Published", "pass");
      announce(`Offer published: ${ev.offer?.manifest?.name ?? "new offer"}.`, instant);
    },
    "buyer.step": buyerStep,
    "buyer.check": buyerCheck,
    "buyer.refused": buyerRefused,
    "payment.created": paymentCreated,
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
    const labels = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", offline: "Gateway offline", preview: "Preview data" };
    dom.conn.dataset.state = stateName;
    dom.conn.textContent = labels[stateName] ?? stateName;
  }

  reset();
  return { apply, addOffer: (signed, opts = {}) => addOffer(signed, opts.instant ?? true), reset, setConnection };
}
