process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-service-tests-secret-at-least-32-characters';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/bookings/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/servicerequests/model', () => ({
  create: jest.fn(), find: jest.fn(), countDocuments: jest.fn(), findOneAndUpdate: jest.fn(),
}));
jest.mock('../src/modules/servicerequests/catalogue-model', () => ({
  bulkWrite: jest.fn(), find: jest.fn(), findOne: jest.fn(), create: jest.fn(), findByIdAndUpdate: jest.fn(),
}));
jest.mock('../src/modules/auditlogs/service', () => ({ record: jest.fn().mockResolvedValue() }));

const jwt = require('jsonwebtoken');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/modules/users/model');
const Booking = require('../src/modules/bookings/model');
const Request = require('../src/modules/servicerequests/model');
const Category = require('../src/modules/servicerequests/catalogue-model');
const { localToday } = require('../src/modules/rooms/availability');
const { record } = require('../src/modules/auditlogs/service');

const guestId = '507f1f77bcf86cd799439011';
const staffId = '507f1f77bcf86cd799439012';
const managerId = '507f1f77bcf86cd799439013';
const bookingId = '507f1f77bcf86cd799439022';
const categoryId = '507f1f77bcf86cd799439033';
const reqId = '507f1f77bcf86cd799439044';
const actor = role => ({
  _id: role === 'guest' ? guestId : role === 'manager' ? managerId : staffId, role, firstName: 'Amina',
  lastName: 'Bello', isActive: true, sessionVersion: 0,
});
const token = role => 'Bearer ' + jwt.sign({ id: actor(role)._id, role, sessionVersion: 0 }, process.env.JWT_SECRET);
const date = offset => {
  const value = new Date(localToday() + 'T12:00:00Z');
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
};
const booking = (status = 'confirmed') => ({
  _id: bookingId, guest: guestId, roomName: 'Standard Cozy Haven', status,
  checkIn: date(-1), checkOut: date(2),
});
const category = (active = true) => ({ _id: categoryId, name: 'Housekeeping', nameKey: 'housekeeping', description: 'Housekeeping assistance', active });
const service = status => ({
  _id: reqId, booking: bookingId, guest: guestId, guestName: 'Amina Bello',
  roomName: 'Standard Cozy Haven', category: categoryId, categoryName: 'Housekeeping',
  details: 'Please replace towels', status, createdAt: new Date(),
  history: [{ status, at: new Date(), actor: guestId }],
});

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockImplementation(async id => String(id) === guestId ? actor('guest') : String(id) === managerId ? actor('manager') : actor('staff'));
  Booking.findById.mockResolvedValue(booking());
  Category.bulkWrite.mockResolvedValue({ acknowledged: true });
  Category.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([category()]) });
  Category.findOne.mockResolvedValue(category());
  Category.create.mockImplementation(async value => ({ ...value, _id: categoryId }));
  Category.findByIdAndUpdate.mockResolvedValue(category());
  Request.create.mockImplementation(async value => ({ ...value, _id: reqId, createdAt: new Date() }));
  Request.find.mockReturnValue({ sort: () => ({ skip: () => ({ limit: async () => [service('received')] }) }) });
  Request.countDocuments.mockResolvedValue(1);
  Request.findOneAndUpdate.mockResolvedValue(service('in-progress'));
});

