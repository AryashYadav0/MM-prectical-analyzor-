import { useState, useEffect, useRef, useCallback } from "react";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToNote(freq: number): string {
  if (freq <= 0) return "-";
  const semitones = 12 * Math.log2(freq / 440);
  const rounded = Math.round(semitones);
  const noteIndex = ((rounded % 12) + 12 + 9) % 12;
  const octave = Math.floor((rounded + 9) / 12) + 4;
  return `${NOTE_NAMES[noteIndex]}${octave}`;
}

function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  const SIZE = buf.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  let best_offset = -1, best_correlation = 0, rms = 0, lastCorrelation = 1;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.008) return -1;
  for (let offset = 1; offset < MAX_SAMPLES; offset++) {
    let correlation = 0;
    for (let i = 0; i < MAX_SAMPLES; i++) correlation += Math.abs(buf[i] - buf[i + offset]);
    correlation = 1 - correlation / MAX_SAMPLES;
    if (correlation > 0.9 && correlation > lastCorrelation) {
      if (correlation > best_correlation) { best_correlation = correlation; best_offset = offset; }
    }
    lastCorrelation = correlation;
  }
  return best_offset === -1 ? -1 : sampleRate / best_offset;
}

interface Sample { time: number; hz: number; note: string; }

interface NoteSegment { note: string; hz: number; startTime: number; endTime: number; duration: number; }

function buildSegments(samples: Sample[]): NoteSegment[] {
  if (samples.length === 0) return [];
  const segments: NoteSegment[] = [];
  let cur = { ...samples[0], startTime: samples[0].time };
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    const sameNote = s.note === cur.note && Math.abs(s.hz - cur.hz) < 20;
    if (!sameNote) {
      if (cur.note !== "-" && cur.hz > 0) {
        segments.push({ note: cur.note, hz: cur.hz, startTime: cur.startTime, endTime: s.time, duration: s.time - cur.startTime });
      }
      cur = { ...s, startTime: s.time };
    }
  }
  const last = samples[samples.length - 1];
  if (cur.note !== "-" && cur.hz > 0) {
    segments.push({ note: cur.note, hz: cur.hz, startTime: cur.startTime, endTime: last.time, duration: last.time - cur.startTime });
  }
  return segments;
}

