import { Router } from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import Device from '../models/Device.js';
import EnrollCode from '../models/EnrollCode.js';
import Session from '../models/Session.js';
import { requireAuth } from '../middleware/auth.js';
import {
  randomDeviceId,
  randomDeviceToken,
  randomEnrollCode,
  sha256,
} from '../utils/tokens.js';

const router = Router();

const enrollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many enrollment attempts, try again later' },
});

const ttlMinutes = () => Number(process.env.ENROLL_CODE_TTL_MINUTES || 10);

/** GET /api/devices - devices owned by the caller (admins see everything). */
router.get('/devices', requireAuth, async (req, res) => {
  const filter =
    req.user.role === 'admin' && req.query.all === '1' ? {} : { owner: req.user._id };
  const devices = await Device.find(filter).sort({ createdAt: -1 });
  res.json({ devices: devices.map((d) => d.toSafeJSON()) });
});

/** POST /api/devices/enroll-codes - mint a one-time pairing code. */
router.post('/devices/enroll-codes', requireAuth, async (req, res) => {
  const code = randomEnrollCode();
  await EnrollCode.create({
    code,
    owner: req.user._id,
    expiresAt: new Date(Date.now() + ttlMinutes() * 60 * 1000),
  });
  res.status(201).json({ code, ttlMinutes: ttlMinutes() });
});

/** GET /api/devices/:id */
router.get('/devices/:id', requireAuth, async (req, res) => {
  const device = await findOwned(req, req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  return res.json({ device: device.toSafeJSON() });
});

/** GET /api/devices/:id/sessions - recent audit log. */
router.get('/devices/:id/sessions', requireAuth, async (req, res) => {
  const device = await findOwned(req, req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  const sessions = await Session.find({ device: device._id })
    .sort({ startedAt: -1 })
    .limit(25)
    .populate('viewer', 'name email');
  res.json({
    sessions: sessions.map((s) => ({
      id: s._id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      frames: s.frames,
      bytes: s.bytes,
      endedReason: s.endedReason,
      viewer: s.viewer ? { name: s.viewer.name, email: s.viewer.email } : null,
    })),
  });
});

/** PATCH /api/devices/:id - rename / change access mode. */
router.patch('/devices/:id', requireAuth, async (req, res) => {
  const device = await findOwned(req, req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });

  const { name, accessMode } = req.body || {};
  if (typeof name === 'string' && name.trim()) device.name = name.trim().slice(0, 80);
  if (accessMode === 'open' || accessMode === 'approve') {
    device.accessMode = accessMode;
  }
  await device.save();
  return res.json({ device: device.toSafeJSON() });
});

/** DELETE /api/devices/:id */
router.delete('/devices/:id', requireAuth, async (req, res) => {
  const device = await findOwned(req, req.params.id);
  if (!device) return res.status(404).json({ error: 'device not found' });
  await device.deleteOne();
  return res.json({ ok: true });
});

/**
 * POST /api/enroll - PUBLIC. Redeemed by the agent with a pairing code.
 * Returns the device token exactly once; only its hash is stored.
 */
router.post('/enroll', enrollLimiter, async (req, res) => {
  const { code, name, platform, os, hostname, arch, capabilities, accessMode } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code is required' });

  const normalized = String(code).trim().toUpperCase();
  const record = await EnrollCode.findOne({ code: normalized });
  if (!record || record.used || record.expiresAt < new Date()) {
    return res.status(400).json({ error: 'invalid or expired code' });
  }

  const deviceToken = randomDeviceToken();
  const device = await Device.create({
    deviceId: randomDeviceId(),
    name: (typeof name === 'string' && name.trim()) || hostname || 'Unnamed device',
    owner: record.owner,
    tokenHash: sha256(deviceToken),
    platform: platform || '',
    os: os || '',
    hostname: hostname || '',
    arch: arch || '',
    capabilities: capabilities || {},
    accessMode: accessMode === 'open' ? 'open' : 'approve',
    status: 'offline',
  });

  record.used = true;
  record.usedAt = new Date();
  await record.save();

  return res.status(201).json({
    deviceId: device.deviceId,
    deviceToken, // shown once - the agent persists it locally
    device: device.toSafeJSON(),
  });
});

/** Owner (or admin) lookup by either Mongo id or the public device id. */
async function findOwned(req, id) {
  const key = String(id || '').replace(/\s+/g, '');
  const query = mongoose.Types.ObjectId.isValid(id)
    ? { $or: [{ deviceIdKey: key }, { _id: id }] }
    : { $or: [{ deviceIdKey: key }, { deviceId: String(id) }] };
  const byPublic = await Device.findOne(query).catch(() => null);
  if (!byPublic) return null;
  if (req.user.role === 'admin') return byPublic;
  return byPublic.owner.toString() === req.user._id.toString() ? byPublic : null;
}

export default router;
