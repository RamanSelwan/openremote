import React, { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { getToken } from '../lib/api.js';
import { SERVER_URL } from '../lib/endpoints.js';

const PRESETS = {
  sharp: { label: 'Sharp', fps: 20, scale: 0.9, quality: 68 },
  balanced: { label: 'Balanced', fps: 15, scale: 0.65, quality: 55 },
  fast: { label: 'Fast', fps: 10, scale: 0.45, quality: 42 },
};

const PING_INTERVAL_MS = 2000;
// The agent reports pipeline timings every 5 s, so wait longer than that
// before re-tuning: decisions must be based on post-change measurements.
const ADJUST_COOLDOWN_MS = 6000;

const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);

export default function RemoteView() {
  const { deviceId } = useParams();

  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const cursorRef = useRef(null);
  const socketRef = useRef(null);
  const agentStats = useRef({ captureMs: 0, encodeMs: 0 });
  const agentStatsAt = useRef(0);

  const presetRef = useRef('balanced');
  const autoRef = useRef(true);
  const statusRef = useRef('connecting');
  const tuningRef = useRef({ ...PRESETS.balanced });
  const lastAdjustRef = useRef(0);
  const lastFpsRef = useRef(0);
  const rttSamples = useRef([]);
  const clockOffset = useRef(0);
  const lagSamples = useRef([]);

  // The newest decoded-later frame only: bursts never queue up, and the
  // decode/draw loop always paints the freshest picture.
  const latestFrame = useRef(null);
  const drawing = useRef(false);

  const counters = useRef({ frames: 0, bytes: 0, last: Date.now() });
  const sizeRef = useRef('—');

  const [status, setStatus] = useState('connecting'); // connecting|pending|granted|denied|offline|error
  const [statusDetail, setStatusDetail] = useState('');
  const [device, setDevice] = useState(null);
  const [preset, setPreset] = useState('balanced');
  const [auto, setAuto] = useState(true);
  const [stats, setStats] = useState({ fps: 0, kbps: 0, rtt: 0, lag: 0, pipe: 0, size: '—' });
  const [canControl, setCanControl] = useState(true);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    autoRef.current = auto;
  }, [auto]);

  const emitTuning = (settings) => {
    socketRef.current?.emit('viewer:control', settings);
  };

  /* ------------------------------------------------------------------ socket */
  useEffect(() => {
    const socket = io(SERVER_URL, {
      auth: { token: getToken() },
      transports: ['websocket', 'polling'],
      reconnectionDelayMax: 5000,
      timeout: 10000,
    });
    socketRef.current = socket;

    const join = () => {
      socket.emit('viewer:join', { deviceId }, (ack) => {
        if (!ack?.ok) {
          setStatus('error');
          setStatusDetail(ack?.error || 'failed to join');
          return;
        }
        setDevice(ack.device);
        setCanControl(ack.device?.capabilities?.canControl !== false);
        if (!ack.online) {
          setStatus('offline');
          setStatusDetail('The agent on that machine is not running.');
        }
      });
    };

    socket.on('connect', join);
    socket.on('session:state', (state) => {
      if (state.state === 'granted') {
        setStatus('granted');
        setStatusDetail('');
        lastAdjustRef.current = 0;
        rttSamples.current = [];
        lagSamples.current = [];
        socket.emit('viewer:control', tuningRef.current);
        socket.emit('viewer:ping', { t: Date.now() });
      } else if (state.state === 'pending') {
        setStatus('pending');
      } else if (state.state === 'denied') {
        setStatus('denied');
        setStatusDetail(state.reason || 'The remote user declined.');
      }
    });
    socket.on('agent:offline', () => {
      setStatus('offline');
      setStatusDetail('The agent went offline.');
    });
    socket.on('disconnect', () => {
      setStatus((s) => (s === 'offline' ? s : 'connecting'));
    });

    socket.on('stream:stats', (payload) => {
      if (!payload || !payload.encoded) return; // idle window, no real timing
      agentStats.current = payload;
      agentStatsAt.current = Date.now();
    });

    socket.on('pong', (payload) => {
      const now = Date.now();
      const sentAt = Number(payload?.t || 0);
      const rtt = now - sentAt;
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10000) return;
      rttSamples.current.push(rtt);
      if (rttSamples.current.length > 5) rttSamples.current.shift();
      // Agent clock - viewer clock, estimated from the agent's echo time.
      if (payload?.srv) {
        const offset = Number(payload.srv) - (sentAt + rtt / 2);
        clockOffset.current = clockOffset.current
          ? clockOffset.current * 0.7 + offset * 0.3
          : offset;
      }
    });

    /* ---------------------------------------------------------------- frames */
    socket.on('frame', (meta, buf) => {
      if (!buf) return;
      const c = counters.current;
      c.frames += 1;
      c.bytes += buf.byteLength ?? buf.length ?? 0;
      if (meta?.width && meta?.height) sizeRef.current = `${meta.width}×${meta.height}`;
      if (meta?.ts) {
        const age = Date.now() - (Number(meta.ts) - clockOffset.current);
        if (age >= 0 && age < 10000) {
          lagSamples.current.push(age);
          if (lagSamples.current.length > 10) lagSamples.current.shift();
        }
      }
      latestFrame.current = { meta, buf };
    });

    /* ------------------------------------------------------- decode/draw loop */
    let running = true;
    let raf = 0;
    const paint = async () => {
      if (!running) return;
      const next = latestFrame.current;
      if (next && !drawing.current) {
        latestFrame.current = null;
        drawing.current = true;
        try {
          const blob = new Blob([next.buf], { type: 'image/jpeg' });
          const bitmap = await createImageBitmap(blob);
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
            ctx.drawImage(bitmap, 0, 0);
            if (ctx.imageSmoothingEnabled === false) ctx.imageSmoothingEnabled = true;
          }
          bitmap.close?.();
        } catch {
          /* corrupted frame - the next one replaces it anyway */
        } finally {
          drawing.current = false;
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    /* ------------------------------------------------------------ ping + tune */
    const ping = setInterval(() => {
      if (socket.connected && statusRef.current === 'granted') {
        socket.emit('viewer:ping', { t: Date.now() });
      }
    }, PING_INTERVAL_MS);

    const statsTimer = setInterval(() => {
      const c = counters.current;
      const secs = (Date.now() - c.last) / 1000;
      if (secs <= 0) return;
      const fps = Math.round((c.frames / secs) * 10) / 10;
      const kbps = Math.round((c.bytes / secs / 1024) * 10) / 10;
      c.frames = 0;
      c.bytes = 0;
      c.last = Date.now();
      lastFpsRef.current = fps;
      const rtt = Math.round(avg(rttSamples.current));
      const load = agentStats.current;
      const lag = Math.round(avg(lagSamples.current)) || rtt;
      setStats({
        fps,
        kbps,
        rtt,
        lag,
        pipe: Math.round((load.captureMs || 0) + (load.encodeMs || 0)),
        size: sizeRef.current,
      });

      /* Adaptive quality: trade resolution for latency only when the machine or
         the link actually struggles, and climb back when there is headroom.
         Agent-reported capture+encode cost is the honest load signal: a static
         screen legitimately sends few frames, so received fps alone misleads. */
      if (!autoRef.current || statusRef.current !== 'granted') return;
      const now = Date.now();
      if (now - agentStatsAt.current > 8000) return; // no fresh measurements
      if (now - lastAdjustRef.current < ADJUST_COOLDOWN_MS) return;

      const target = PRESETS[presetRef.current];
      const t = tuningRef.current;
      const captureMs = load.captureMs || 0;
      const encodeMs = load.encodeMs || 0;
      const pipelineMs = captureMs + encodeMs;
      const frameBudget = 1000 / target.fps;
      const feasibleFps = pipelineMs > 0 ? 1000 / pipelineMs : target.fps;
      const slowLink = rtt > 260;
      const tooSlow = pipelineMs > 0 && feasibleFps < target.fps * 0.75;

      let next = null;
      if (slowLink || tooSlow) {
        next = {
          fps: Math.max(5, Math.min(t.fps, Math.round(feasibleFps * 0.9))),
          scale: Math.max(0.35, Math.round(t.scale * 0.85 * 100) / 100),
          quality: Math.max(30, t.quality - 7),
        };
      } else if (rtt > 0 && rtt < 150 && encodeMs > 0 && encodeMs < frameBudget * 0.5) {
        next = {
          fps: Math.min(target.fps, t.fps + 2),
          scale: Math.min(target.scale, Math.round(t.scale * 1.06 * 100) / 100),
          quality: Math.min(target.quality, t.quality + 3),
        };
      }
      if (!next) return;
      if (next.fps === t.fps && next.scale === t.scale && next.quality === t.quality) return;
      tuningRef.current = next;
      lastAdjustRef.current = now;
      emitTuning(next);
    }, 1000);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      clearInterval(ping);
      clearInterval(statsTimer);
      socket.emit('viewer:leave');
      socket.close();
    };
  }, [deviceId]);

  /* ----------------------------------------------------------------- presets */
  useEffect(() => {
    presetRef.current = preset;
    tuningRef.current = { ...PRESETS[preset] };
    lastAdjustRef.current = 0;
    if (statusRef.current === 'granted') emitTuning(tuningRef.current);
  }, [preset]);

  /* ------------------------------------------------------------ remote input */
  const lastMove = useRef(0);
  const pendingMove = useRef(null);
  const moveFrame = useRef(0);

  const normFromEvent = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x, y };
  };

  const inputReady = () => statusRef.current === 'granted' && canControl;
  const send = (payload, volatile = false) => {
    const socket = socketRef.current;
    if (!socket) return;
    if (volatile) socket.volatile.emit('input', payload);
    else socket.emit('input', payload);
  };

  /**
   * Mouse moves are coalesced onto animation frames: at most one event per
   * repaint, always carrying the newest position. Stale intermediate
   * positions have no value and only add network latency.
   */
  /** Local cursor: the OS cursor is not part of a GDI screen capture, so the
   *  viewer draws one instantly at the pointer position. Without it the remote
   *  cursor appears frozen even when frames arrive on time. */
  const moveCursor = (e) => {
    const stage = stageRef.current;
    const cursor = cursorRef.current;
    if (!stage || !cursor) return;
    const rect = stage.getBoundingClientRect();
    cursor.style.transform = `translate3d(${Math.round(e.clientX - rect.left)}px, ${Math.round(
      e.clientY - rect.top
    )}px, 0)`;
    cursor.style.opacity = inputReady() ? '1' : '0';
  };

  const hideCursor = () => {
    if (cursorRef.current) cursorRef.current.style.opacity = '0';
  };

  const onMouseMove = (e) => {
    moveCursor(e);
    const point = normFromEvent(e);
    if (!point) return;
    pendingMove.current = point;
    if (!inputReady()) return;
    const now = performance.now();
    if (now - lastMove.current < 12) return;
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const p = pendingMove.current;
      if (!p) return;
      lastMove.current = performance.now();
      send({ type: 'mousemove', ...p }, true);
    });
  };

  const onMouseDown = (e) => {
    if (!inputReady()) return;
    e.preventDefault();
    const p = normFromEvent(e);
    if (p) send({ type: 'mousedown', ...p, button: e.button });
  };
  const onMouseUp = (e) => {
    if (!inputReady()) return;
    const p = normFromEvent(e);
    if (p) send({ type: 'mouseup', ...p, button: e.button });
  };
  const onWheel = (e) => {
    if (!inputReady()) return;
    e.preventDefault();
    const p = normFromEvent(e);
    if (p) send({ type: 'wheel', ...p, deltaX: e.deltaX, deltaY: e.deltaY }, true);
  };

  const onKeyDown = (e) => {
    if (!inputReady()) return;
    e.preventDefault();
    send({
      type: 'keydown',
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
  };
  const onKeyUp = (e) => {
    if (!inputReady()) return;
    e.preventDefault();
    send({
      type: 'keyup',
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    });
  };

  const sendClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      socketRef.current?.emit('viewer:control', { type: 'clipboard', text });
      setStatusDetail('Clipboard sent to the remote machine.');
      setTimeout(() => setStatusDetail(''), 2500);
    } catch {
      setStatusDetail('Clipboard permission denied by the browser.');
      setTimeout(() => setStatusDetail(''), 2500);
    }
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  const reconnect = () => {
    setStatus('connecting');
    socketRef.current?.emit('viewer:join', { deviceId }, (ack) => {
      if (ack?.ok && !ack.online) {
        setStatus('offline');
        setStatusDetail('The agent on that machine is not running.');
      }
    });
  };

  /* ------------------------------------------------------------------ render */
  const banner = {
    connecting: ['Connecting to relay…', ''],
    pending: ['Waiting for approval on the remote machine…', 'The person at that PC must accept.'],
    denied: ['Access denied', statusDetail],
    offline: ['Agent offline', statusDetail || 'Start the agent on the remote machine.'],
    error: ['Connection failed', statusDetail],
  }[status];

  return (
    <div className="remote">
      <div className="remote-head">
        <div className="remote-title">
          <Link to="/" className="btn btn-ghost">
            ← Devices
          </Link>
          <div>
            <h1>{device?.name || deviceId}</h1>
            <p className="muted mono">{device?.deviceId || deviceId}</p>
          </div>
          <span
            className={`badge ${
              status === 'granted'
                ? 'badge-on'
                : status === 'denied'
                  ? 'badge-danger'
                  : 'badge-off'
            }`}
          >
            {status === 'granted' ? 'live' : status}
          </span>
        </div>

        <div className="remote-tools">
          <label className="tool">
            quality
            <select value={preset} onChange={(e) => setPreset(e.target.value)}>
              {Object.entries(PRESETS).map(([key, p]) => (
                <option key={key} value={key}>
                  {p.label} ({p.fps}fps)
                </option>
              ))}
            </select>
          </label>
          <label className="tool tool-check" title="Lower resolution/fps automatically when the link is slow">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => {
                setAuto(e.target.checked);
                if (e.target.checked) {
                  tuningRef.current = { ...PRESETS[presetRef.current] };
                  lastAdjustRef.current = 0;
                }
              }}
            />
            auto
          </label>
          <button className="btn" onClick={sendClipboard} title="Push your clipboard to the remote PC">
            Clipboard →
          </button>
          <button className="btn" onClick={toggleFullscreen}>
            Fullscreen
          </button>
        </div>
      </div>

      <div className="stats-bar">
        <span>
          <b>{stats.fps}</b> fps
        </span>
        <span>
          <b>{stats.kbps}</b> KiB/s
        </span>
        <span title="Age of the frame on screen: capture + encode + network + decode">
          <b>{stats.lag}</b> ms lag
        </span>
        <span title="Time the agent spends capturing + encoding each frame">
          <b>{stats.pipe}</b> ms frame
        </span>
        <span className="mono">{stats.size}</span>
        {!canControl && <span className="badge badge-off">view only</span>}
        {statusDetail && <span className="status-detail">{statusDetail}</span>}
      </div>

      <div
        className={`stage ${status === 'granted' && canControl ? 'controlling' : ''}`}
        ref={stageRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={(e) => e.currentTarget.focus()}
      >
        <canvas
          ref={canvasRef}
          className="viewer-canvas"
          onMouseMove={onMouseMove}
          onMouseEnter={moveCursor}
          onMouseLeave={hideCursor}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onContextMenu={(e) => e.preventDefault()}
          onDoubleClick={(e) => e.preventDefault()}
          onWheel={onWheel}
        />

        <span className="remote-cursor" ref={cursorRef} aria-hidden="true" />

        {banner && (
          <div className={`stage-overlay ${status === 'granted' ? 'hidden' : ''}`}>
            <div className="overlay-box">
              {status === 'connecting' || status === 'pending' ? (
                <div className="spinner" />
              ) : (
                <span className="overlay-icon">⚠</span>
              )}
              <h3>{banner[0]}</h3>
              {banner[1] && <p className="muted">{banner[1]}</p>}
              {(status === 'offline' || status === 'error') && (
                <button className="btn btn-primary" onClick={reconnect}>
                  Retry
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <p className="muted remote-hint">
        Click the screen for keyboard focus · Esc and browser shortcuts stay local ·
        coordinates are normalized, so any resolution works
      </p>
    </div>
  );
}
