const input = process.argv[2];

if (!input) throw new Error('Usage: npm run native:verify -- https://your-worker.workers.dev');

const url = new URL(input);
if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname))) || url.pathname !== '/' || url.search || url.hash) {
  throw new Error('Provide a plain HTTPS API origin without a path');
}

async function check(path, expected) {
  const response = await fetch(url.origin + path, { signal: AbortSignal.timeout(15000) });
  const body = await response.json();
  if (response.status !== expected) throw new Error(path + ': expected ' + expected + ', got ' + response.status);
  return body;
}

const health = await check('/health', 200);
if (health.data?.status !== 'ok') throw new Error('Health check failed');

const ready = await check('/ready', 200);
if (ready.data?.database !== 'connected' || ready.data?.storage !== 'connected') throw new Error('D1/R2 readiness failed');

const rooms = await check('/api/v1/rooms', 200);
if (!Array.isArray(rooms.data)) throw new Error('Rooms endpoint failed');

const auth = await check('/api/v1/auth/me', 401);
if (auth.success !== false) throw new Error('Anonymous profile access should be denied');

process.stdout.write('Cloudflare trial, D1 and R2 readiness checks passed.\n');
process.stdout.write('Booking, payment and file-upload APIs are not migrated yet. Do not connect the live frontend.\n');
