import mongoose from 'mongoose';

/** One-time, short-lived code an agent redeems to enroll a new device. */
const enrollCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  used: { type: Boolean, default: false },
  usedAt: { type: Date },
  // `expiresAt` is indexed by the TTL index declared below (schema.index).
  expiresAt: { type: Date, required: true },
});

// Automatically purge expired codes.
enrollCodeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model('EnrollCode', enrollCodeSchema);
