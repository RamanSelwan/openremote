import Device from '../models/Device.js';
import Session from '../models/Session.js';
import { sha256, verifyToken } from '../utils/tokens.js';

/**
 * Realtime hub.
 *
 * Agent sockets authenticate with a device token, viewer sockets with a user JWT.
 *
 * Rooms:
 *   agent:<deviceId>  - the one live agent socket for a device
 *   viewer:<deviceId> - viewer sockets currently GRANTED a session
 *
 * Events (agent -> server):  agent:hello, heartbeat, frame, session:decision,
 *                            rtc:answer, rtc:ice
 * Events (viewer -> server): viewer:join, input, viewer:control, viewer:leave,
 *                            rtc:offer, rtc:ice
 * Events (server -> both):   session:state, session:request, stream:start/stop,
 *                            input, frame, agent:online/offline, devices:changed,
 *                            rtc:offer/answer/ice
 */
export function initSocket(io) {
  /** deviceId -> socket.id of the live agent */
  const agents = new Map();
  /** deviceId -> Map<viewerSocketId, {granted, session, frames, bytes}> */
  const rooms = new Map();
  /** deviceId -> live agent metadata reported at hello/heartbeat */
  const agentInfo = new Map();

  io.use(async (socket, next) => {
    const auth = socket.handshake.auth || {};
    try {
      if (auth.deviceToken) {
        const device = await Device.findOne({ tokenHash: sha256(auth.deviceToken) }).select(
          '+tokenHash'
        );
        if (!device) return next(new Error('unauthorized: unknown device token'));
        socket.data.role = 'agent';
        socket.data.device = device;
        return next();
      }
      if (auth.token) {
        const payload = verifyToken(auth.token);
        socket.data.role = 'viewer';
        socket.data.userId = payload.sub;
        socket.data.userRole = payload.role;
        socket.data.userName = payload.name;
        return next();
      }
      return next(new Error('unauthorized: no credentials'));
    } catch {
      return next(new Error('unauthorized: invalid credentials'));
    }
  });

  io.on('connection', (socket) => {
    if (socket.data.role === 'agent') handleAgent(socket);
    else handleViewer(socket);
  });

  const roomOf = (deviceId) => rooms.get(deviceId);
  const viewerRoom = (deviceId) => `viewer:${deviceId}`;
  const agentRoom = (deviceId) => `agent:${deviceId}`;

  function grantedCount(deviceId) {
    const room = roomOf(deviceId);
    if (!room) return 0;
    let n = 0;
    for (const entry of room.values()) if (entry.granted) n += 1;
    return n;
  }

  function broadcastDevicesChanged() {
    io.emit('devices:changed');
  }

  async function closeEntry(deviceId, socketId, reason) {
    const room = roomOf(deviceId);
    const entry = room?.get(socketId);
    if (!entry) return;
    room.delete(socketId);
    if (entry.session) {
      entry.session.frames = entry.frames;
      entry.session.bytes = entry.bytes;
      entry.session.endedAt = new Date();
      entry.session.endedReason = reason;
      await entry.session.save().catch(() => {});
    }
    if (entry.granted && grantedCount(deviceId) === 0) {
      io.to(agentRoom(deviceId)).emit('stream:stop');
    }
    if (room && room.size === 0) rooms.delete(deviceId);
  }

  function grant(deviceId, socket) {
    const entry = roomOf(deviceId)?.get(socket.id);
    if (!entry || entry.granted) return;
    entry.granted = true;
    socket.join(viewerRoom(deviceId));
    socket.emit('session:state', { state: 'granted' });
    Session.create({ device: entry.deviceOid, viewer: entry.userId })
      .then((doc) => {
        entry.session = doc;
      })
      .catch(() => {});
    if (grantedCount(deviceId) === 1) {
      // No explicit config: the agent starts with its own defaults and the
      // viewer immediately follows up with a preset it can adapt.
      io.to(agentRoom(deviceId)).emit('stream:start', {});
    }
  }

  /* ------------------------------------------------------------------ agent */

  function handleAgent(socket) {
    const device = socket.data.device;

    socket.on('agent:hello', async (payload = {}, ack) => {
      try {
        device.capabilities = {
          ...device.capabilities.toObject?.() ?? device.capabilities,
          ...(payload.capabilities || {}),
        };
        device.status = 'online';
        device.lastSeen = new Date();
        device.lastIp = socket.handshake.address || '';
        if (typeof payload.name === 'string' && payload.name.trim()) {
          device.name = payload.name.trim().slice(0, 80);
        }
        await device.save();

        agents.set(device.deviceId, socket.id);
        agentInfo.set(device.deviceId, {
          agentVersion: payload.capabilities?.agentVersion || '',
          capabilities: payload.capabilities || {},
        });
        socket.join(agentRoom(device.deviceId));

        ack?.({ ok: true, deviceId: device.deviceId, accessMode: device.accessMode });
        socket.broadcast.emit('devices:changed');
        io.emit('agent:online', { deviceId: device.deviceId });
      } catch (err) {
        ack?.({ ok: false, error: String(err.message || err) });
      }
    });

    socket.on('heartbeat', async (payload = {}, ack) => {
      device.lastSeen = new Date();
      if (payload.capabilities) {
        device.capabilities = {
          ...device.capabilities.toObject?.() ?? device.capabilities,
          ...payload.capabilities,
        };
      }
      device.save().catch(() => {});
      agentInfo.set(device.deviceId, {
        ...(agentInfo.get(device.deviceId) || {}),
        capabilities: payload.capabilities || agentInfo.get(device.deviceId)?.capabilities || {},
      });
      ack?.({ ok: true, serverTime: Date.now() });
    });

    socket.on('frame', (meta, buf) => {
      const deviceId = device.deviceId;
      const room = roomOf(deviceId);
      if (!room || room.size === 0) return;
      const bytes = toBuffer(buf);
      if (!bytes) return;
      const size = { width: meta?.width || 0, height: meta?.height || 0 };
      for (const entry of room.values()) {
        if (!entry.granted) continue;
        entry.frames += 1;
        entry.bytes += bytes.length;
      }
      io.to(viewerRoom(deviceId)).volatile.emit('frame', {
        seq: meta?.seq || 0,
        ts: meta?.ts || Date.now(),
        ...size,
        deviceId,
      }, bytes);
    });

    socket.on('session:decision', (payload = {}) => {
      const viewerSid = payload.viewerSid;
      const target = io.sockets.sockets.get(viewerSid);
      if (!target) return;
      if (payload.granted) {
        grant(device.deviceId, target);
      } else {
        target.emit('session:state', {
          state: 'denied',
          reason: payload.reason || 'rejected on the remote machine',
        });
      }
    });

    // Agent-side pipeline timings drive the viewer's adaptive quality: they
    // say how expensive frames really are, independent of a static screen.
    socket.on('stream:stats', (payload = {}) => {
      io.to(viewerRoom(device.deviceId)).emit('stream:stats', {
        encoded: Number(payload.encoded) || 0,
        fps: Number(payload.fps) || 0,
        kbps: Number(payload.kbps) || 0,
        captureMs: Number(payload.captureMs) || 0,
        encodeMs: Number(payload.encodeMs) || 0,
        scale: Number(payload.scale) || 0,
        quality: Number(payload.quality) || 0,
      });
    });

    // Latency probe: viewer timestamp is echoed by the agent, so the measured
    // round trip covers the full browser -> server -> agent path.
    socket.on('pong', (payload = {}) => {
      if (!payload.sid) return;
      io.sockets.sockets.get(payload.sid)?.emit('pong', { t: payload.t, srv: payload.srv });
    });

    // WebRTC signaling pass-through (upgrade path from the frame relay).
    socket.on('rtc:answer', (payload = {}) => {
      io.sockets.sockets.get(payload.to)?.emit('rtc:answer', {
        from: socket.id,
        sdp: payload.sdp,
      });
    });
    socket.on('rtc:ice', (payload = {}) => {
      io.sockets.sockets.get(payload.to)?.emit('rtc:ice', {
        from: socket.id,
        candidate: payload.candidate,
      });
    });

    socket.on('disconnect', async () => {
      if (agents.get(device.deviceId) !== socket.id) return;
      agents.delete(device.deviceId);
      agentInfo.delete(device.deviceId);

      device.status = 'offline';
      device.lastSeen = new Date();
      await device.save().catch(() => {});

      broadcastDevicesChanged();
      io.emit('agent:offline', { deviceId: device.deviceId });
      io.to(viewerRoom(device.deviceId)).emit('agent:offline', {
        deviceId: device.deviceId,
      });

      // Drop every open viewer session for this device.
      const room = roomOf(device.deviceId);
      if (room) {
        for (const sid of [...room.keys()]) {
          await closeEntry(device.deviceId, sid, 'agent-offline');
        }
        rooms.delete(device.deviceId);
      }
    });
  }

  /* ------------------------------------------------------------------ viewer */

  function handleViewer(socket) {
    socket.on('viewer:join', async (payload = {}, ack) => {
      try {
        const raw = String(payload.deviceId || '').trim();
        const deviceId = raw.replace(/\s+/g, '');
        const device =
          (await Device.findOne({ deviceIdKey: deviceId })) ||
          (await Device.findOne({ deviceId: raw }));
        if (!device) return ack?.({ ok: false, error: 'device not found' });

        const owns =
          device.owner.toString() === socket.data.userId || socket.data.userRole === 'admin';
        if (!owns) return ack?.({ ok: false, error: 'this device belongs to another account' });

        const online = agents.has(device.deviceId);
        let room = rooms.get(device.deviceId);
        if (!room) {
          room = new Map();
          rooms.set(device.deviceId, room);
        }
        room.set(socket.id, {
          granted: false,
          session: null,
          frames: 0,
          bytes: 0,
          userId: socket.data.userId,
          deviceOid: device._id,
        });
        socket.data.deviceId = device.deviceId;

        ack?.({
          ok: true,
          online,
          accessMode: device.accessMode,
          device: device.toSafeJSON(),
        });

        if (!online) return;
        if (device.accessMode === 'open') {
          queueMicrotask(() => grant(device.deviceId, socket));
        } else {
          queueMicrotask(() => {
            io.to(agentRoom(device.deviceId)).emit('session:request', {
              viewerSid: socket.id,
              viewer: socket.data.userName || 'someone',
            });
            socket.emit('session:state', { state: 'pending' });
          });
        }
      } catch (err) {
        ack?.({ ok: false, error: String(err.message || err) });
      }
    });

    socket.on('input', (payload) => {
      const deviceId = socket.data.deviceId;
      if (!deviceId) return;
      const entry = roomOf(deviceId)?.get(socket.id);
      if (!entry?.granted) return;
      if (!allowInput(socket)) return;
      io.to(agentRoom(deviceId)).emit('input', payload);
    });

    socket.on('viewer:control', (payload = {}) => {
      const deviceId = socket.data.deviceId;
      if (!deviceId) return;
      const entry = roomOf(deviceId)?.get(socket.id);
      if (!entry?.granted) return;
      io.to(agentRoom(deviceId)).emit('viewer:control', sanitizeControl(payload));
    });

    socket.on('viewer:ping', (payload = {}) => {
      const deviceId = socket.data.deviceId;
      if (!deviceId) return;
      const entry = roomOf(deviceId)?.get(socket.id);
      if (!entry?.granted) return;
      io.to(agentRoom(deviceId)).emit('ping', { t: payload.t, sid: socket.id });
    });

    socket.on('viewer:leave', () => {
      if (socket.data.deviceId) closeEntry(socket.data.deviceId, socket.id, 'viewer-left');
    });

    socket.on('rtc:offer', (payload = {}) => {
      const deviceId = socket.data.deviceId;
      if (!deviceId) return;
      const entry = roomOf(deviceId)?.get(socket.id);
      if (!entry?.granted) return;
      io.to(agentRoom(deviceId)).emit('rtc:offer', {
        from: socket.id,
        sdp: payload.sdp,
      });
    });
    socket.on('rtc:ice', (payload = {}) => {
      const deviceId = socket.data.deviceId;
      if (!deviceId) return;
      const entry = roomOf(deviceId)?.get(socket.id);
      if (!entry?.granted) return;
      io.to(agentRoom(deviceId)).emit('rtc:ice', {
        from: socket.id,
        candidate: payload.candidate,
      });
    });

    socket.on('disconnect', async () => {
      if (socket.data.deviceId) {
        await closeEntry(socket.data.deviceId, socket.id, 'viewer-disconnected');
      }
    });
  }

  /* ------------------------------------------------------------- rate limit */

  const buckets = new Map(); // socketId -> {tokens, last}
  const INPUT_PER_SEC = 400;
  function allowInput(socket) {
    const now = Date.now();
    let b = buckets.get(socket.id);
    if (!b) {
      b = { tokens: INPUT_PER_SEC, last: now };
      buckets.set(socket.id, b);
    }
    b.tokens = Math.min(INPUT_PER_SEC, b.tokens + ((now - b.last) / 1000) * INPUT_PER_SEC);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  io.on('disconnect', (socket) => buckets.delete(socket.id));
}

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Keeps a viewer from asking the agent for an unrealistic bitrate. */
function sanitizeControl(payload = {}) {
  if (payload.type === 'clipboard') {
    return { type: 'clipboard', text: String(payload.text ?? '').slice(0, 256 * 1024) };
  }
  const out = {};
  if (payload.fps !== undefined) out.fps = Math.round(clamp(payload.fps, 1, 30, 10));
  if (payload.scale !== undefined) out.scale = clamp(payload.scale, 0.2, 1, 0.65);
  if (payload.quality !== undefined) out.quality = Math.round(clamp(payload.quality, 20, 90, 55));
  return out;
}

function toBuffer(data) {
  if (!data) return null;
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}
