import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);

// PWA: installable as a desktop/dock app (Chrome: install icon in the omnibox).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// Dev-only: demo GIF recorder. `__record()` reloads with capture armed so the
// boot sequence lands in the GIF from frame zero.
if (import.meta.env.DEV) {
  void import("./record.ts").then((m) => {
    (window as unknown as { __record: () => void }).__record = m.armRecording;
    m.maybeRecord();
  });
}
