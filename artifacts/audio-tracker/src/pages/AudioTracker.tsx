import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────────────────────
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHART_BG = "#f8fbff";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function freqToNote(freq: number) {
  if (freq <= 0) return { note: "-", octave: 0, cents: 0, full: "-" };
  const semi = 12 * Math.log2(freq / 440);
  const r = Math.round(semi);
  const note = NOTE_NAMES[((r % 12) + 12 + 9) % 12];
  const octave = Math.floor((r + 9) / 12) + 4;
  const cents = Math.round((semi - r) * 100);
  return { note, octave, cents, full: `${note}${octave}` };
}

function autoCorrelate(buf: Float32Array, sr: number): number {
  const N = buf.length;
  const MAX = Math.floor(N / 2);
  let rms = 0;
  for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
  if (Math.sqrt(rms / N) < 0.008) return -1;
  let bestOff = -1, bestCorr = 0, last = 1;
  for (let o = 1; o < MAX; o++) {
    let c = 0;
    for (let i = 0; i < MAX; i++) c += Math.abs(buf[i] - buf[i + o]);
    c = 1 - c / MAX;
    if (c > 0.9 && c > last && c > bestCorr) { bestCorr = c; bestOff = o; }
    last = c;
  }
  return bestOff === -1 ? -1 : sr / bestOff;
}

function rmsToDb(rms: number) {
  return rms < 1e-10 ? -96 : Math.max(-96, 20 * Math.log10(rms));
}

