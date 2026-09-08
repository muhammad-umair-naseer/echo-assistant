/**
 * Hands-free wake word — "Jarvis, …" — with no cloud hotword service.
 *
 * How: keep the mic open with a WebAudio analyser doing cheap RMS voice-
 * activity detection. When speech energy starts, record the segment
 * (MediaRecorder); when it ends (~900ms of silence), transcribe it through the
 * same Groq Whisper endpoint the push-to-talk uses, and check the transcript
 * for the wake word. "Jarvis, what's the time?" → command fires. A bare
 * "Jarvis?" arms a follow-up window where the NEXT segment needs no wake word.
 *
 * Barge-in: onSpeechStart fires the moment voice energy appears — the hook uses
 * it to cut TTS off so you can talk over JARVIS (echoCancellation on the mic
 * keeps its own speaker output from self-triggering).
 */

const WAKE_RE = /^(?:hey |ok |okay )?jarvis\b[\s,.!?:;-]*/i;
const RMS_THRESHOLD = 0.02; // voice energy floor (post echo-cancellation)
const SPEECH_START_MS = 180; // sustained energy before we call it speech
const SILENCE_END_MS = 900; // quiet gap that ends a segment
const MAX_SEGMENT_MS = 10_000;
const FOLLOWUP_WINDOW_MS = 7_000;

export interface WakeCallbacks {
  onSpeechStart: () => void; // any voice energy (barge-in hook)
  onCommand: (text: string) => void; // wake word + command heard
  onWakeOnly: () => void; // bare "jarvis" — we're listening for a follow-up
  onError: (msg: string) => void;
}

export class WakeListener {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private timer = 0;
  private running = false;
  private followupUntil = 0;

  available(): boolean {
    return (
      typeof MediaRecorder !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== "undefined"
    );
  }

  get active(): boolean {
    return this.running;
  }

  async start(cb: WakeCallbacks): Promise<void> {
    if (this.running) return;
    this.running = true;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      this.running = false;
      cb.onError((err as Error).name === "NotAllowedError" ? "microphone permission denied" : (err as Error).message);
      return;
    }
    // stop() may have been called while we awaited the permission prompt —
    // without this check the mic stays captured forever with wake shown off.
    if (!this.running) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.ctx = new AudioContext();
    // Chrome starts a no-user-activation AudioContext suspended: the analyser
    // would read zeros forever and wake would be silently dead after a reload.
    if (this.ctx.state === "suspended") {
      void this.ctx.resume();
      const kick = () => void this.ctx?.resume();
      window.addEventListener("pointerdown", kick, { once: true });
      window.addEventListener("keydown", kick, { once: true });
    }
    const src = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);

    let speechSince = 0;
    let silentSince = 0;
    let rec: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let segmentStart = 0;

    const stopSegment = async () => {
      if (!rec) return;
      const r = rec;
      rec = null;
      await new Promise<void>((resolve) => {
        r.onstop = () => resolve();
        r.stop();
      });
      const blob = new Blob(chunks, { type: r.mimeType });
      chunks = [];
      if (blob.size < 2000) return; // too short to be words
      try {
        const res = await fetch("/api/transcribe", {
          method: "POST",
          headers: { "content-type": r.mimeType },
          body: blob,
        });
        if (!res.ok) return;
        const { text } = (await res.json()) as { text?: string };
        const heard = (text ?? "").trim();
        if (!heard) return;
        const m = WAKE_RE.exec(heard);
        if (m) {
          const command = heard.slice(m[0].length).trim();
          if (command) cb.onCommand(command);
          else {
            this.followupUntil = performance.now() + FOLLOWUP_WINDOW_MS;
            cb.onWakeOnly();
          }
        } else if (performance.now() < this.followupUntil) {
          this.followupUntil = 0;
          cb.onCommand(heard); // follow-up after a bare "jarvis" — no wake word needed
        }
        // otherwise: ambient speech without the wake word — deliberately ignored
      } catch {
        /* transcription hiccup — stay armed */
      }
    };

    this.timer = window.setInterval(() => {
      if (!this.running) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      const now = performance.now();

      if (rms >= RMS_THRESHOLD) {
        silentSince = 0;
        if (speechSince === 0) speechSince = now;
        if (!rec && now - speechSince >= SPEECH_START_MS && this.stream) {
          cb.onSpeechStart(); // barge-in signal
          chunks = [];
          rec = new MediaRecorder(this.stream);
          rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
          rec.start();
          segmentStart = now;
        }
        if (rec && now - segmentStart > MAX_SEGMENT_MS) void stopSegment();
      } else {
        speechSince = 0;
        if (rec) {
          if (silentSince === 0) silentSince = now;
          if (now - silentSince >= SILENCE_END_MS) void stopSegment();
        }
      }
    }, 90);
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }
}
