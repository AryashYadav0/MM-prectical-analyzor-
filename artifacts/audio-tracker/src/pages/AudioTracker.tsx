import { useState, useEffect, useRef, useCallback } from "react";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function freqToNote(freq: number): { note: string; octave: number; cents: number } {
  if (freq <= 0) return { note: "-", octave: 0, cents: 0 };
  const A4 = 440;
  const semitones = 12 * Math.log2(freq / A4);
  const rounded = Math.round(semitones);
  const noteIndex = ((rounded % 12) + 12 + 9) % 12;
  const octave = Math.floor((rounded + 9) / 12) + 4;
  const cents = Math.round((semitones - rounded) * 100);
  return { note: NOTE_NAMES[noteIndex], octave, cents };
}

function autoCorrelate(buf: Float32Array, sampleRate: number): number {
  const SIZE = buf.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  let best_offset = -1;
  let best_correlation = 0;
  let rms = 0;

  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

  let lastCorrelation = 1;
  for (let offset = 0; offset < MAX_SAMPLES; offset++) {
    let correlation = 0;
    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += Math.abs(buf[i] - buf[i + offset]);
    }
    correlation = 1 - correlation / MAX_SAMPLES;
    if (correlation > 0.9 && correlation > lastCorrelation) {
      if (correlation > best_correlation) {
        best_correlation = correlation;
        best_offset = offset;
      }
    }
    lastCorrelation = correlation;
  }

  if (best_offset === -1) return -1;
  return sampleRate / best_offset;
}

interface DataPoint {
  time: number;
  hz: number;
  amplitude: number;
}

