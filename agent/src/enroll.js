import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import os from 'node:os';
import { AGENT_VERSION, loadConfig, writeCreds } from './config.js';

/**
 * Redeems a one-time pairing code from the dashboard for a device token.
 * The token is returned exactly once by the server and stored locally.
 */
export async function enroll(config = loadConfig()) {
  let code = config.enrollCode;
  let name = config.name;

  if (!code && process.stdin.isTTY) {
    const rl = readline.createInterface({ input, output });
    code = (await rl.question('Enter the pairing code from the dashboard: '))
      .trim()
      .toUpperCase();
    const rename = await rl.question(`Device name [${name}]: `);
    if (rename.trim()) name = rename.trim();
    rl.close();
  }
  if (!code) {
    throw new Error(
      'No pairing code. Generate one in the dashboard (Add device), then run:\n' +
        '  npm run pair -- --code XXXX-XXXX'
    );
  }

  const res = await fetch(`${config.serverUrl}/api/enroll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: String(code).trim().toUpperCase(),
      name,
      platform: process.platform,
      os: `${os.type()} ${os.release()}`,
      hostname: os.hostname(),
      arch: process.arch,
      accessMode: config.accessMode,
      capabilities: { agentVersion: AGENT_VERSION, node: process.version },
    }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `enrollment failed (HTTP ${res.status})`);
  }

  const creds = {
    deviceId: body.deviceId,
    deviceToken: body.deviceToken,
    serverUrl: config.serverUrl,
    name: body.device?.name || name,
    enrolledAt: new Date().toISOString(),
  };
  writeCreds(creds);
  return creds;
}
