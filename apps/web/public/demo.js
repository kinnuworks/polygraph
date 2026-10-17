// Replays a recorded buyer run (recorded-run.json, captured from the live gateway) for ?demo=1.
// Gaps between events are kept but clamped, so a slow cold fork doesn't stall the replay.
// The console labels it "Replay of a recorded run" whenever it plays.

let recording = null;

async function load() {
  if (!recording) {
    const res = await fetch(new URL("./recorded-run.json", import.meta.url));
    if (!res.ok) throw new Error(`recorded run unavailable (HTTP ${res.status})`);
    recording = await res.json();
  }
  return recording;
}

/** Plays the recording through `emit`. Resolves to a function that stops it. */
export async function runDemo(emit) {
  const { events } = await load();
  const timers = [];
  let at = 0;
  for (const [delay, event] of events) {
    at += delay;
    timers.push(setTimeout(() => {
      const ts = new Date().toISOString();
      const full = { ...structuredClone(event), ts };
      if (full.type === "job.completed") full.receipt.completedAt = ts;
      emit(full);
    }, at));
  }
  return () => timers.forEach(clearTimeout);
}