// ─── Canvas Drawers ───────────────────────────────────────────────────────────
function drawWave(canvas: HTMLCanvasElement, data: Float32Array) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#0284c7"; ctx.lineWidth = 1.5;
  ctx.shadowBlur = 4; ctx.shadowColor = "rgba(2,132,199,0.35)";
  ctx.beginPath();
  const sl = W / data.length;
  for (let i = 0; i < data.length; i++) {
    const x = i * sl, y = (data[i] + 1) * H / 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

interface Pt { t: number; v: number; }

function drawLine(canvas: HTMLCanvasElement, pts: Pt[], color: string, minV: number, maxV: number, unit: string) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, W, H);
  if (pts.length < 2) return;
  const PL = 46, PR = 6, PT = 10, PB = 20;
  const GW = W - PL - PR, GH = H - PT - PB;
  const maxT = pts[pts.length - 1].t;
  const range = Math.max(maxV - minV, 1);

  // Grid
  ctx.strokeStyle = "rgba(148,163,184,0.38)"; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PT + (GH * i) / 4;
    ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(W - PR, y); ctx.stroke();
    ctx.fillStyle = "#475569"; ctx.font = "9px monospace"; ctx.textAlign = "right";
    ctx.fillText(`${Math.round(maxV - (range * i) / 4)}${unit}`, PL - 3, y + 3);
  }
  for (let i = 0; i <= 5; i++) {
    const x = PL + (GW * i) / 5;
    ctx.fillStyle = "#64748b"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${((maxT * i) / 5 / 1000).toFixed(1)}s`, x, PT + GH + 14);
  }

  // Line
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.shadowBlur = 7; ctx.shadowColor = color;
  ctx.beginPath();
  let first = true;
  for (const p of pts) {
    const x = PL + (p.t / Math.max(maxT, 1)) * GW;
    const y = PT + GH - ((p.v - minV) / range) * GH;
    first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false;
  }
  ctx.stroke(); ctx.shadowBlur = 0;
}

interface Seg { note: string; hz: number; tStart: number; tEnd: number; dur: number; }

function drawBars(canvas: HTMLCanvasElement, segs: Seg[], _totalMs: number) {
  const ctx = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, W, H);

  if (segs.length === 0) {
    ctx.fillStyle = "#64748b"; ctx.font = "13px monospace"; ctx.textAlign = "center";
    ctx.fillText("No notes yet — start speaking or playing", W / 2, H / 2);
    return;
  }

  // Layout constants
  const ROW_H = 28;
  const HEADER_H = 22;
  const PAD_TOP = 6;
  const COL_NUM  = 28;   // # column
  const COL_NOTE = 72;   // Note name column
  const COL_BAR_START = COL_NUM + COL_NOTE;
  const COL_BAR_W = W - COL_BAR_START - 120; // bar width area
  const COL_HZ_W = 68;
  const COL_DUR_W = 52;

  // Header row
  ctx.fillStyle = "#e2e8f0";
  ctx.fillRect(0, PAD_TOP, W, HEADER_H);

  ctx.fillStyle = "#334155"; ctx.font = "bold 9px monospace"; ctx.textAlign = "center";
  ctx.fillText("#",       COL_NUM / 2,                              PAD_TOP + 14);
  ctx.fillText("NOTE",   COL_NUM + COL_NOTE / 2,                    PAD_TOP + 14);
  ctx.fillText("DURATION BAR",  COL_BAR_START + COL_BAR_W / 2,     PAD_TOP + 14);
  ctx.fillText("Hz",     W - COL_DUR_W - COL_HZ_W / 2,             PAD_TOP + 14);
  ctx.fillText("TIME",   W - COL_DUR_W / 2,                        PAD_TOP + 14);

  // Divider line under header
  ctx.strokeStyle = "#cbd5e1"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, PAD_TOP + HEADER_H); ctx.lineTo(W, PAD_TOP + HEADER_H); ctx.stroke();

  // Max duration for bar scaling
  const maxDur = Math.max(...segs.map(s => s.dur), 1);
  const allHz = segs.map(s => s.hz);
  const minHz = Math.min(...allHz), maxHz = Math.max(...allHz);

  segs.forEach((seg, i) => {
    const rowY = PAD_TOP + HEADER_H + i * ROW_H;

    // Alternate row background
    ctx.fillStyle = i % 2 === 0 ? "#ffffff" : "#f8fafc";
    ctx.fillRect(0, rowY, W, ROW_H);

    const cy = rowY + ROW_H / 2 + 4; // text baseline center

    // Hue: low note = blue/purple, high = orange/red
    const hue = maxHz === minHz ? 200 : 260 - ((seg.hz - minHz) / (maxHz - minHz)) * 200;
    const noteColor = `hsl(${hue}, 80%, 65%)`;

    // Row number
    ctx.fillStyle = "#475569"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(`${i + 1}`, COL_NUM / 2, cy);

    // Note name — big & bold
    ctx.fillStyle = noteColor; ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
    ctx.fillText(seg.note, COL_NUM + COL_NOTE / 2, cy);

    // Duration bar (background track)
    const barY = rowY + 8;
    const barH = ROW_H - 16;
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath(); ctx.roundRect(COL_BAR_START + 6, barY, COL_BAR_W - 12, barH, 3); ctx.fill();

    // Duration bar (fill)
    const fillW = Math.max(6, ((seg.dur / maxDur) * (COL_BAR_W - 12)));
    ctx.fillStyle = noteColor;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.roundRect(COL_BAR_START + 6, barY, fillW, barH, 3); ctx.fill();
    ctx.globalAlpha = 1;

    // Duration label inside/beside bar
    const durStr = seg.dur >= 1000
      ? `${(seg.dur / 1000).toFixed(2)}s`
      : `${seg.dur}ms`;
    ctx.fillStyle = fillW > 50 ? "#0f172a" : "#64748b";
    ctx.font = "bold 9px monospace"; ctx.textAlign = fillW > 50 ? "left" : "left";
    ctx.fillText(durStr, COL_BAR_START + 10, cy);

    // Hz value
    ctx.fillStyle = "#1e293b"; ctx.font = "10px monospace"; ctx.textAlign = "right";
    ctx.fillText(`${Math.round(seg.hz)} Hz`, W - COL_DUR_W - 4, cy);

    // Start time
    const tStr = seg.tStart >= 1000
      ? `${(seg.tStart / 1000).toFixed(1)}s`
      : `${Math.round(seg.tStart)}ms`;
    ctx.fillStyle = "#64748b"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(tStr, W - COL_DUR_W / 2, cy);

    // Row separator
    ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(0, rowY + ROW_H); ctx.lineTo(W, rowY + ROW_H); ctx.stroke();
  });

  // Column dividers (subtle)
  ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 0.5;
  for (const x of [COL_NUM, COL_NUM + COL_NOTE, COL_BAR_START + COL_BAR_W]) {
    ctx.beginPath(); ctx.moveTo(x, PAD_TOP); ctx.lineTo(x, H); ctx.stroke();
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function AudioTracker() {
  const [listening, setListening] = useState(false);
  const [note, setNote]     = useState({ note: "-", octave: 0, cents: 0, full: "-" });
  const [hz, setHz]         = useState(0);
  const [db, setDb]         = useState(-96);
  const [amp, setAmp]       = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [noteDur, setNoteDur] = useState(0);
  const [noteName, setNoteName] = useState("-");

  // Refs — everything the animation loop needs (no stale closures)
  const audioCtx  = useRef<AudioContext | null>(null);
  const analyser  = useRef<AnalyserNode | null>(null);
  const stream    = useRef<MediaStream | null>(null);
  const raf       = useRef<number | null>(null);
  const buf       = useRef(new Float32Array(2048));
  const waveBuf   = useRef(new Float32Array(2048));
  const startTs   = useRef(0);
  const activeNote = useRef<{ full: string; hz: number; t0: number } | null>(null);
  const segsRef   = useRef<Seg[]>([]);
  const hzPts     = useRef<Pt[]>([]);
  const dbPts     = useRef<Pt[]>([]);

  const waveRef  = useRef<HTMLCanvasElement>(null);
  const pitchRef = useRef<HTMLCanvasElement>(null);
  const volRef   = useRef<HTMLCanvasElement>(null);
  const barRef   = useRef<HTMLCanvasElement>(null);

  const loop = useCallback(() => {
    if (!analyser.current || !audioCtx.current) return;
    analyser.current.getFloatTimeDomainData(buf.current);
    analyser.current.getFloatTimeDomainData(waveBuf.current);

    // RMS → amplitude & dB
    let rms = 0;
    for (let i = 0; i < buf.current.length; i++) rms += buf.current[i] ** 2;
    rms = Math.sqrt(rms / buf.current.length);
    const dbVal = rmsToDb(rms);
    setAmp(Math.min(rms * 5, 1));
    setDb(Math.round(dbVal * 10) / 10);

    // Pitch
    const freq = autoCorrelate(buf.current, audioCtx.current.sampleRate);
    const hzVal = freq > 0 ? Math.round(freq * 10) / 10 : 0;
    const noteInfo = freqToNote(hzVal);
    setHz(hzVal);
    setNote(noteInfo);

    const now = Date.now() - startTs.current;
    setElapsed(now);

    // Store points for graphs (max 600)
    if (hzVal > 0) hzPts.current.push({ t: now, v: hzVal });
    dbPts.current.push({ t: now, v: dbVal });
    if (hzPts.current.length > 600) hzPts.current = hzPts.current.slice(-600);
    if (dbPts.current.length > 600) dbPts.current = dbPts.current.slice(-600);

    // Note segment tracking
    if (hzVal > 0) {
      if (!activeNote.current) {
        activeNote.current = { full: noteInfo.full, hz: hzVal, t0: now };
        setNoteName(noteInfo.full);
        setNoteDur(0);
      } else if (Math.abs(hzVal - activeNote.current.hz) > 25) {
        // Note changed — commit old
        const dur = now - activeNote.current.t0;
        if (dur > 60) {
          segsRef.current = [...segsRef.current, { note: activeNote.current.full, hz: activeNote.current.hz, tStart: activeNote.current.t0, tEnd: now, dur }].slice(-300);
        }
        activeNote.current = { full: noteInfo.full, hz: hzVal, t0: now };
        setNoteName(noteInfo.full);
        setNoteDur(0);
      } else {
        setNoteDur(now - activeNote.current.t0);
      }
    } else {
      if (activeNote.current) {
        const dur = now - activeNote.current.t0;
        if (dur > 60) {
          segsRef.current = [...segsRef.current, { note: activeNote.current.full, hz: activeNote.current.hz, tStart: activeNote.current.t0, tEnd: now, dur }].slice(-300);
        }
        activeNote.current = null;
        setNoteName("-"); setNoteDur(0);
      }
    }

    // Draw all canvases
    if (waveRef.current) drawWave(waveRef.current, waveBuf.current);

    if (pitchRef.current && hzPts.current.length > 1) {
      const allH = hzPts.current.map(p => p.v);
      const minH = Math.min(...allH) * 0.88, maxH = Math.max(...allH) * 1.12;
      drawLine(pitchRef.current, hzPts.current, "#a78bfa", Math.max(minH, 20), Math.max(maxH, minH + 50), "Hz");
    }

    if (volRef.current) drawLine(volRef.current, dbPts.current, "#22c55e", -80, 0, "dB");

    if (barRef.current) drawBars(barRef.current, segsRef.current, now);

    raf.current = requestAnimationFrame(loop);
  }, []); // stable ref — no stale closures, all state via refs

  const start = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      stream.current = s;
      const ctx = new AudioContext();
      audioCtx.current = ctx;
      const an = ctx.createAnalyser();
      an.fftSize = 2048; analyser.current = an;
      ctx.createMediaStreamSource(s).connect(an);
      startTs.current = Date.now();
      hzPts.current = []; dbPts.current = [];
      segsRef.current = []; activeNote.current = null;
      setNote({ note: "-", octave: 0, cents: 0, full: "-" });
      setHz(0); setDb(-96); setAmp(0); setElapsed(0); setNoteDur(0); setNoteName("-");
      setListening(true);
      raf.current = requestAnimationFrame(loop);
    } catch {
      alert("Microphone access denied. Please allow microphone permission.");
    }
  };

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach(t => t.stop());
    audioCtx.current?.close();
    setListening(false);
    setHz(0); setNote({ note: "-", octave: 0, cents: 0, full: "-" });
    setDb(-96); setAmp(0); setNoteName("-"); setNoteDur(0);
  };

  const clear = () => {
    hzPts.current = []; dbPts.current = [];
    segsRef.current = []; activeNote.current = null;
    startTs.current = Date.now();
    setElapsed(0); setNoteDur(0); setNoteName("-");
    // Clear canvases
    [waveRef, pitchRef, volRef, barRef].forEach(r => {
      if (!r.current) return;
      const ctx = r.current.getContext("2d")!;
      ctx.fillStyle = CHART_BG; ctx.fillRect(0, 0, r.current.width, r.current.height);
    });
    if (barRef.current) drawBars(barRef.current, [], 0);
  };

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach(t => t.stop());
  }, []);

  const durLabel = noteDur >= 1000 ? `${(noteDur / 1000).toFixed(2)}s` : `${noteDur}ms`;
  const noteRows = Math.max(segsRef.current.length, 8);
  const barCanvasHeight = 6 + 22 + noteRows * 28 + 6;

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(180deg, #f8fbff 0%, #edf3ff 46%, #f6f9ff 100%)", color: "#0f172a", fontFamily: "'IBM Plex Mono', 'JetBrains Mono', monospace", padding: 12 }}>
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "18px 14px", borderRadius: 18, border: "1px solid #dbe7f5", background: "rgba(255,255,255,0.88)", boxShadow: "0 16px 34px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.9)", backdropFilter: "blur(6px)" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <div style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 9, letterSpacing: 1, color: "#075985", border: "1px solid #bae6fd", background: "#e0f2fe", marginBottom: 8 }}>
            LIVE ANALYZER
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: "#0f172a", letterSpacing: 1.2, margin: 0 }}>
            MUSIC MASTER AUDIO TRACKER
          </h1>
          <p style={{ color: "#64748b", fontSize: 11, marginTop: 5 }}>
            Real-time · Note · Pitch · Duration · Volume
          </p>
        </div>

        {/* 4 Stat Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginBottom: 12 }}>
          {[
            {
              label: "NOTE",
              main: note.full !== "-" ? note.full : "---",
              sub: note.cents !== 0 && note.note !== "-" ? `${note.cents > 0 ? "+" : ""}${note.cents}¢` : note.note !== "-" ? "in tune" : "—",
              color: "#7c3aed", border: "#ddd6fe",
            },
            {
              label: "PITCH",
              main: hz > 0 ? `${hz}` : "---",
              sub: "Hz",
              color: "#0284c7", border: "#bae6fd",
            },
            {
              label: "DURATION",
              main: noteName !== "-" ? durLabel : "---",
              sub: noteName !== "-" ? noteName : "—",
              color: "#059669", border: "#bbf7d0",
            },
            {
              label: "VOLUME",
              main: db > -96 ? `${db}` : "---",
              sub: "dB",
              color: "#ea580c", border: "#fed7aa",
            },
          ].map(c => (
            <div key={c.label} style={{ background: "linear-gradient(180deg, #ffffff, #f8fafc)", border: `1px solid ${c.border}`, borderRadius: 14, padding: "14px 10px", textAlign: "center", boxShadow: "0 4px 10px rgba(15,23,42,0.05), inset 0 1px 0 rgba(255,255,255,0.9)" }}>
              <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>{c.label}</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: c.color, lineHeight: 1 }}>{c.main}</div>
              <div style={{ fontSize: 9, color: "#64748b", marginTop: 3 }}>{c.sub}</div>
            </div>
          ))}
        </div>

        {/* Amplitude bar */}
        <div style={{ background: "linear-gradient(180deg, #ffffff, #f8fafc)", border: "1px solid #dbe7f5", borderRadius: 10, padding: "7px 12px", marginBottom: 10, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, whiteSpace: "nowrap" }}>AMPLITUDE</span>
          <div style={{ flex: 1, height: 9, background: "#e2e8f0", borderRadius: 999, overflow: "hidden", border: "1px solid #cbd5e1" }}>
            <div style={{
              width: `${amp * 100}%`, height: "100%", borderRadius: 999,
              background: amp > 0.7 ? "#ef4444" : amp > 0.4 ? "#f59e0b" : "#22c55e",
              transition: "width 0.05s, background 0.1s",
            }} />
          </div>
          <span style={{ fontSize: 9, color: "#64748b", width: 30, textAlign: "right" }}>{Math.round(amp * 100)}%</span>
          <span style={{ fontSize: 9, color: "#475569", marginLeft: 6 }}>{(elapsed / 1000).toFixed(1)}s</span>
        </div>

        {/* Waveform */}
        <Card label="LIVE WAVEFORM">
          <canvas ref={waveRef} width={880} height={65}
            style={{ width: "100%", height: 65, borderRadius: 6, display: "block", border: "1px solid #e2e8f0" }} />
        </Card>

        {/* Pitch graph */}
        <Card label="PITCH — Hz over Time">
          <canvas ref={pitchRef} width={880} height={108}
            style={{ width: "100%", height: 108, borderRadius: 6, display: "block", border: "1px solid #e2e8f0" }} />
        </Card>

        {/* Volume graph */}
        <Card label="VOLUME — dB over Time">
          <canvas ref={volRef} width={880} height={90}
            style={{ width: "100%", height: 90, borderRadius: 6, display: "block", border: "1px solid #e2e8f0" }} />
        </Card>

        {/* Note duration bars */}
        <Card label="NOTE DURATION — Each note · Hz · Length">
          <div style={{ maxHeight: 262, overflowY: "auto", borderRadius: 6 }}>
            <canvas ref={barRef} width={880} height={barCanvasHeight}
              style={{ width: "100%", height: barCanvasHeight, borderRadius: 6, display: "block", border: "1px solid #e2e8f0" }} />
          </div>
        </Card>

        {/* Controls */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!listening ? (
            <button onClick={start}
              style={{ flex: 2, minWidth: 220, padding: "13px 0", background: "linear-gradient(135deg,#0891b2,#2563eb)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1, boxShadow: "0 8px 20px rgba(37,99,235,0.32)" }}>
              START LISTENING
            </button>
          ) : (
            <button onClick={stop}
              style={{ flex: 2, minWidth: 220, padding: "13px 0", background: "linear-gradient(135deg,#7f1d1d,#b91c1c)", border: "none", borderRadius: 12, color: "#fff", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1, boxShadow: "0 8px 20px rgba(185,28,28,0.28)" }}>
              STOP
            </button>
          )}
          <button onClick={clear}
            style={{ flex: 1, minWidth: 130, padding: "13px 0", background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: 12, color: "#334155", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, cursor: "pointer" }}>
            CLEAR
          </button>
        </div>

        <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 10, color: "#64748b" }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: listening ? "#22c55e" : "#94a3b8", boxShadow: listening ? "0 0 8px rgba(34,197,94,0.5)" : "none" }} />
          <span>
            {listening
              ? `Listening... ${(elapsed / 1000).toFixed(1)}s · ${segsRef.current.length} notes detected`
              : "Press START LISTENING to begin"}
          </span>
        </div>
      </div>
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "linear-gradient(180deg, #ffffff, #f8fafc)", border: "1px solid #dbe7f5", borderRadius: 12, padding: "10px 12px", marginBottom: 10, boxShadow: "0 4px 10px rgba(15,23,42,0.05), inset 0 1px 0 rgba(255,255,255,0.9)" }}>
      <div style={{ fontSize: 9, color: "#64748b", letterSpacing: 1, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}