describe('Group 6 service catalogue and request endpoints', () => {
  it('publishes available catalogue and does not recreate seeded categories on each call', async () => {
    const first = await request(app).get('/api/v1/servicerequests/catalogue');
    const second = await request(app).get('/api/v1/servicerequests/catalogue');
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject([{ id: categoryId, name: 'Housekeeping', active: true }]);
    expect(second.status).toBe(200);
    expect(Category.bulkWrite.mock.calls.length).toBeLessThanOrEqual(1);
    if (Category.bulkWrite.mock.calls.length) {
      expect(Category.bulkWrite.mock.calls[0][0]).toEqual(expect.arrayContaining([expect.objectContaining({
        updateOne: expect.objectContaining({ filter: { nameKey: 'housekeeping' }, upsert: true }),
      })]));
    }
  });

  it('protects manager catalogue editing and rejects invalid updates', async () => {
    expect((await request(app).post('/api/v1/servicerequests/catalogue').send({ name: 'Spa' })).status).toBe(401);
    expect((await request(app).get('/api/v1/servicerequests/catalogue/manage').set('Authorization', token('guest'))).status).toBe(403);
    const payload = { name: 'Spa', description: 'Spa appointments', active: true };
    expect((await request(app).post('/api/v1/servicerequests/catalogue').set('Authorization', token('guest')).send(payload)).status).toBe(403);
    expect((await request(app).post('/api/v1/servicerequests/catalogue').set('Authorization', token('manager')).send(payload)).status).toBe(201);
    expect(Category.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Spa', nameKey: 'spa', active: true }));
    expect((await request(app).patch('/api/v1/servicerequests/catalogue/' + categoryId).set('Authorization', token('manager')).send({ active: false })).status).toBe(200);
    expect((await request(app).patch('/api/v1/servicerequests/catalogue/' + categoryId).set('Authorization', token('manager')).send({ nameKey: 'hijack' })).status).toBe(400);
  });

  it('allows only guests with confirmed active reservations and enabled categories to submit', async () => {
    const url = '/api/v1/servicerequests';
    const payload = { bookingId, categoryId, details: 'Please replace towels' };
    expect((await request(app).post(url).send(payload)).status).toBe(401);
    expect((await request(app).post(url).set('Authorization', token('staff')).send(payload)).status).toBe(403);
    expect((await request(app).post(url).set('Authorization', token('guest')).send({ ...payload, status: 'done' })).status).toBe(400);
    const success = await request(app).post(url).set('Authorization', token('guest')).send(payload);
    expect(success.status).toBe(201);
    expect(success.body.data).toMatchObject({ guestId, bookingId, status: 'received', category: 'Housekeeping' });
    expect(Request.create).toHaveBeenCalledWith(expect.objectContaining({ guest: guestId, booking: bookingId, status: 'received', history: [expect.objectContaining({ status: 'received' })] }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'service.request.received' }));

    Booking.findById.mockResolvedValue(booking('pending'));
    expect((await request(app).post(url).set('Authorization', token('guest')).send(payload)).status).toBe(409);
    Booking.findById.mockResolvedValue({ ...booking(), guest: staffId });
    expect((await request(app).post(url).set('Authorization', token('guest')).send(payload)).status).toBe(404);
    Booking.findById.mockResolvedValue({ ...booking(), checkOut: date(-1) });
    expect((await request(app).post(url).set('Authorization', token('guest')).send(payload)).status).toBe(409);
    Booking.findById.mockResolvedValue(booking());
    Category.findOne.mockResolvedValue(null);
    expect((await request(app).post(url).set('Authorization', token('guest')).send(payload)).status).toBe(409);
  });

  it('enforces role-scoped history and ordered status transitions with atomic checks', async () => {
    expect((await request(app).get('/api/v1/servicerequests/me').set('Authorization', token('staff'))).status).toBe(403);
    expect((await request(app).get('/api/v1/servicerequests').set('Authorization', token('guest'))).status).toBe(403);
    const mine = await request(app).get('/api/v1/servicerequests/me').set('Authorization', token('guest'));
    expect(mine.status).toBe(200);
    expect(Request.find).toHaveBeenCalledWith(expect.objectContaining({ guest: guestId }));
    expect((await request(app).get('/api/v1/servicerequests').set('Authorization', token('manager'))).status).toBe(200);

    const url = '/api/v1/servicerequests/' + reqId + '/status';
    expect((await request(app).patch(url).set('Authorization', token('guest')).send({ status: 'in-progress' })).status).toBe(403);
    expect((await request(app).patch(url).set('Authorization', token('manager')).send({ status: 'in-progress' })).status).toBe(403);
    expect((await request(app).patch(url).set('Authorization', token('staff')).send({ status: 'received' })).status).toBe(400);
    const updated = await request(app).patch(url).set('Authorization', token('staff')).send({ status: 'in-progress' });
    expect(updated.status).toBe(200);
    expect(Request.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: reqId, status: 'received' },
      expect.objectContaining({ $push: expect.objectContaining({ history: expect.objectContaining({ status: 'in-progress' }) }) }),
      expect.objectContaining({ new: true }),
    );
    Request.findOneAndUpdate.mockResolvedValue(null);
    expect((await request(app).patch(url).set('Authorization', token('staff')).send({ status: 'done' })).status).toBe(409);
  });
});