function drawHzTimeline(canvas: HTMLCanvasElement, samples: Sample[], totalMs: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0f1a";
  ctx.fillRect(0, 0, W, H);

  const valid = samples.filter(s => s.hz > 0);
  if (valid.length < 2) {
    ctx.fillStyle = "#475569";
    ctx.font = "13px monospace";
    ctx.textAlign = "center";
    ctx.fillText("No pitch detected", W / 2, H / 2);
    return;
  }

  const minHz = Math.min(...valid.map(s => s.hz)) * 0.9;
  const maxHz = Math.max(...valid.map(s => s.hz)) * 1.1;
  const hzRange = Math.max(maxHz - minHz, 50);
  const pad = { l: 52, r: 10, t: 16, b: 28 };
  const gW = W - pad.l - pad.r;
  const gH = H - pad.t - pad.b;

  // Grid
  ctx.strokeStyle = "rgba(100,116,139,0.2)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.t + (gH * i) / 5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    const label = Math.round(maxHz - (hzRange * i) / 5);
    ctx.fillStyle = "#64748b"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText(`${label}Hz`, pad.l - 4, y + 3);
  }
  // Time axis
  for (let i = 0; i <= 5; i++) {
    const x = pad.l + (gW * i) / 5;
    ctx.strokeStyle = "rgba(100,116,139,0.15)";
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gH); ctx.stroke();
    const t = ((totalMs * i) / 5 / 1000).toFixed(1);
    ctx.fillStyle = "#64748b"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${t}s`, x, pad.t + gH + 14);
  }

  // Hz line
  ctx.strokeStyle = "#a78bfa";
  ctx.lineWidth = 2.5;
  ctx.shadowBlur = 10; ctx.shadowColor = "#a78bfa";
  ctx.beginPath();
  let first = true;
  for (const s of samples) {
    if (s.hz <= 0) { first = true; continue; }
    const x = pad.l + (s.time / Math.max(totalMs, 1)) * gW;
    const y = pad.t + gH - ((s.hz - minHz) / hzRange) * gH;
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    first = false;
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Dots for samples
  ctx.fillStyle = "#c4b5fd";
  for (const s of samples) {
    if (s.hz <= 0) continue;
    const x = pad.l + (s.time / Math.max(totalMs, 1)) * gW;
    const y = pad.t + gH - ((s.hz - minHz) / hzRange) * gH;
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }
}

function drawSegmentBars(canvas: HTMLCanvasElement, segments: NoteSegment[], totalMs: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0f1a";
  ctx.fillRect(0, 0, W, H);

  if (segments.length === 0) {
    ctx.fillStyle = "#475569"; ctx.font = "13px monospace"; ctx.textAlign = "center";
    ctx.fillText("No notes detected", W / 2, H / 2);
    return;
  }

  const pad = { l: 52, r: 10, t: 10, b: 28 };
  const gW = W - pad.l - pad.r;
  const barH = Math.max(8, Math.min(28, (H - pad.t - pad.b) / segments.length - 3));
  const allHz = segments.map(s => s.hz);
  const minHz = Math.min(...allHz);
  const maxHz = Math.max(...allHz);

  segments.forEach((seg, i) => {
    const x = pad.l + (seg.startTime / Math.max(totalMs, 1)) * gW;
    const w = Math.max(3, (seg.duration / Math.max(totalMs, 1)) * gW);
    const y = pad.t + i * (barH + 3);
    const hue = maxHz === minHz ? 260 : 260 - ((seg.hz - minHz) / (maxHz - minHz)) * 180;
    ctx.fillStyle = `hsl(${hue}, 75%, 60%)`;
    ctx.beginPath();
    ctx.roundRect(x, y, w, barH, 3);
    ctx.fill();

    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${Math.min(barH - 2, 10)}px monospace`;
    ctx.textAlign = "left";
    const label = `${seg.note} ${Math.round(seg.hz)}Hz ${seg.duration >= 1000 ? (seg.duration / 1000).toFixed(1) + "s" : seg.duration + "ms"}`;
    if (w > 40) ctx.fillText(label, x + 4, y + barH - 3);
  });

  // Time axis
  for (let i = 0; i <= 5; i++) {
    const x = pad.l + (gW * i) / 5;
    const t = ((totalMs * i) / 5 / 1000).toFixed(1);
    ctx.fillStyle = "#64748b"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${t}s`, x, H - pad.b + 14);
  }
}

export default function AudioTracker() {
  const [mode, setMode] = useState<"idle" | "recording" | "result">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [segments, setSegments] = useState<NoteSegment[]>([]);
  const [liveHz, setLiveHz] = useState(0);
  const [liveNote, setLiveNote] = useState("-");
  const [liveAmplitude, setLiveAmplitude] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef(new Float32Array(2048));
  const waveRef = useRef(new Float32Array(2048));
  const startTsRef = useRef(0);
  const samplesRef = useRef<Sample[]>([]);

  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const hzCanvasRef = useRef<HTMLCanvasElement>(null);
  const barCanvasRef = useRef<HTMLCanvasElement>(null);

  // Live waveform draw
  const drawLiveWave = (data: Float32Array) => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0f1a"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.5;
    ctx.shadowBlur = 6; ctx.shadowColor = "#22d3ee";
    ctx.beginPath();
    const sl = W / data.length;
    let x = 0;
    for (let i = 0; i < data.length; i++) {
      const y = (data[i] + 1) * H / 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      x += sl;
    }
    ctx.stroke(); ctx.shadowBlur = 0;
  };

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(bufRef.current);
    analyser.getFloatTimeDomainData(waveRef.current);

    let rms = 0;
    for (let i = 0; i < bufRef.current.length; i++) rms += bufRef.current[i] ** 2;
    rms = Math.sqrt(rms / bufRef.current.length);
    setLiveAmplitude(Math.min(rms * 5, 1));

    const freq = autoCorrelate(bufRef.current, audioCtxRef.current!.sampleRate);
    const hz = freq > 0 ? Math.round(freq * 10) / 10 : 0;
    const note = freqToNote(hz);
    setLiveHz(hz);
    setLiveNote(note);

    const now = Date.now() - startTsRef.current;
    setElapsedMs(now);

    const sample: Sample = { time: now, hz, note };
    samplesRef.current.push(sample);

    drawLiveWave(waveRef.current);
    rafRef.current = requestAnimationFrame(analyze);
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      startTsRef.current = Date.now();
      samplesRef.current = [];
      setSamples([]);
      setSegments([]);
      setElapsedMs(0);
      setMode("recording");
      rafRef.current = requestAnimationFrame(analyze);
    } catch {
      alert("Microphone access denied. Please allow microphone permission.");
    }
  };

  const stopRecording = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();

    const recorded = [...samplesRef.current];
    const segs = buildSegments(recorded);
    setSamples(recorded);
    setSegments(segs);
    setMode("result");
    setLiveHz(0); setLiveNote("-"); setLiveAmplitude(0);
  };

  const reset = () => {
    setSamples([]); setSegments([]); setElapsedMs(0);
    setLiveHz(0); setLiveNote("-"); setLiveAmplitude(0);
    setMode("idle");
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  // Draw result graphs after stop
  useEffect(() => {
    if (mode === "result" && samples.length > 0) {
      const totalMs = samples[samples.length - 1].time;
      if (hzCanvasRef.current) drawHzTimeline(hzCanvasRef.current, samples, totalMs);
      if (barCanvasRef.current) drawSegmentBars(barCanvasRef.current, segments, totalMs);
    }
  }, [mode, samples, segments]);

  const totalMs = samples.length > 0 ? samples[samples.length - 1].time : 0;
  const validSamples = samples.filter(s => s.hz > 0);
  const avgHz = validSamples.length ? Math.round(validSamples.reduce((a, b) => a + b.hz, 0) / validSamples.length) : 0;
  const minHz = validSamples.length ? Math.round(Math.min(...validSamples.map(s => s.hz))) : 0;
  const maxHz = validSamples.length ? Math.round(Math.max(...validSamples.map(s => s.hz))) : 0;
  const dominantNote = segments.length
    ? segments.reduce((a, b) => a.duration > b.duration ? a : b).note
    : "-";

  return (
    <div style={{ minHeight: "100vh", background: "#07101f", color: "#e2e8f0", fontFamily: "monospace" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, color: "#22d3ee", letterSpacing: 2, margin: 0 }}>
            MUSIC MASTER AUDIO TRACKER
          </h1>
          <p style={{ color: "#475569", fontSize: 12, marginTop: 4 }}>
            Record your voice/instrument → get Hz graph + note analysis
          </p>
        </div>

        {/* IDLE STATE */}
        {mode === "idle" && (
          <div style={{ textAlign: "center", padding: "60px 20px" }}>
            <div style={{ fontSize: 64, marginBottom: 20 }}>🎙️</div>
            <p style={{ color: "#64748b", fontSize: 14, marginBottom: 32 }}>
              Press the button, speak or play your instrument, then stop.<br />
              We'll show you the exact Hz values and how long each note lasted.
            </p>
            <button onClick={startRecording}
              style={{ padding: "16px 48px", background: "linear-gradient(135deg,#0e7490,#1d4ed8)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "monospace", fontSize: 16, fontWeight: 700, cursor: "pointer", letterSpacing: 2 }}>
              START RECORDING
            </button>
          </div>
        )}

        {/* RECORDING STATE */}
        {mode === "recording" && (
          <>
            {/* Live stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
              <div style={{ background: "#111827", border: "1px solid #1e3a5f", borderRadius: 12, padding: "14px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>LIVE FREQUENCY</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: "#22d3ee" }}>{liveHz > 0 ? liveHz : "---"}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>Hz</div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #2d1f5e", borderRadius: 12, padding: "14px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>CURRENT NOTE</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: "#a78bfa" }}>{liveNote !== "-" ? liveNote : "---"}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>note</div>
              </div>
              <div style={{ background: "#111827", border: "1px solid #3a1f1f", borderRadius: 12, padding: "14px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>TIME</div>
                <div style={{ fontSize: 30, fontWeight: 800, color: "#f87171" }}>{(elapsedMs / 1000).toFixed(1)}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>seconds</div>
              </div>
            </div>

            {/* Amplitude */}
            <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#ef4444", animation: "pulse 1s infinite", boxShadow: "0 0 8px #ef4444" }} />
              <span style={{ fontSize: 10, color: "#94a3b8", letterSpacing: 1 }}>RECORDING</span>
              <div style={{ flex: 1, height: 10, background: "#0f172a", borderRadius: 5, overflow: "hidden", marginLeft: 8 }}>
                <div style={{
                  width: `${liveAmplitude * 100}%`, height: "100%", borderRadius: 5,
                  background: liveAmplitude > 0.7 ? "#ef4444" : liveAmplitude > 0.4 ? "#f59e0b" : "#22c55e",
                  transition: "width 0.05s"
                }} />
              </div>
              <span style={{ fontSize: 10, color: "#64748b", width: 36 }}>{Math.round(liveAmplitude * 100)}%</span>
            </div>

            {/* Live waveform */}
            <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 14, marginBottom: 20 }}>
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 6 }}>LIVE WAVEFORM</div>
              <canvas ref={waveCanvasRef} width={860} height={80}
                style={{ width: "100%", height: 80, borderRadius: 6, display: "block" }} />
            </div>

            {/* Stop button */}
            <div style={{ textAlign: "center" }}>
              <button onClick={stopRecording}
                style={{ padding: "16px 56px", background: "linear-gradient(135deg,#7f1d1d,#b91c1c)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "monospace", fontSize: 16, fontWeight: 700, cursor: "pointer", letterSpacing: 2 }}>
                STOP & ANALYZE
              </button>
            </div>
          </>
        )}

        {/* RESULT STATE */}
        {mode === "result" && (
          <>
            {/* Summary stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
              {[
                { label: "DURATION", value: `${(totalMs / 1000).toFixed(2)}s`, color: "#22d3ee" },
                { label: "AVG Hz", value: avgHz > 0 ? `${avgHz}` : "---", color: "#a78bfa", unit: "Hz" },
                { label: "MIN Hz", value: minHz > 0 ? `${minHz}` : "---", color: "#34d399", unit: "Hz" },
                { label: "MAX Hz", value: maxHz > 0 ? `${maxHz}` : "---", color: "#f87171", unit: "Hz" },
                { label: "TOP NOTE", value: dominantNote, color: "#fb923c" },
              ].map(s => (
                <div key={s.label} style={{ background: "#111827", border: "1px solid #1e293b", borderRadius: 10, padding: "12px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: s.color }}>{s.value}</div>
                  {(s as any).unit && <div style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>{(s as any).unit}</div>}
                </div>
              ))}
            </div>

            {/* Hz over Time graph */}
            <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 16, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 8 }}>
                HZ GRAPH — Frequency at every moment of your recording
              </div>
              <canvas ref={hzCanvasRef} width={860} height={180}
                style={{ width: "100%", height: 180, borderRadius: 8, display: "block" }} />
            </div>

            {/* Note segments bar chart */}
            <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 16, marginBottom: 14 }}>
              <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 8 }}>
                NOTE DURATION — Each note, its Hz, and how long it lasted
              </div>
              <canvas ref={barCanvasRef} width={860} height={Math.min(Math.max(segments.length * 31 + 40, 80), 360)}
                style={{ width: "100%", height: Math.min(Math.max(segments.length * 31 + 40, 80), 360), borderRadius: 8, display: "block" }} />
            </div>

            {/* Note table */}
            {segments.length > 0 && (
              <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 14, marginBottom: 20 }}>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 10 }}>DETECTED NOTES</div>
                <div style={{ display: "grid", gridTemplateColumns: "auto auto auto auto", gap: "6px 16px" }}>
                  {["NOTE", "HZ", "START", "DURATION"].map(h => (
                    <div key={h} style={{ fontSize: 9, color: "#475569", letterSpacing: 1, paddingBottom: 4, borderBottom: "1px solid #1e293b" }}>{h}</div>
                  ))}
                  {segments.map((seg, i) => (
                    <>
                      <div key={`n${i}`} style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa" }}>{seg.note}</div>
                      <div key={`h${i}`} style={{ fontSize: 13, color: "#22d3ee" }}>{Math.round(seg.hz)} Hz</div>
                      <div key={`s${i}`} style={{ fontSize: 12, color: "#94a3b8" }}>{(seg.startTime / 1000).toFixed(2)}s</div>
                      <div key={`d${i}`} style={{ fontSize: 12, color: "#34d399" }}>
                        {seg.duration >= 1000 ? `${(seg.duration / 1000).toFixed(2)}s` : `${seg.duration}ms`}
                      </div>
                    </>
                  ))}
                </div>
              </div>
            )}

            {/* Record again */}
            <div style={{ textAlign: "center" }}>
              <button onClick={reset}
                style={{ padding: "14px 40px", background: "linear-gradient(135deg,#0e7490,#1d4ed8)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
                RECORD AGAIN
              </button>
            </div>
          </>
        )}

        <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
      </div>
    </div>
  );
}
