import mongoose from 'mongoose';

/**
 * Connects to MongoDB.
 * - If MONGODB_URI is set, use it (required in production).
 * - Otherwise start an ephemeral in-memory MongoDB so `npm run dev` works with
 *   zero setup. That path needs the devDependency `mongodb-memory-server`.
 */
export async function connectDB(logger = console) {
  const uri = process.env.MONGODB_URI;

  if (uri) {
    await mongoose.connect(uri);
    logger.log(`[db] connected to ${redact(uri)}`);
    return null;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('MONGODB_URI must be set in production');
  }

  const { MongoMemoryServer } = await import('mongodb-memory-server');
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri('openremote'));
  logger.warn(
    '[db] MONGODB_URI not set -> using an in-memory MongoDB. Data is lost on restart.'
  );
  return mem;
}

const redact = (uri) => uri.replace(/\/\/[^@]*@/, '//***@');
