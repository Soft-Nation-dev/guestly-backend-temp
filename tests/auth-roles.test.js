process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-auth-test-secret-at-least-32-characters';

jest.mock('../src/modules/users/model', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
  findByIdAndUpdate: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const User = require('../src/modules/users/model');
const app = require('../src/app');

const id = '507f1f77bcf86cd799439011';
function account(role = 'guest', changes = {}) {
  return {
    _id: id,
    firstName: 'Taylor',
    lastName: 'Guest',
    email: 'taylor@example.com',
    phone: '',
    role,
    isActive: true,
    sessionVersion: 0,
    comparePassword: jest.fn().mockResolvedValue(true),
    ...changes,
  };
}
function bearer(role = 'guest', version = 0) {
  return 'Bearer ' + jwt.sign({ id, role, sessionVersion: version }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockResolvedValue(account());
});

describe('Guestly accounts and access control', () => {
  it('creates only guest accounts through public registration', async () => {
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(account());
    const response = await request(app).post('/api/v1/auth/register').send({
      firstName: 'Taylor', lastName: 'Guest', email: ' TAYLOR@example.com ',
      password: 'longpassword123', confirmPassword: 'longpassword123', role: 'admin',
    });
    expect(response.status).toBe(201);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'guest', email: 'taylor@example.com' }));
    expect(response.body.data.password).toBeUndefined();
  });

  it('rejects duplicate registration and mismatched passwords', async () => {
    User.findOne.mockResolvedValue(account());
    const payload = { firstName: 'Taylor', lastName: 'Guest', email: 'taylor@example.com', password: 'password123', confirmPassword: 'password123' };
    expect((await request(app).post('/api/v1/auth/register').send(payload)).status).toBe(409);
    expect((await request(app).post('/api/v1/auth/register').send({ ...payload, confirmPassword: 'incorrect' })).status).toBe(400);
  });

  it('issues a token and resolves the authenticated user profile', async () => {
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(account()) });
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'TAYLOR@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.data.token).toEqual(expect.any(String));
    expect(login.body.data.user.role).toBe('guest');
    const profile = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + login.body.data.token);
    expect(profile.status).toBe(200);
    expect(profile.body.data.email).toBe('taylor@example.com');
  });

  it('rejects invalid passwords, inactive accounts and expired tokens', async () => {
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(account('guest', { comparePassword: jest.fn().mockResolvedValue(false) })) });
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'taylor@example.com', password: 'incorrect' })).status).toBe(401);
    User.findOne.mockReturnValue({ select: jest.fn().mockResolvedValue(account('guest', { isActive: false })) });
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'taylor@example.com', password: 'password123' })).status).toBe(403);
    const expired = jwt.sign({ id, sessionVersion: 0, exp: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer ' + expired)).status).toBe(401);
  });

  it('denies guest and staff attempts to manage accounts', async () => {
    for (const role of ['guest', 'staff', 'manager']) {
      User.findById.mockResolvedValue(account(role));
      const response = await request(app).get('/api/v1/users/team').set('Authorization', bearer(role));
      expect(response.status).toBe(403);
    }
  });

  it('allows the super admin to list and create staff and managers', async () => {
    User.findById.mockResolvedValue(account('admin'));
    User.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([account('staff'), account('manager')]) });
    const list = await request(app).get('/api/v1/users/team').set('Authorization', bearer('admin'));
    expect(list.status).toBe(200);
    expect(list.body.data.map(user => user.role)).toEqual(['staff', 'manager']);

    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue(account('staff'));
    const created = await request(app).post('/api/v1/users/team').set('Authorization', bearer('admin')).send({
      firstName: 'Taylor', lastName: 'Guest', email: 'taylor@example.com',
      password: 'password123', confirmPassword: 'password123', role: 'staff',
    });
    expect(created.status).toBe(201);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'staff', isActive: true }));
    const rejected = await request(app).post('/api/v1/users/team').set('Authorization', bearer('admin')).send({
      firstName: 'Taylor', lastName: 'Guest', email: 'taylor@example.com',
      password: 'password123', confirmPassword: 'password123', role: 'admin',
    });
    expect(rejected.status).toBe(400);
  });

  it('limits role changes to staff and manager roles and revokes sessions', async () => {
    User.findById.mockResolvedValue(account('admin'));
    User.findOneAndUpdate.mockResolvedValue(account('manager', { isActive: false, sessionVersion: 1 }));
    const changed = await request(app).patch('/api/v1/users/team/' + id + '/access')
      .set('Authorization', bearer('admin')).send({ role: 'manager', isActive: false });
    expect(changed.status).toBe(200);
    expect(changed.body.data.isActive).toBe(false);
    expect(User.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: id, role: { $in: ['staff', 'manager'] } }),
      expect.objectContaining({ $inc: { sessionVersion: 1 } }),
      expect.any(Object),
    );
    expect((await request(app).patch('/api/v1/users/team/' + id + '/access')
      .set('Authorization', bearer('admin')).send({ role: 'admin', isActive: true })).status).toBe(400);
    User.findOneAndUpdate.mockResolvedValue(null);
    expect((await request(app).patch('/api/v1/users/team/' + id + '/access')
      .set('Authorization', bearer('admin')).send({ role: 'staff', isActive: true })).status).toBe(404);
  });

  it('rejects revoked, inactive and missing sessions', async () => {
    User.findById.mockResolvedValue(account('guest', { sessionVersion: 1 }));
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', bearer('guest', 0))).status).toBe(401);
    User.findById.mockResolvedValue(account('guest', { isActive: false }));
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', bearer('guest'))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('updates a personal profile without changing account permissions', async () => {
    User.findByIdAndUpdate.mockResolvedValue(account('guest', { firstName: 'Updated' }));
    const result = await request(app).patch('/api/v1/auth/me').set('Authorization', bearer()).send({
      firstName: 'Updated', lastName: 'Guest', role: 'admin',
    });
    expect(result.status).toBe(200);
    expect(User.findByIdAndUpdate).toHaveBeenCalledWith(id, { $set: { firstName: 'Updated', lastName: 'Guest' } }, expect.any(Object));
  });

  it('revokes existing tokens on sign out', async () => {
    User.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    const logout = await request(app).post('/api/v1/auth/logout').set('Authorization', bearer());
    expect(logout.status).toBe(200);
    expect(User.updateOne).toHaveBeenCalledWith({ _id: id, sessionVersion: 0 }, { $inc: { sessionVersion: 1 } });
  });
});
