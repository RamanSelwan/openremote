import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function timeAgo(date) {
  if (!date) return 'never';
  const s = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function CopyableId({ value }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-id"
      title="Copy device ID"
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value.replace(/ /g, ''));
        } catch {
          /* clipboard denied */
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {value} <span className="copy-hint">{copied ? 'copied ✓' : 'copy'}</span>
    </button>
  );
}

export default function DeviceCard({ device, onDelete, onAccessChange }) {
  const navigate = useNavigate();
  const online = device.status === 'online';
  const caps = device.capabilities || {};

  return (
    <article className={`card device-card ${online ? 'is-online' : ''}`}>
      <div className="device-head">
        <div className="device-title">
          <span className={`dot ${online ? 'dot-on' : 'dot-off'}`} />
          <h3>{device.name}</h3>
        </div>
        <span className={`badge ${online ? 'badge-on' : 'badge-off'}`}>
          {online ? 'online' : `offline · ${timeAgo(device.lastSeen)}`}
        </span>
      </div>

      <CopyableId value={device.deviceId} />

      <div className="device-meta">
        {device.os && <span>{device.os}</span>}
        {device.hostname && <span>{device.hostname}</span>}
        {caps.agentVersion && <span>agent v{caps.agentVersion}</span>}
      </div>

      <div className="chip-row">
        <span className={`chip ${caps.canCapture ? 'chip-on' : ''}`}>
          view: {caps.captureDriver || 'n/a'}
        </span>
        <span className={`chip ${caps.canControl ? 'chip-on' : ''}`}>
          control: {caps.controlDriver || 'n/a'}
        </span>
        {caps.width > 0 && (
          <span className="chip">
            {caps.width}×{caps.height}
          </span>
        )}
      </div>

      <div className="device-actions">
        <button className="btn btn-primary" onClick={() => navigate(`/device/${device.deviceId}`)}>
          Connect
        </button>
        <label className="access-label">
          access
          <select
            value={device.accessMode}
            onChange={(e) => onAccessChange(device, e.target.value)}
          >
            <option value="approve">ask on device</option>
            <option value="open">open</option>
          </select>
        </label>
        <button className="btn btn-danger-ghost" title="Remove device" onClick={() => onDelete(device)}>
          Remove
        </button>
      </div>
    </article>
  );
}
