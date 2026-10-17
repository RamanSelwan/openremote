import mongoose from 'mongoose';

/** Audit record for a remote-viewing session. */
const sessionSchema = new mongoose.Schema({
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true,
    index: true,
  },
  viewer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date },
  frames: { type: Number, default: 0 },
  bytes: { type: Number, default: 0 },
  endedReason: { type: String, default: '' },
});

export default mongoose.model('Session', sessionSchema);