export default function AudioTracker() {
  const [isListening, setIsListening] = useState(false);
  const [currentHz, setCurrentHz] = useState(0);
  const [currentNote, setCurrentNote] = useState({ note: "-", octave: 0, cents: 0 });
  const [dataPoints, setDataPoints] = useState<DataPoint[]>([]);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [amplitude, setAmplitude] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const bufferRef = useRef<Float32Array>(new Float32Array(2048));
  const timeDataRef = useRef<Float32Array>(new Float32Array(2048));
  const startTsRef = useRef<number>(0);

  const waveCanvasRef = useRef<HTMLCanvasElement>(null);
  const graphCanvasRef = useRef<HTMLCanvasElement>(null);

  const drawWaveform = useCallback((dataArray: Float32Array) => {
    const canvas = waveCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 1.5;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#22d3ee";
    ctx.beginPath();
    const sliceWidth = W / dataArray.length;
    let x = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const v = dataArray[i];
      const y = (v + 1) * H / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, []);

  const drawGraph = useCallback((points: DataPoint[], start: number | null, end: number | null) => {
    const canvas = graphCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, W, H);

    if (points.length < 2) return;

    const maxTime = Math.max(...points.map(p => p.time));
    const minHz = Math.min(...points.filter(p => p.hz > 0).map(p => p.hz)) || 50;
    const maxHz = Math.max(...points.map(p => p.hz)) || 1000;
    const hzRange = Math.max(maxHz - minHz, 50);

    ctx.strokeStyle = "rgba(100,116,139,0.3)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = H * 0.1 + (H * 0.8 * i) / 4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
      const hzLabel = Math.round(maxHz - (hzRange * i) / 4);
      ctx.fillStyle = "#64748b";
      ctx.font = "10px monospace";
      ctx.fillText(`${hzLabel}Hz`, 4, y - 3);
    }

    if (start !== null) {
      const sx = ((start) / maxTime) * W;
      ctx.strokeStyle = "#22c55e";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#22c55e";
      ctx.font = "10px monospace";
      ctx.fillText("START", sx + 4, 14);
    }

    if (end !== null) {
      const ex = ((end) / maxTime) * W;
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(ex, 0);
      ctx.lineTo(ex, H);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ef4444";
      ctx.font = "10px monospace";
      ctx.fillText("END", ex + 4, 28);
    }

    ctx.strokeStyle = "#a78bfa";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 6;
    ctx.shadowColor = "#a78bfa";
    ctx.beginPath();
    let first = true;
    for (const p of points) {
      if (p.hz <= 0) continue;
      const x = (p.time / Math.max(maxTime, 1)) * W;
      const y = H * 0.9 - ((p.hz - minHz) / hzRange) * H * 0.8;
      if (first) { ctx.moveTo(x, y); first = false; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }, []);

  const analyze = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;

    analyser.getFloatTimeDomainData(bufferRef.current);
    analyser.getFloatTimeDomainData(timeDataRef.current);

    let rms = 0;
    for (let i = 0; i < bufferRef.current.length; i++) {
      rms += bufferRef.current[i] * bufferRef.current[i];
    }
    rms = Math.sqrt(rms / bufferRef.current.length);
    setAmplitude(Math.min(rms * 4, 1));

    const freq = autoCorrelate(bufferRef.current, audioCtxRef.current!.sampleRate);
    const hz = freq > 0 ? Math.round(freq * 10) / 10 : 0;
    setCurrentHz(hz);
    setCurrentNote(freqToNote(hz));

    const now = Date.now() - startTsRef.current;
    setElapsedMs(now);

    setDataPoints(prev => {
      const newPoint: DataPoint = { time: now, hz, amplitude: rms };
      const updated = [...prev, newPoint].slice(-500);
      drawGraph(updated, startTime, endTime);
      return updated;
    });

    drawWaveform(timeDataRef.current);

    rafRef.current = requestAnimationFrame(analyze);
  }, [drawWaveform, drawGraph, startTime, endTime]);

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      streamRef.current = stream;
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyserRef.current = analyser;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;
      source.connect(analyser);
      startTsRef.current = Date.now();
      setDataPoints([]);
      setStartTime(null);
      setEndTime(null);
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
    setCurrentHz(0);
    setCurrentNote({ note: "-", octave: 0, cents: 0 });
    setAmplitude(0);
  };

  const markStart = () => {
    const t = elapsedMs;
    setStartTime(t);
  };

  const markEnd = () => {
    const t = elapsedMs;
    setEndTime(t);
  };

  const clearMarkers = () => {
    setStartTime(null);
    setEndTime(null);
  };

  const clearData = () => {
    setDataPoints([]);
    setStartTime(null);
    setEndTime(null);
    setElapsedMs(0);
    startTsRef.current = Date.now();
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    };
  }, []);

  useEffect(() => {
    drawGraph(dataPoints, startTime, endTime);
  }, [startTime, endTime, drawGraph, dataPoints]);

  const filteredPoints = dataPoints.filter(p => {
    if (startTime !== null && p.time < startTime) return false;
    if (endTime !== null && p.time > endTime) return false;
    return true;
  });

  const avgHz = filteredPoints.filter(p => p.hz > 0).length > 0
    ? Math.round(filteredPoints.filter(p => p.hz > 0).reduce((a, b) => a + b.hz, 0) / filteredPoints.filter(p => p.hz > 0).length * 10) / 10
    : 0;

  const maxHzVal = filteredPoints.length > 0 ? Math.max(...filteredPoints.map(p => p.hz)) : 0;
  const minHzVal = filteredPoints.filter(p => p.hz > 0).length > 0
    ? Math.min(...filteredPoints.filter(p => p.hz > 0).map(p => p.hz))
    : 0;

  const duration = startTime !== null && endTime !== null
    ? ((endTime - startTime) / 1000).toFixed(2)
    : null;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0f1a", color: "#e2e8f0", fontFamily: "monospace" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "20px 16px" }}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, color: "#22d3ee", letterSpacing: 2, margin: 0 }}>
            MUSIC MASTER AUDIO TRACKER
          </h1>
          <p style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
            Real-time pitch, Hz & waveform analyzer
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
          <div style={{ background: "#111827", border: "1px solid #1e3a5f", borderRadius: 12, padding: "16px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, letterSpacing: 1 }}>FREQUENCY</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#22d3ee", lineHeight: 1 }}>
              {currentHz > 0 ? currentHz : "---"}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Hz</div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #2d1f5e", borderRadius: 12, padding: "16px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, letterSpacing: 1 }}>MUSICAL NOTE</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#a78bfa", lineHeight: 1 }}>
              {currentNote.note !== "-" ? `${currentNote.note}${currentNote.octave}` : "---"}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
              {currentNote.cents !== 0 ? `${currentNote.cents > 0 ? "+" : ""}${currentNote.cents} cents` : "in tune"}
            </div>
          </div>

          <div style={{ background: "#111827", border: "1px solid #1f3a2d", borderRadius: 12, padding: "16px 12px", textAlign: "center" }}>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, letterSpacing: 1 }}>AMPLITUDE</div>
            <div style={{ height: 40, background: "#0f172a", borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "flex-end" }}>
              <div style={{
                width: `${amplitude * 100}%`,
                height: "100%",
                background: amplitude > 0.7 ? "#ef4444" : amplitude > 0.4 ? "#f59e0b" : "#22c55e",
                borderRadius: 8,
                transition: "width 0.05s, background 0.1s"
              }} />
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{Math.round(amplitude * 100)}%</div>
          </div>
        </div>

        <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, letterSpacing: 1 }}>LIVE WAVEFORM</div>
          <canvas ref={waveCanvasRef} width={860} height={80}
            style={{ width: "100%", height: 80, borderRadius: 8, display: "block" }} />
        </div>

        <div style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, letterSpacing: 1 }}>PITCH GRAPH (Hz over time)</div>
          <canvas ref={graphCanvasRef} width={860} height={160}
            style={{ width: "100%", height: 160, borderRadius: 8, display: "block", cursor: "crosshair" }} />
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={markStart} disabled={!isListening}
              style={{ flex: 1, padding: "8px 0", background: "#14532d", border: "1px solid #22c55e", borderRadius: 8, color: "#22c55e", fontFamily: "monospace", fontSize: 12, cursor: isListening ? "pointer" : "not-allowed", opacity: isListening ? 1 : 0.4 }}>
              Mark START [{startTime !== null ? `${(startTime / 1000).toFixed(2)}s` : "-"}]
            </button>
            <button onClick={markEnd} disabled={!isListening}
              style={{ flex: 1, padding: "8px 0", background: "#450a0a", border: "1px solid #ef4444", borderRadius: 8, color: "#ef4444", fontFamily: "monospace", fontSize: 12, cursor: isListening ? "pointer" : "not-allowed", opacity: isListening ? 1 : 0.4 }}>
              Mark END [{endTime !== null ? `${(endTime / 1000).toFixed(2)}s` : "-"}]
            </button>
            <button onClick={clearMarkers}
              style={{ flex: 1, padding: "8px 0", background: "#1e293b", border: "1px solid #475569", borderRadius: 8, color: "#94a3b8", fontFamily: "monospace", fontSize: 12, cursor: "pointer" }}>
              Clear Markers
            </button>
          </div>
        </div>

        {(startTime !== null || endTime !== null) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
            {[
              { label: "AVG Hz", value: avgHz > 0 ? `${avgHz} Hz` : "---" },
              { label: "MIN Hz", value: minHzVal > 0 ? `${minHzVal.toFixed(1)} Hz` : "---" },
              { label: "MAX Hz", value: maxHzVal > 0 ? `${maxHzVal.toFixed(1)} Hz` : "---" },
              { label: "DURATION", value: duration !== null ? `${duration}s` : "---" },
            ].map(item => (
              <div key={item.label} style={{ background: "#111827", border: "1px solid #1e2d40", borderRadius: 10, padding: "12px 8px", textAlign: "center" }}>
                <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1 }}>{item.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#f8fafc", marginTop: 4 }}>{item.value}</div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!isListening ? (
            <button onClick={startListening}
              style={{ flex: 2, minWidth: 160, padding: "14px 0", background: "linear-gradient(135deg,#0e7490,#1d4ed8)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              START LISTENING
            </button>
          ) : (
            <button onClick={stopListening}
              style={{ flex: 2, minWidth: 160, padding: "14px 0", background: "linear-gradient(135deg,#7f1d1d,#991b1b)", border: "none", borderRadius: 10, color: "#fff", fontFamily: "monospace", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 1 }}>
              STOP
            </button>
          )}
          <button onClick={clearData}
            style={{ flex: 1, minWidth: 100, padding: "14px 0", background: "#1e293b", border: "1px solid #334155", borderRadius: 10, color: "#94a3b8", fontFamily: "monospace", fontSize: 13, cursor: "pointer" }}>
            CLEAR DATA
          </button>
        </div>

        <div style={{ marginTop: 12, textAlign: "center", fontSize: 11, color: "#334155" }}>
          {isListening
            ? `Recording... ${(elapsedMs / 1000).toFixed(1)}s — ${dataPoints.length} samples`
            : "Press START to begin audio analysis"}
        </div>
      </div>
    </div>
  );
}
