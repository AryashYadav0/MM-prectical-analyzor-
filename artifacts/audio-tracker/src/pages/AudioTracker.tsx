import { useState, useEffect, useRef, useCallback } from "react";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToNote(freq: number): { note: string; octave: number; cents: number } {
  if (freq <= 0) return { note: "-", octave: 0, cents: 0 };
  const semitones = 12 * Math.log2(freq / 440);
  const rounded = Math.round(semitones);
  const noteIndex = ((rounded % 12) + 12 + 9) % 12;
  const octave = Math.floor((rounded + 9) / 12) + 4;
  const cents = Math.round((semitones - rounded) * 100);
  return { note: NOTE_NAMES[noteIndex], octave, cents };
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

function rmsToDb(rms: number) {
  return rms < 1e-10 ? -96 : Math.max(-96, 20 * Math.log10(rms));
}

interface DataPoint { time: number; hz: number; db: number; rms: number; }
interface NoteSegment { note: string; hz: number; startTime: number; endTime: number; duration: number; }

function drawWaveCanvas(canvas: HTMLCanvasElement, data: Float32Array) {
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0f1a"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = 1.5;
  ctx.shadowBlur = 6; ctx.shadowColor = "#22d3ee";
  ctx.beginPath();
  const sl = W / data.length; let x = 0;
  for (let i = 0; i < data.length; i++) {
    const y = (data[i] + 1) * H / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    x += sl;
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

function drawLineGraph(
  canvas: HTMLCanvasElement, points: DataPoint[],
  key: "hz" | "db", color: string, minV: number, maxV: number,
  unit: string, filterZero: boolean
) {
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0f1a"; ctx.fillRect(0, 0, W, H);
  if (points.length < 2) return;
  const maxT = points[points.length - 1].time;
  const range = Math.max(maxV - minV, 1);
  const pad = { l: 48, r: 8, t: 12, b: 22 };
  const gW = W - pad.l - pad.r, gH = H - pad.t - pad.b;

  ctx.strokeStyle = "rgba(100,116,139,0.2)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + (gH * i) / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    const v = Math.round(maxV - (range * i) / 4);
    ctx.fillStyle = "#475569"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText(`${v}${unit}`, pad.l - 3, y + 3);
  }
  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (gW * i) / 4;
    ctx.fillStyle = "#334155"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${((maxT * i) / 4 / 1000).toFixed(1)}s`, x, pad.t + gH + 14);
  }

  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.shadowBlur = 8; ctx.shadowColor = color;
  ctx.beginPath(); let first = true;
  for (const p of points) {
    const val = p[key] as number;
    if (filterZero && val <= 0) { first = true; continue; }
    const x = pad.l + (p.time / Math.max(maxT, 1)) * gW;
    const y = pad.t + gH - ((val - minV) / range) * gH;
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

function drawNoteChart(canvas: HTMLCanvasElement, segments: NoteSegment[], totalMs: number) {
  const ctx = canvas.getContext("2d"); if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0a0f1a"; ctx.fillRect(0, 0, W, H);
  if (segments.length === 0) {
    ctx.fillStyle = "#334155"; ctx.font = "11px monospace"; ctx.textAlign = "center";
    ctx.fillText("Waiting for notes...", W / 2, H / 2); return;
  }
  const pad = { l: 38, r: 8, t: 8, b: 22 };
  const gW = W - pad.l - pad.r;
  const recent = segments.slice(-16);
  const barH = Math.max(10, Math.min(26, (H - pad.t - pad.b - recent.length * 3) / recent.length));
  const allHz = recent.map(s => s.hz);
  const minHz = Math.min(...allHz), maxHz = Math.max(...allHz);

  recent.forEach((seg, i) => {
    const x = pad.l + (seg.startTime / Math.max(totalMs, 1)) * gW;
    const w = Math.max(4, (seg.duration / Math.max(totalMs, 1)) * gW);
    const y = pad.t + i * (barH + 3);
    const hue = maxHz === minHz ? 260 : 260 - ((seg.hz - minHz) / (maxHz - minHz)) * 180;
    ctx.fillStyle = `hsl(${hue},75%,58%)`;
    ctx.beginPath(); ctx.roundRect(x, y, w, barH, 3); ctx.fill();
    ctx.fillStyle = "#f1f5f9"; ctx.font = `${Math.min(barH - 2, 9)}px monospace`; ctx.textAlign = "right";
    ctx.fillText(`${seg.note}`, pad.l - 3, y + barH - 2);
    if (w > 36) {
      ctx.textAlign = "left"; ctx.fillStyle = "#0a0f1a";
      ctx.fillText(`${Math.round(seg.hz)}Hz  ${seg.duration >= 1000 ? (seg.duration / 1000).toFixed(1) + "s" : seg.duration + "ms"}`, x + 4, y + barH - 2);
    }
  });

  for (let i = 0; i <= 4; i++) {
    const x = pad.l + (gW * i) / 4;
    ctx.fillStyle = "#334155"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${((totalMs * i) / 4 / 1000).toFixed(1)}s`, x, H - pad.b + 14);
  }
}

