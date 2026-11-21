import { randomUUID } from 'node:crypto';

const base = process.argv[2];
if (!base) throw new Error('Provide the local Cloudflare API URL');

async function call(path, method = 'GET', body, token) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(new URL(path, base), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  return { status: response.status, ...data };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const email = 'worker-smoke-' + randomUUID() + '@example.test';
const password = 'StrongTestPassword_2026!';
const register = { firstName: 'Guestly', lastName: 'Tester', email, password, confirmPassword: password, role: 'admin' };
const anonymous = await call('/api/v1/auth/me');
assert(anonymous.status === 401, 'Anonymous request should be denied');
const wrongConfirmation = await call('/api/v1/auth/register', 'POST', { ...register, confirmPassword: 'wrong' });
assert(wrongConfirmation.status === 400, 'Password confirmation should be checked');
const created = await call('/api/v1/auth/register', 'POST', register);
assert(created.status === 201 && created.data.role === 'guest' && !created.data.password_hash, 'Guest registration failed');
const duplicate = await call('/api/v1/auth/register', 'POST', register);
assert(duplicate.status === 409, 'Duplicate email should be rejected');
const wrongPassword = await call('/api/v1/auth/login', 'POST', { email, password: 'incorrect-value' });
assert(wrongPassword.status === 401, 'Wrong password should be rejected');
const loggedIn = await call('/api/v1/auth/login', 'POST', { email, password });
assert(loggedIn.status === 200 && loggedIn.data.user.role === 'guest' && loggedIn.data.token, 'Login failed');
const token = loggedIn.data.token;
const profile = await call('/api/v1/auth/me', 'GET', undefined, token);
assert(profile.status === 200 && profile.data.email === email, 'Profile lookup failed');
const updated = await call('/api/v1/auth/me', 'PATCH', { firstName: 'Updated', lastName: 'Tester', phone: '08000000000', role: 'admin' }, token);
assert(updated.status === 200 && updated.data.firstName === 'Updated' && updated.data.role === 'guest', 'Profile update failed');
const logout = await call('/api/v1/auth/logout', 'POST', undefined, token);
assert(logout.status === 200, 'Logout failed');
const revoked = await call('/api/v1/auth/me', 'GET', undefined, token);
assert(revoked.status === 401, 'Logout should revoke the token');
process.stdout.write('Cloudflare D1 registration, login, profile and logout checks passed.\n');
