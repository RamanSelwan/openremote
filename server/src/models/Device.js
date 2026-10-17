import mongoose from 'mongoose';

const capabilitiesSchema = new mongoose.Schema(
  {
    canCapture: { type: Boolean, default: false },
    canControl: { type: Boolean, default: false },
    captureDriver: { type: String, default: 'none' },
    controlDriver: { type: String, default: 'none' },
    width: { type: Number, default: 0 },
    height: { type: Number, default: 0 },
    agentVersion: { type: String, default: '' },
    node: { type: String, default: '' },
  },
  { _id: false }
);

const deviceSchema = new mongoose.Schema(
  {
    // Human readable AnyDesk-style id, unique per device.
    deviceId: { type: String, required: true, unique: true, index: true },
    // Same id without spaces - used for lookups from URLs/sockets.
    deviceIdKey: { type: String, unique: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // sha256 of the device secret; the raw secret is shown only once at enrollment.
    tokenHash: { type: String, required: true, select: false },

    platform: { type: String, default: '' },
    os: { type: String, default: '' },
    hostname: { type: String, default: '' },
    arch: { type: String, default: '' },

    // 'approve' -> a human on the agent must accept each viewer.
    accessMode: { type: String, enum: ['open', 'approve'], default: 'approve' },

    status: { type: String, enum: ['online', 'offline'], default: 'offline', index: true },
    lastSeen: { type: Date },
    lastIp: { type: String, default: '' },

    capabilities: { type: capabilitiesSchema, default: () => ({}) },
  },
  { timestamps: true }
);

deviceSchema.pre('validate', function normalizeDeviceId(next) {
  if (this.deviceId) this.deviceIdKey = String(this.deviceId).replace(/\s+/g, '');
  return next();
});

deviceSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id.toString(),
    deviceId: this.deviceId,
    name: this.name,
    platform: this.platform,
    os: this.os,
    hostname: this.hostname,
    arch: this.arch,
    accessMode: this.accessMode,
    status: this.status,
    lastSeen: this.lastSeen,
    capabilities: this.capabilities,
    createdAt: this.createdAt,
  };
};

export default mongoose.model('Device', deviceSchema);
