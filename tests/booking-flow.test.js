process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-bookings-test-secret-at-least-32-characters';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/rooms/model', () => ({ findOneAndUpdate: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../src/modules/bookings/model', () => ({
  findOne: jest.fn(),
  find: jest.fn(),
  findById: jest.fn(),
  findOneAndUpdate: jest.fn(),
  countDocuments: jest.fn(),
  create: jest.fn(),
  updateOne: jest.fn(),
}));
jest.mock('../src/modules/auditlogs/service', () => ({ record: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const Booking = require('../src/modules/bookings/model');
const Room = require('../src/modules/rooms/model');
const User = require('../src/modules/users/model');
const { localToday } = require('../src/modules/rooms/availability');
const { expirePendingBookings } = require('../src/jobs/expireBookings');

const guestId = '507f1f77bcf86cd799439011';
const roomId = '507f1f77bcf86cd799439022';
const requestId = 'fa52e0a1-688d-47d8-955d-452c9aefea11';
const room = { _id: roomId, slug: 'standard-cozy-haven', name: 'Cozy Haven', nightlyRate: 55000, capacity: 2, inventory: 1 };
const currentUser = role => ({ _id: guestId, role, isActive: true, sessionVersion: 0, firstName: 'Alex', lastName: 'Morgan' });
const token = role => 'Bearer ' + jwt.sign({ id: guestId, role, sessionVersion: 0 }, process.env.JWT_SECRET);

function dates() {
  const checkIn = new Date(localToday() + 'T12:00:00Z');
  checkIn.setUTCDate(checkIn.getUTCDate() + 2);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 2);
  return { checkIn: checkIn.toISOString().slice(0, 10), checkOut: checkOut.toISOString().slice(0, 10) };
}

function hold(status = 'pending') {
  const stay = dates();
  return {
    _id: '507f1f77bcf86cd799439033', guest: guestId, room: roomId, requestId,
    roomSlug: room.slug, roomName: room.name, guestName: 'Alex Morgan',
    ...stay, guests: 2, quantity: 1, nightlyRate: 55000, totalAmount: 11000000,
    currency: 'NGN', status, expiresAt: new Date(Date.now() + 15 * 60000),
    createdAt: new Date(), latestPaymentReference: '',
  };
}

const session = {
  withTransaction: jest.fn(async callback => callback()),
  endSession: jest.fn(async () => {}),
};

beforeEach(() => {
  jest.clearAllMocks();
  mongoose.models.Booking = Booking;
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
  session.withTransaction.mockImplementation(async callback => callback());
  User.findById.mockResolvedValue(currentUser('guest'));
  Booking.findOne.mockImplementation(() => ({ then: resolve => Promise.resolve(null).then(resolve), session: jest.fn().mockResolvedValue(null) }));
  Booking.find.mockImplementation(() => ({
    select: () => ({ session: () => ({ lean: async () => [] }), lean: async () => [] }),
    sort: () => ({ skip: () => ({ limit: async () => [] }) }),
  }));
  Booking.countDocuments.mockResolvedValue(0);
  Booking.findById.mockResolvedValue(hold());
  Booking.create.mockImplementation(async ([fields]) => [{ ...fields, _id: '507f1f77bcf86cd799439033', status: 'pending', createdAt: new Date() }]);
  Booking.findOneAndUpdate.mockResolvedValue(hold('cancelled'));
  Booking.updateOne.mockResolvedValue({ modifiedCount: 1 });
  Room.findOneAndUpdate.mockResolvedValue({ ...room });
});

afterEach(() => { jest.restoreAllMocks(); });

describe('Transactional reservation endpoints', () => {
  it('rejects public, staff and malformed booking creation', async () => {
    const input = { roomId: room.slug, ...dates(), guests: 2, requestId };
    expect((await request(app).post('/api/v1/bookings').send(input)).status).toBe(401);
    User.findById.mockResolvedValue(currentUser('staff'));
    expect((await request(app).post('/api/v1/bookings').set('Authorization', token('staff')).send(input)).status).toBe(403);
    User.findById.mockResolvedValue(currentUser('guest'));
    expect((await request(app).post('/api/v1/bookings').set('Authorization', token('guest')).send({ ...input, totalAmount: 1 })).status).toBe(400);
    expect((await request(app).post('/api/v1/bookings').set('Authorization', token('guest')).send({ ...input, guests: 4 })).status).toBe(400);
  });

  it('locks room inventory and calculates its own price in integer kobo', async () => {
    const response = await request(app).post('/api/v1/bookings')
      .set('Authorization', token('guest')).send({ roomId: room.slug, ...dates(), guests: 2, requestId });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ roomId: room.slug, status: 'pending', amount: 110000, currency: 'NGN' });
    expect(Room.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: room.slug, capacity: { $gte: 2 } }),
      { $inc: { bookingsRevision: 1 } },
      expect.objectContaining({ session }),
    );
    expect(Booking.create).toHaveBeenCalledWith(
      [expect.objectContaining({ totalAmount: 11000000, nightlyRate: 55000, quantity: 1, guest: guestId })],
      { session },
    );
    expect(session.endSession).toHaveBeenCalled();
  });

  it('rejects overlapping holds when the room inventory is exhausted', async () => {
    Booking.find.mockReturnValue({
      select: () => ({ session: () => ({ lean: async () => [{ room: roomId, ...dates(), quantity: 1 }] }) }),
    });
    const response = await request(app).post('/api/v1/bookings')
      .set('Authorization', token('guest')).send({ roomId: room.slug, ...dates(), guests: 2, requestId });
    expect(response.status).toBe(409);
    expect(Booking.create).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalled();
  });

  it('returns the original booking when a request key is retried', async () => {
    Booking.findOne.mockResolvedValue(hold());
    const result = await request(app).post('/api/v1/bookings')
      .set('Authorization', token('guest')).send({ roomId: room.slug, ...dates(), guests: 2, requestId });
    expect(result.status).toBe(201);
    expect(Room.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('enforces guest ownership and staff/manager list access', async () => {
    expect((await request(app).get('/api/v1/bookings').set('Authorization', token('guest'))).status).toBe(403);
    User.findById.mockResolvedValue(currentUser('staff'));
    expect((await request(app).get('/api/v1/bookings').set('Authorization', token('staff'))).status).toBe(200);
    User.findById.mockResolvedValue(currentUser('guest'));
    expect((await request(app).get('/api/v1/bookings/me').set('Authorization', token('guest'))).status).toBe(200);
    Booking.findById.mockResolvedValue({ ...hold(), guest: roomId });
    expect((await request(app).get('/api/v1/bookings/507f1f77bcf86cd799439033').set('Authorization', token('guest'))).status).toBe(404);
    User.findById.mockResolvedValue(currentUser('manager'));
    expect((await request(app).get('/api/v1/bookings/507f1f77bcf86cd799439033').set('Authorization', token('manager'))).status).toBe(200);
  });

  it('cancels pending holds without allowing staff or confirmed bookings to be cancelled', async () => {
    const path = '/api/v1/bookings/507f1f77bcf86cd799439033/cancel';
    expect((await request(app).post(path).set('Authorization', token('guest'))).status).toBe(200);
    User.findById.mockResolvedValue(currentUser('staff'));
    expect((await request(app).post(path).set('Authorization', token('staff'))).status).toBe(403);
    User.findById.mockResolvedValue(currentUser('guest'));
    Booking.findOneAndUpdate.mockResolvedValue(null);
    expect((await request(app).post(path).set('Authorization', token('guest'))).status).toBe(409);
  });

  it('expires pending holds without cancelling possible late Paystack settlements', async () => {
    Booking.find.mockReturnValue({
      select: () => ({ limit: async () => [{ _id: hold()._id }] }),
    });
    const amount = await expirePendingBookings();
    expect(amount).toBe(1);
    expect(Booking.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', expiresAt: expect.any(Object) }),
      { $set: { status: 'expired' } },
    );
  });
});
