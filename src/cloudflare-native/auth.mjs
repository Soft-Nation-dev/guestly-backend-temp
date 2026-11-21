const encoder = new TextEncoder();
const iterations = 600000;
const expirySeconds = 86400;
const dummyHash = 'pbkdf2_sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function base64url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let chars = '';
  for (const byte of bytes) chars += String.fromCharCode(byte);
  return btoa(chars).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url');
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const chars = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(chars, char => char.charCodeAt(0));
}

function asUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone || '',
    role: row.role,
    isActive: row.is_active === 1,
  };
}

function validName(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 100;
}

function normalEmail(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 254 && emailPattern.test(normalized) ? normalized : null;
}

async function jsonBody(request) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) return null;
  const contentLength = Number(request.headers.get('content-length') || '0');
  if (contentLength > 8192) return null;
  let raw;
  try {
    raw = await request.text();
    if (raw.length > 8192) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function derivePassword(password, salt, count = iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: count }, key, 256));
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  return 'pbkdf2_sha256$' + iterations + '$' + base64url(salt) + '$' + base64url(hash);
}

async function matchesPassword(password, storedHash) {
  const pieces = (storedHash || '').split('$');
  if (pieces.length !== 4 || pieces[0] !== 'pbkdf2_sha256') return false;
  const count = Number(pieces[1]);
  if (!Number.isInteger(count) || count < iterations || count > 1000000) return false;
  let salt;
  let expected;
  try {
    salt = fromBase64url(pieces[2]);
    expected = fromBase64url(pieces[3]);
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== 32) return false;
  const actual = await derivePassword(password, salt, count);
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

async function tokenKey(secret) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Missing auth secret');
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function issueToken(user, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(encoder.encode(JSON.stringify({
    id: user.id,
    role: user.role,
    sessionVersion: user.session_version,
    iat: now,
    exp: now + expirySeconds,
  })));
  const input = header + '.' + payload;
  const signature = await crypto.subtle.sign('HMAC', await tokenKey(secret), encoder.encode(input));
  return input + '.' + base64url(signature);
}

async function authenticate(request, env) {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return { error: 'Authentication required' };
  const token = authorization.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) return { error: 'Invalid or expired token' };
  let header;
  let decoded;
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64url(parts[0])));
    decoded = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    if (header.alg !== 'HS256' || header.typ !== 'JWT' || !decoded || typeof decoded.id !== 'string' || decoded.id.length > 100) {
      return { error: 'Invalid or expired token' };
    }
    const valid = await crypto.subtle.verify(
      'HMAC', await tokenKey(env.JWT_SECRET), fromBase64url(parts[2]), encoder.encode(parts[0] + '.' + parts[1]),
    );
    const now = Math.floor(Date.now() / 1000);
    if (!valid || !Number.isInteger(decoded.exp) || decoded.exp <= now || !Number.isInteger(decoded.iat) || decoded.iat > now + 60 || decoded.exp - decoded.iat > expirySeconds) {
      return { error: 'Invalid or expired token' };
    }
  } catch {
    return { error: 'Invalid or expired token' };
  }
  const row = await env.GUESTLY_DB.prepare('SELECT * FROM users WHERE id = ?1').bind(decoded.id).first();
  if (!row || row.is_active !== 1 || row.session_version !== decoded.sessionVersion || row.role !== decoded.role) {
    return { error: 'Invalid or expired session' };
  }
  return { row };
}

async function attemptKey(request, email) {
  const source = (request.headers.get('CF-Connecting-IP') || 'unknown') + '|' + email;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(source));
  return base64url(digest);
}

async function canAttempt(env, key) {
  const result = await env.GUESTLY_DB.prepare('SELECT attempts, reset_at FROM auth_attempts WHERE key = ?1').bind(key).first();
  return !result || result.reset_at <= Date.now() || result.attempts < 5;
}

async function failAttempt(env, key) {
  const now = Date.now();
  const resetAt = now + 15 * 60 * 1000;
  await env.GUESTLY_DB.prepare(
    'INSERT INTO auth_attempts (key, attempts, reset_at) VALUES (?1, 1, ?2) ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN reset_at <= ?3 THEN 1 ELSE attempts + 1 END, reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END',
  ).bind(key, resetAt, now).run();
}

async function clearAttempt(env, key) {
  await env.GUESTLY_DB.prepare('DELETE FROM auth_attempts WHERE key = ?1').bind(key).run();
}

