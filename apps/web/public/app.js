import { createConsole, renderReceipt } from "./console.js";

// Event types the gateway names its SSE frames after.
const EVENT_TYPES = [
  "seller.step", "seller.test", "seller.patch", "seller.attack", "offer.published", "offer.removed",
  "buyer.step", "buyer.check", "buyer.refused",
  "payment.created", "payment.refunded", "worker.forked", "worker.destroyed", "job.completed",
];

const params = new URLSearchParams(location.search);
const isOn = (name) => params.has(name) && !["0", "false"].includes(params.get(name));
const demoMode = isOn("demo");

const root = document.getElementById("console-window");
const receiptSlot = document.querySelector('[data-el="receipt-section"]');
const receiptEmpty = receiptSlot.innerHTML;
const ui = createConsole(root, {
  onReceipt: (receipt) => receiptSlot.replaceChildren(renderReceipt(receipt, { light: true })),
});

// Full-screen links keep the current data source.
document.querySelectorAll('a[href="?console=1"]').forEach((link) => {
  const next = new URLSearchParams(params);
  next.set("console", "1");
  link.href = `?${next}`;
});

if (demoMode) startDemo();
else connectLive();

/* ---------- preview data ---------- */

async function startDemo() {
  const { runDemo } = await import("./demo.js");
  root.dataset.mode = "preview";
  ui.setConnection("preview");
  root.querySelector('[data-el="preview-tag"]').hidden = false;
  const replay = root.querySelector('[data-el="replay"]');
  replay.hidden = false;

  let stop = () => {};
  let playId = 0;
  const play = async () => {
    const id = ++playId;
    stop();
    ui.reset();
    receiptSlot.innerHTML = receiptEmpty;
    try {
      const stopThis = await runDemo((event) => ui.apply(event));
      // A second click while loading wins; cancel the older replay.
      if (id === playId) stop = stopThis;
      else stopThis();
    } catch {
      ui.setConnection("offline");
    }
  };
  replay.addEventListener("click", play);
  play();
}

/* ---------- live gateway ---------- */


function connectLive() {
  // The gateway replays recent events on every (re)connect; skip the ones already rendered.
  const seen = new Set();
  let source = null;
  let connectedAt = 0;
  let attempt = 0;
  let retryTimer = 0;

  const open = () => {
    clearTimeout(retryTimer);
    ui.setConnection(attempt ? "reconnecting" : "connecting");
    source = new EventSource("/events");
    source.onopen = () => {
      attempt = 0;
      connectedAt = Date.now();
      ui.setConnection("live");
      loadOffers();
    };
    source.onmessage = (message) => handle(message.data);
    // The gateway names each SSE frame after its event type, so listen for every known type too.
    for (const type of EVENT_TYPES) source.addEventListener(type, (message) => handle(message.data));
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        // The browser gave up (e.g. the gateway is down); retry with backoff.
        source.close();
        attempt += 1;
        ui.setConnection(attempt > 2 ? "offline" : "reconnecting");
        retryTimer = setTimeout(open, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
      } else {
        ui.setConnection("reconnecting");
      }
    };
  };

  function handle(raw) {
    if (seen.has(raw)) return;
    seen.add(raw);
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    if (!event || typeof event.type !== "string") return;
    // Replayed history renders at once; only fresh events animate and get announced.
    const ts = Date.parse(event.ts);
    const instant = !connectedAt || (Number.isFinite(ts) && ts < connectedAt - 1500);
    ui.apply(event, { instant });
  }

  async function loadOffers() {
    try {
      const res = await fetch("/offers", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const body = await res.json();
      const list = Array.isArray(body) ? body : Array.isArray(body?.offers) ? body.offers : [];
      list.forEach((offer) => ui.addOffer(offer, { instant: true }));
    } catch {
      /* the event feed still works without the offer list */
    }
  }

  window.addEventListener("online", () => { if (!source || source.readyState === EventSource.CLOSED) open(); });
  open();
}

/* ---------- page motion ---------- */

if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("in");
      io.unobserve(entry.target);
    }
  }), { rootMargin: "0px 0px -8% 0px" });
  document.querySelectorAll(".reveal").forEach((node) => io.observe(node));
} else {
  document.querySelectorAll(".reveal").forEach((node) => node.classList.add("in"));
}
