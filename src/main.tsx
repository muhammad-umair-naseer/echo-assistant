import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(<App />);

// Dev-only: demo GIF recorder. `__record()` reloads with capture armed so the
// boot sequence lands in the GIF from frame zero.
if (import.meta.env.DEV) {
  void import("./record.ts").then((m) => {
    (window as unknown as { __record: () => void }).__record = m.armRecording;
    m.maybeRecord();
  });
}