async function handleRegister(request, env, origin, respond) {
  const body = await jsonBody(request);
  if (!body || !validName(body.firstName) || !validName(body.lastName) || !normalEmail(body.email) ||
      typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72 ||
      body.password !== body.confirmPassword) return respond(undefined, 'Invalid registration details', 400, origin);
  const email = normalEmail(body.email);
  const exists = await env.GUESTLY_DB.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first();
  if (exists) return respond(undefined, 'Email is already registered', 409, origin);
  const passwordHash = await hashPassword(body.password);
  const id = crypto.randomUUID();
  const firstName = body.firstName.trim();
  const lastName = body.lastName.trim();
  try {
    await env.GUESTLY_DB.prepare(
      "INSERT INTO users (id, first_name, last_name, email, password_hash, role) VALUES (?1, ?2, ?3, ?4, ?5, 'guest')",
    ).bind(id, firstName, lastName, email, passwordHash).run();
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) return respond(undefined, 'Email is already registered', 409, origin);
    throw error;
  }
  const row = await env.GUESTLY_DB.prepare('SELECT * FROM users WHERE id = ?1').bind(id).first();
  return respond(asUser(row), 'Account created successfully', 201, origin);
}

async function handleLogin(request, env, origin, respond) {
  const body = await jsonBody(request);
  const email = normalEmail(body?.email);
  if (!email || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 72) {
    return respond(undefined, 'Invalid email or password', 401, origin);
  }
  const key = await attemptKey(request, email);
  if (!(await canAttempt(env, key))) return respond(undefined, 'Too many sign-in attempts. Try again later', 429, origin);
  const row = await env.GUESTLY_DB.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
  const valid = await matchesPassword(body.password, row?.password_hash || dummyHash);
  if (!valid || !row) {
    await failAttempt(env, key);
    return respond(undefined, 'Invalid email or password', 401, origin);
  }
  if (row.is_active !== 1) return respond(undefined, 'Your account is inactive', 403, origin);
  await clearAttempt(env, key);
  const token = await issueToken(row, env.JWT_SECRET);
  return respond({ token, user: asUser(row) }, 'Login successful', 200, origin);
}

async function handleUpdate(request, env, origin, respond, user) {
  const body = await jsonBody(request);
  if (!body || !validName(body.firstName) || !validName(body.lastName) ||
      (body.phone !== undefined && (typeof body.phone !== 'string' || body.phone.trim().length > 32))) {
    return respond(undefined, 'Invalid profile details', 400, origin);
  }
  await env.GUESTLY_DB.prepare(
    'UPDATE users SET first_name = ?1, last_name = ?2, phone = ?3, updated_at = CURRENT_TIMESTAMP WHERE id = ?4',
  ).bind(body.firstName.trim(), body.lastName.trim(), body.phone?.trim() || null, user.id).run();
  const row = await env.GUESTLY_DB.prepare('SELECT * FROM users WHERE id = ?1').bind(user.id).first();
  return respond(asUser(row), 'Profile updated', 200, origin);
}

export async function handleAuth(request, env, path, origin, respond) {
  if (!env.GUESTLY_DB || !env.JWT_SECRET || env.JWT_SECRET.length < 32) return respond(undefined, 'Authentication is not configured', 503, origin);
  if (path === '/api/v1/auth/register' && request.method === 'POST') return handleRegister(request, env, origin, respond);
  if (path === '/api/v1/auth/login' && request.method === 'POST') return handleLogin(request, env, origin, respond);
  if (!['/api/v1/auth/me', '/api/v1/auth/logout'].includes(path)) return respond(undefined, 'Not found', 404, origin);
  const authenticated = await authenticate(request, env);
  if (authenticated.error) return respond(undefined, authenticated.error, 401, origin);
  if (path === '/api/v1/auth/me' && request.method === 'GET') {
    return respond(asUser(authenticated.row), 'User profile retrieved successfully', 200, origin);
  }
  if (path === '/api/v1/auth/me' && request.method === 'PATCH') {
    return handleUpdate(request, env, origin, respond, authenticated.row);
  }
  if (path === '/api/v1/auth/logout' && request.method === 'POST') {
    await env.GUESTLY_DB.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?1').bind(authenticated.row.id).run();
    return respond(undefined, 'Signed out successfully', 200, origin);
  }
  return respond(undefined, 'Method not allowed', 405, origin);
}
