import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import DeviceCard from '../components/DeviceCard.jsx';

const INSTRUCTIONS = [
  'Copy this whole project folder to the machine you want to control.',
  'Run: npm install (once)',
  'Run: npm run pair -- --code <code> — the agent starts and appears below.',
  'Set ACCESS_MODE=approve in agent/.env if you want a consent prompt on that machine.',
];

export default function Dashboard() {
  const navigate = useNavigate();
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pair, setPair] = useState(null); // { code, ttlMinutes }
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [connectId, setConnectId] = useState('');
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api('/devices');
      setDevices(data.devices);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);

  async function generateCode() {
    setCreating(true);
    setError('');
    try {
      const data = await api('/devices/enroll-codes', { method: 'POST' });
      setPair(data);
      setCopied(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function connectById(e) {
    e.preventDefault();
    // Device IDs are shown on each card with spaces (e.g. "188 650 548 857");
    // strip everything that is not a digit so a pasted code always matches.
    const id = connectId.replace(/\D/g, '');
    if (!id) {
      setError('Enter a device ID to connect.');
      return;
    }
    setConnecting(true);
    setError('');
    try {
      const { device } = await api(`/devices/${id}`);
      if (device.status !== 'online') {
        setError(`"${device.name}" is offline. Start the agent on that machine, then try again.`);
        return;
      }
      navigate(`/device/${device.deviceId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setConnecting(false);
    }
  }

  async function removeDevice(device) {
    if (!window.confirm(`Remove "${device.name}"? Its agent token is revoked.`)) return;
    try {
      await api(`/devices/${device.id}`, { method: 'DELETE' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function changeAccess(device, accessMode) {
    setDevices((prev) =>
      prev.map((d) => (d.id === device.id ? { ...d, accessMode } : d))
    );
    try {
      await api(`/devices/${device.id}`, { method: 'PATCH', body: { accessMode } });
    } catch (err) {
      setError(err.message);
      load();
    }
  }

  const onlineCount = devices.filter((d) => d.status === 'online').length;

  return (
    <div className="dashboard">
      <div className="dash-head">
        <div>
          <h1>Your devices</h1>
          <p className="muted">
            {devices.length} enrolled · {onlineCount} online
          </p>
        </div>
        <button className="btn btn-primary" onClick={generateCode} disabled={creating}>
          {creating ? 'Generating…' : 'Add device'}
        </button>
      </div>

      {error && <div className="alert">{error}</div>}

      <form className="card connect-card" onSubmit={connectById}>
        <div className="connect-copy">
          <h2>Connect to a device</h2>
          <p className="muted">
            Type the device ID shown on its card, then press Connect.
          </p>
        </div>
        <div className="connect-row">
          <input
            className="connect-input"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="188 650 548 857"
            aria-label="Device ID"
            value={connectId}
            onChange={(e) => {
              setConnectId(e.target.value);
              if (error) setError('');
            }}
          />
          <button className="btn btn-primary" type="submit" disabled={connecting || !connectId.trim()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>

      {pair && (
        <div className="card pair-card">
          <div className="pair-head">
            <h2>Pair a new machine</h2>
            <button className="btn btn-ghost" onClick={() => setPair(null)}>
              ✕
            </button>
          </div>
          <div className="pair-code-row">
            <code className="pair-code">{pair.code}</code>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(pair.code);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                } catch {
                  /* clipboard denied */
                }
              }}
            >
              {copied ? 'Copied ✓' : 'Copy code'}
            </button>
          </div>
          <p className="muted">Valid for {pair.ttlMinutes} minutes, single use.</p>
          <ol className="pair-steps">
            {INSTRUCTIONS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      )}

      {loading ? (
        <div className="splash">
          <div className="spinner" />
        </div>
      ) : devices.length === 0 ? (
        <div className="card empty">
          <h3>No devices yet</h3>
          <p className="muted">
            Click <strong>Add device</strong> to generate a pairing code, then run the
            agent on the machine you want to access.
          </p>
        </div>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onDelete={removeDevice}
              onAccessChange={changeAccess}
            />
          ))}
        </div>
      )}
    </div>
  );
}