export default function AudioTracker() {
  const [isListening, setIsListening] = useState(false);
  const [currentHz, setCurrentHz] = useState(0);
  const [currentNote, setCurrentNote] = useState({ note: "-", octave: 0, cents: 0 });
  const [currentDb, setCurrentDb] = useState(-96);
  const [amplitude, setAmplitude] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [segments, setSegments] = useState<NoteSegment[]>([]);
  const [noteStartTime, setNoteStartTime] = useState<number | null>(null);
  const [noteStartHz, setNoteStartHz] = useState(0);
  const [noteName, setNoteName] = useState("-");
  const [noteDurationMs, setNoteDurationMs] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufRef = useRef(new Float32Array(2048));
  const waveRef = useRef(new Float32Array(2048));
  const startTsRef = useRef(0);
  const activeNoteRef = useRef<{ hz: number; note: string; startTime: number } | null>(null);

  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const pitchCanvasRef = useRef<HTMLCanvasElement>(null);
  const volCanvasRef = useRef<HTMLCanvasElement>(null);
  const noteCanvasRef = useRef<HTMLCanvasElement>(null);

  const segmentsRef = useRef<NoteSegment[]>([]);

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    analyser.getFloatTimeDomainData(bufRef.current);
    analyser.getFloatTimeDomainData(waveRef.current);

    let rms = 0;
    for (let i = 0; i < bufRef.current.length; i++) rms += bufRef.current[i] ** 2;
    rms = Math.sqrt(rms / bufRef.current.length);
    const db = rmsToDb(rms);
    setAmplitude(Math.min(rms * 5, 1));
    setCurrentDb(Math.round(db * 10) / 10);

    const freq = autoCorrelate(bufRef.current, audioCtxRef.current!.sampleRate);
    const hz = freq > 0 ? Math.round(freq * 10) / 10 : 0;
    const noteInfo = freqToNote(hz);
    setCurrentHz(hz);
    setCurrentNote(noteInfo);

    const now = Date.now() - startTsRef.current;
    setElapsedMs(now);

    // Note duration tracking
    const noteFull = hz > 0 ? `${noteInfo.note}${noteInfo.octave}` : "-";
    if (hz > 0) {
      if (!activeNoteRef.current) {
        activeNoteRef.current = { hz, note: noteFull, startTime: now };
        setNoteStartTime(now); setNoteStartHz(hz); setNoteName(noteFull);
      } else if (Math.abs(hz - activeNoteRef.current.hz) > 20) {
        const dur = now - activeNoteRef.current.startTime;
        if (dur > 60) {
          const seg: NoteSegment = { note: activeNoteRef.current.note, hz: activeNoteRef.current.hz, startTime: activeNoteRef.current.startTime, endTime: now, duration: dur };
          segmentsRef.current = [...segmentsRef.current, seg].slice(-60);
          setSegments([...segmentsRef.current]);
        }
        activeNoteRef.current = { hz, note: noteFull, startTime: now };
        setNoteStartTime(now); setNoteStartHz(hz); setNoteName(noteFull);
      } else {
        setNoteDurationMs(now - activeNoteRef.current.startTime);
      }
    } else {
      if (activeNoteRef.current) {
        const dur = now - activeNoteRef.current.startTime;
        if (dur > 60) {
          const seg: NoteSegment = { note: activeNoteRef.current.note, hz: activeNoteRef.current.hz, startTime: activeNoteRef.current.startTime, endTime: now, duration: dur };
          segmentsRef.current = [...segmentsRef.current, seg].slice(-60);
          setSegments([...segmentsRef.current]);
        }
        activeNoteRef.current = null;
        setNoteStartTime(null); setNoteDurationMs(0); setNoteName("-");
      }
    }

    setDataPoints(prev => {
      const updated = [...prev, { time: now, hz, db, rms }].slice(-600);
      const validHz = updated.filter(p => p.hz > 0);
      const minH = validHz.length ? Math.min(...validHz.map(p => p.hz)) * 0.9 : 50;
      const maxH = validHz.length ? Math.max(...validHz.map(p => p.hz)) * 1.1 : 800;
      if (pitchCanvasRef.current) drawLineGraph(pitchCanvasRef.current, updated, "hz", "#a78bfa", minH, maxH, "Hz", true);
      if (volCanvasRef.current) drawLineGraph(volCanvasRef.current, updated, "db", "#22c55e", -80, 0, "dB", false);
      if (noteCanvasRef.current) drawNoteChart(noteCanvasRef.current, segmentsRef.current, now);
      return updated;
    });

    if (waveCanvasRef.current) drawWaveCanvas(waveCanvasRef.current, waveRef.current);
    rafRef.current = requestAnimationFrame(analyze);
  }, []);

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048; analyserRef.current = analyser;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      startTsRef.current = Date.now();
      segmentsRef.current = [];
      activeNoteRef.current = null;
      setDataPoints([]); setSegments([]); setElapsedMs(0);
      setNoteStartTime(null); setNoteDurationMs(0); setNoteName("-");
      setIsListening(true);
      rafRef.current = requestAnimationFrame(analyze);
    } catch {
      alert("Microphone access denied. Please allow microphone permission.");
    }
  };

  const stopListening = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current) audioCtxRef.current.close();
    setIsListening(false);
    setCurrentHz(0); setCurrentNote({ note: "-", octave: 0, cents: 0 });
    setCurrentDb(-96); setAmplitude(0);
  };

  const clearAll = () => {
    setDataPoints([]); setSegments([]); setElapsedMs(0);
    segmentsRef.current = []; activeNoteRef.current = null;
    setNoteStartTime(null); setNoteDurationMs(0); setNoteName("-");
    startTsRef.current = Date.now();
  };

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, []);

  const currentDurMs = noteStartTime !== null ? noteDurationMs : 0;
  const durLabel = currentDurMs >= 1000 ? `${(currentDurMs / 1000).toFixed(1)}s` : `${currentDurMs}ms`;

  return (
    <div style={{ minHeight: "100vh", background: "#07101f", color: "#e2e8f0", fontFamily: "monospace" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: "18px 14px" }}>

        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: "#22d3ee", letterSpacing: 2, margin: 0 }}>
            MUSIC MASTER AUDIO TRACKER
          </h1>
          <p style={{ color: "#475569", fontSize: 12, marginTop: 4 }}>
            Real-time · Note · Pitch · Duration · Volume
          </p>
        </div>

        {/* 4 stat cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 14 }}>
          <div style={{ background: "#111827", border: "1px solid #2d1f5e", borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>NOTE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#a78bfa", lineHeight: 1 }}>
              {currentNote.note !== "-" ? `${currentNote.note}${currentNote.octave}` : "---"}
            </div>
            <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>
              {currentNote.cents !== 0 ? `${currentNote.cents > 0 ? "+" : ""}${currentNote.cents}¢` : currentNote.note !== "-" ? "in tune" : "—"}
            </div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #1e3a5f", borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>PITCH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#22d3ee", lineHeight: 1 }}>
              {currentHz > 0 ? currentHz : "---"}
            </div>
            <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>Hz</div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #1f3a2d", borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>NOTE DURATION</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#34d399", lineHeight: 1 }}>
              {noteName !== "-" ? durLabel : "---"}
            </div>
            <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>
              {noteName !== "-" ? noteName : "—"}
            </div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #3a2a1f", borderRadius: 12, padding: "14px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>VOLUME</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: "#fb923c", lineHeight: 1 }}>
              {currentDb > -96 ? currentDb : "---"}
            </div>
            <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>dB</div>
          </div>
        </div>

        {/* Amplitude bar */}
        <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "8px 14px", marginBottom: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, whiteSpace: "nowrap" }}>AMPLITUDE</span>
          <div style={{ flex: 1, height: 8, background: "#0f172a", borderRadius: 4, overflow: "hidden" }}>
            <div style={{
              width: `${amplitude * 100}%`, height: "100%", borderRadius: 4,
              background: amplitude > 0.7 ? "#ef4444" : amplitude > 0.4 ? "#f59e0b" : "#22c55e",
              transition: "width 0.04s, background 0.1s"
            }} />
          </div>
          <span style={{ fontSize: 9, color: "#64748b", width: 32, textAlign: "right" }}>{Math.round(amplitude * 100)}%</span>
          <span style={{ fontSize: 9, color: "#334155", marginLeft: 8 }}>{(elapsedMs / 1000).toFixed(1)}s</span>
        </div>

        {/* Waveform */}
        <Section label="LIVE WAVEFORM">
          <canvas ref={waveCanvasRef} width={880} height={68}
            style={{ width: "100%", height: 68, borderRadius: 6, display: "block" }} />
        </Section>

        {/* Pitch graph */}
        <Section label="PITCH — Hz over Time">
          <canvas ref={pitchCanvasRef} width={880} height={110}
            style={{ width: "100%", height: 110, borderRadius: 6, display: "block" }} />
        </Section>

        {/* Volume graph */}
        <Section label="VOLUME — Decibels (dB) over Time">
          <canvas ref={volCanvasRef} width={880} height={90}
            style={{ width: "100%", height: 90, borderRadius: 6, display: "block" }} />
        </Section>

        {/* Note duration bars */}
        <Section label="NOTE DURATION — Each note, its Hz & length">
          <canvas ref={noteCanvasRef} width={880} height={120}
            style={{ width: "100%", height: 120, borderRadius: 6, display: "block" }} />
        </Section>

        {/* Controls */}
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          {!isListening ? (
            <button onClick={startListening}
              style={{ flex: 2, padding: "13px 0", background: "linear-gradient(135deg,#0e7490,#1d4ed8)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              START LISTENING
            </button>
          ) : (
            <button onClick={stopListening}
              style={{ flex: 2, padding: "13px 0", background: "linear-gradient(135deg,#7f1d1d,#991b1b)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              STOP
            </button>
          )}
          <button onClick={clearAll}
            style={{ flex: 1, padding: "13px 0", background: "#1e293b", border: "1px solid #334155", borderRadius: 10, color: "#94a3b8", fontFamily: "monospace", fontSize: 12, cursor: "pointer" }}>
            CLEAR
          </button>
        </div>

        <div style={{ marginTop: 10, textAlign: "center", fontSize: 10, color: "#334155" }}>
          {isListening
            ? `Listening... ${(elapsedMs / 1000).toFixed(1)}s · ${segments.length} notes detected`
            : "Press START LISTENING to begin"}
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "10px 14px", marginBottom: 10 }}>
      <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}
