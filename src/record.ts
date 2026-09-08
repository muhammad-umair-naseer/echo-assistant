/**
 * Dev-only demo recorder. `__record()` arms a sessionStorage flag and reloads,
 * so capture starts at frame zero and the GIF includes the boot sequence. The
 * script types a recall question (answered from memories stored in PAST
 * sessions), then `/memory`, showing the inspector. Frames are captured
 * SYNCHRONOUSLY at each beat (a free-running loop produced stale duplicates),
 * encoded with gifenc, POSTed to /__save → docs/demo.gif. Not shipped.
 */

const FLAG = "echo-record";
declare global {
  interface Window {
    __recMsg?: string;
  }
}

export function armRecording(): void {
  sessionStorage.setItem(FLAG, "1");
  location.reload();
}

export function maybeRecord(): void {
  if (sessionStorage.getItem(FLAG) !== "1") return;
  sessionStorage.removeItem(FLAG);
  window.__recMsg = "recording";
  void runRecording()
    .then((m) => (window.__recMsg = m))
    .catch((e) => (window.__recMsg = `ERR: ${(e as Error).message}`));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runRecording(): Promise<string> {
  const html2canvas = (await import("html2canvas")).default;
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");

  const frames: { data: Uint8ClampedArray; w: number; h: number }[] = [];
  const cap = async (hold = 1) => {
    if (frames.length >= 140) return;
    const c = await html2canvas(document.body, {
      backgroundColor: "#070c08",
      scale: 1,
      logging: false,
      width: innerWidth,
      height: innerHeight,
      // html2canvas's clone collapses chained percentage heights (html→body→
      // #root→.term all 100%), leaving .term 3px tall and frames black — pin
      // explicit pixel heights on the clone.
      onclone: (doc) => {
        for (const sel of ["html", "body", "#root", ".deck-root", ".deck"]) {
          const el = doc.querySelector<HTMLElement>(sel);
          if (el) el.style.height = `${innerHeight}px`;
        }
        // html2canvas refuses to paint glyphs that carry our text-shadow glow —
        // strip it (and animations) in the clone; colors carry the aesthetic.
        doc.querySelectorAll<HTMLElement>("*").forEach((el) => {
          el.style.textShadow = "none";
          el.style.animation = "none";
        });
        doc.querySelector<HTMLElement>(".sweep")?.remove();
      },
    });
    const ctx = c.getContext("2d")!;
    const frame = { data: ctx.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    for (let i = 0; i < hold; i++) frames.push(frame); // hold = longer on-screen time
  };

  const input = () => document.querySelector<HTMLInputElement>(".composer-input");
  const typeInto = async (text: string) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (let i = 1; i <= text.length; i++) {
      const el = input();
      if (!el) break;
      setter.call(el, text.slice(0, i));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(20);
      if (i % 3 === 0 || i === text.length) await cap(); // capture every 3 chars
    }
    await cap(2);
    input()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };

  // boot: capture the overlay + deck entrance as it plays
  const t0 = performance.now();
  while (document.querySelector(".boot-overlay") && performance.now() - t0 < 15_000) {
    await cap();
    await sleep(150);
  }
  await cap(3); // settle on READY

  await typeInto("what am I building, and who am I?");

  // thinking + streaming: capture until the state pill returns to idle
  // (the deck keeps the composer mounted while streaming)
  const stateIdle = () => document.querySelector(".state-pill")?.textContent?.includes("idle") ?? true;
  await sleep(250);
  const t1 = performance.now();
  while (!stateIdle() && performance.now() - t1 < 30_000) {
    await cap();
    await sleep(120);
  }
  await cap(6); // hold the finished reply + recall chip

  await typeInto("/memory");
  await sleep(400);
  await cap(10); // hold the inspector

  const gif = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.data, 128);
    const index = applyPalette(f.data, palette);
    gif.writeFrame(index, f.w, f.h, { palette, delay: 110 });
  }
  gif.finish();
  const bytes = gif.bytes();
  await fetch("/__save", { method: "POST", body: new Blob([bytes as unknown as BlobPart]) });
  return `saved ${bytes.length} bytes, ${frames.length} frames`;
}
