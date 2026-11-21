process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-reporting-loyalty-test-secret-32-character-minimum';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/bookings/model', () => ({
  find: jest.fn(), findById: jest.fn(), countDocuments: jest.fn(), distinct: jest.fn(),
}));
jest.mock('../src/modules/payments/model', () => ({
  findOne: jest.fn(), find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(),
}));
jest.mock('../src/modules/checkins/model', () => ({ findOne: jest.fn() }));
jest.mock('../src/modules/rooms/model', () => ({ find: jest.fn(), aggregate: jest.fn() }));
jest.mock('../src/modules/servicerequests/model', () => ({ countDocuments: jest.fn() }));
jest.mock('../src/modules/loyalty/rule-model', () => ({ updateOne: jest.fn(), create: jest.fn(), findOne: jest.fn(), find: jest.fn() }));
jest.mock('../src/modules/loyalty/award-model', () => ({
  find: jest.fn(), updateOne: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn(),
}));
jest.mock('../src/modules/historical/model', () => ({ find: jest.fn(), countDocuments: jest.fn(), aggregate: jest.fn() }));
jest.mock('../src/modules/auditlogs/service', () => ({ record: jest.fn().mockResolvedValue() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const Booking = require('../src/modules/bookings/model');
const Payment = require('../src/modules/payments/model');
const CheckIn = require('../src/modules/checkins/model');
const Rule = require('../src/modules/loyalty/rule-model');
const Award = require('../src/modules/loyalty/award-model');
const Room = require('../src/modules/rooms/model');
const Historical = require('../src/modules/historical/model');
const User = require('../src/modules/users/model');
const { record } = require('../src/modules/auditlogs/service');
const { reconcileGuest, createRule } = require('../src/modules/loyalty/service');
const { recommend } = require('../src/modules/recommendations/service');
const { historicalOverview, liveOverview } = require('../src/modules/reports/service');

const guestId = '507f1f77bcf86cd799439011';
const staffId = '507f1f77bcf86cd799439022';
const managerId = '507f1f77bcf86cd799439033';
const roomId = '507f1f77bcf86cd799439044';
const bookingId = '507f1f77bcf86cd799439055';
const paymentId = '507f1f77bcf86cd799439066';
const ruleId = '507f1f77bcf86cd799439077';
const person = role => ({
  _id: role === 'guest' ? guestId : role === 'staff' ? staffId : managerId,
  role, firstName: 'Amina', lastName: 'Bello', isActive: true, sessionVersion: 0,
});
const token = role => 'Bearer ' + jwt.sign({ id: person(role)._id, role, sessionVersion: 0 }, process.env.JWT_SECRET);

const booking = (status = 'confirmed') => ({
  _id: bookingId, room: roomId, roomSlug: 'standard-cozy-haven',
  roomName: 'Standard Cozy Haven', guest: guestId, payment: paymentId,
  checkIn: '2026-01-14', checkOut: '2026-01-16',
  totalAmount: 11000000, status,
});
const rule = { _id: ruleId, key: 'default', pointsPerNight: 10, effectiveAt: new Date('1970-01-01T00:00:00.000Z') };
const award = {
  _id: ruleId, booking: bookingId, guest: guestId, nights: 2, pointsPerNight: 10,
  points: 20, roomName: 'Standard Cozy Haven', checkoutDate: '2026-01-16',
  paidPayment: paymentId, awardedAt: new Date(), revokedAt: null,
};
const room = { _id: roomId, slug: 'standard-cozy-haven', name: 'Standard Cozy Haven', category: 'Standard',
  image: '/images/standard-cozy-haven.jpg', nightlyRate: 55000, capacity: 2, size: 34,
  bed: 'Queen', view: 'City', amenities: [], description: 'Nice room', inventory: 2, featured: true };

beforeEach(() => {
  jest.clearAllMocks();
  User.findById.mockImplementation(async id => id === guestId ? person('guest') : id === staffId ? person('staff') : person('manager'));
  Booking.find.mockResolvedValue([booking()]);
  Booking.countDocuments.mockResolvedValue(1);
  Booking.distinct.mockResolvedValue([guestId]);
  Payment.findOne.mockResolvedValue({ _id: paymentId, booking: bookingId, guest: guestId, status: 'success', amount: 11000000 });
  Payment.countDocuments.mockResolvedValue(1);
  Payment.aggregate.mockResolvedValue([{ amount: 11000000 }]);
  CheckIn.findOne.mockResolvedValue({ _id: ruleId, status: 'approved' });
  Rule.updateOne.mockResolvedValue({ modifiedCount: 0 });
  Rule.findOne.mockReturnValue({ sort: jest.fn().mockResolvedValue(rule) });
  Rule.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([rule]) });
  Rule.create.mockImplementation(async data => ({ ...data, _id: ruleId }));
  Award.find.mockResolvedValue([]);
  Award.updateOne.mockResolvedValue({ upsertedCount: 1, modifiedCount: 1 });
  Award.countDocuments.mockResolvedValue(1);
  Award.aggregate.mockResolvedValue([{ total: 20 }]);
  Room.find.mockResolvedValue([room]);
  Room.aggregate.mockResolvedValue([{ inventory: 2 }]);
  require('../src/modules/servicerequests/model').countDocuments.mockResolvedValue(1);
  Historical.aggregate.mockResolvedValue([{ _id: 'Standard', count: 20 }]);
  Historical.find.mockImplementation(({ source }) => ({
    sort: () => ({ select: () => ({ lean: async () => source === 'bookings' ? [{
      payload: {
        Booking_ID: 'B0001', Guest_ID: 'G0008', Booking_Date: '2026-02-27',
        Booking_Status: 'Completed', Room_Type: 'Standard', Nightly_Rate_NGN: 55000,
        Returning_Guest: 'Yes',
      },
    }] : source === 'payments' ? [{
      payload: {
        Payment_ID: 'P0001', Booking_ID: 'B0001', Booking_Date: '2026-02-27',
        Payment_Status: 'Successful', Total_Revenue_NGN: 70644,
      },
    }] : [] }) }),
  }));
  Historical.countDocuments.mockResolvedValue(0);
});

describe('Verified-stay loyalty', () => {
  it('awards exactly once after checkout, staff check-in approval and matching Paystack success', async () => {
    const result = await reconcileGuest(guestId, new Date('2026-02-01T12:00:00Z'));
    expect(result).toEqual({ created: 1, revoked: 0 });
    expect(Award.updateOne).toHaveBeenCalledWith(
      { booking: bookingId }, expect.objectContaining({
        $setOnInsert: expect.objectContaining({
          booking: bookingId, guest: guestId, points: 20,
          nights: 2, pointsPerNight: 10, paidPayment: paymentId,
        }),
      }), { upsert: true },
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'loyalty.points.awarded' }));
    Award.find.mockResolvedValue([award]);
    Award.updateOne.mockClear();
    const again = await reconcileGuest(guestId, new Date('2026-02-02T12:00:00Z'));
    expect(again.created).toBe(0);
    expect(Award.updateOne).not.toHaveBeenCalled();
  });

  it('never awards for pending bookings, unapproved check-ins or missing/failed/mismatched Paystack payment', async () => {
    const now = new Date('2026-02-01T12:00:00Z');
    Booking.find.mockResolvedValue([]);
    expect((await reconcileGuest(guestId, now)).created).toBe(0);
    Booking.find.mockResolvedValue([booking()]);
    CheckIn.findOne.mockResolvedValue(null);
    expect((await reconcileGuest(guestId, now)).created).toBe(0);
    CheckIn.findOne.mockResolvedValue({ status: 'approved' });
    Payment.findOne.mockResolvedValue(null);
    expect((await reconcileGuest(guestId, now)).created).toBe(0);
    expect(Award.updateOne).not.toHaveBeenCalled();
    expect(Payment.findOne).toHaveBeenCalledWith(expect.objectContaining({
      _id: paymentId, booking: bookingId, guest: guestId,
      amount: 11000000, status: 'success', currency: 'NGN',
    }));
  });

  it('revokes previously credited points after payment verification is lost', async () => {
    Award.find.mockResolvedValue([award]);
    Payment.findOne.mockResolvedValue(null);
    const result = await reconcileGuest(guestId, new Date('2026-02-01T12:00:00Z'));
    expect(result).toEqual({ created: 0, revoked: 1 });
    expect(Award.updateOne).toHaveBeenCalledWith(
      { _id: award._id, revokedAt: null },
      { $set: { revokedAt: expect.any(Date) } },
    );
  });

  it('prevents guests and staff from changing loyalty rules', async () => {
    expect((await request(app).post('/api/v1/loyalty/rules').send({ pointsPerNight: 7 })).status).toBe(401);
    expect((await request(app).post('/api/v1/loyalty/rules').set('Authorization', token('guest')).send({ pointsPerNight: 7 })).status).toBe(403);
    expect((await request(app).post('/api/v1/loyalty/rules').set('Authorization', token('staff')).send({ pointsPerNight: 7 })).status).toBe(403);
    expect((await request(app).post('/api/v1/loyalty/rules').set('Authorization', token('manager')).send({ pointsPerNight: -1 })).status).toBe(400);
    const saved = await request(app).post('/api/v1/loyalty/rules').set('Authorization', token('manager')).send({ pointsPerNight: 7 });
    expect(saved.status).toBe(201);
    expect(saved.body.data.pointsPerNight).toBe(7);
    expect(Rule.create).toHaveBeenCalledWith(expect.objectContaining({ pointsPerNight: 7, changedBy: managerId }));
  });
});

describe('Reporting and personalized suggestions', () => {
  it('keeps source-recorded revenue separate from verified Paystack revenue', async () => {
    const historical = await historicalOverview();
    const live = await liveOverview();
    expect(historical).toMatchObject({
      source: 'historical-data-analyst',
      counts: { bookings: 1, payments: 1, guests: 0, requests: 0 },
      historicalSuccessfulRevenueNGN: 70644, verifiedGatewayPayments: 0,
    });
    expect(live).toMatchObject({ source: 'live-verified', verifiedRevenueKobo: 11000000, verifiedRevenueNGN: 110000, confirmedBookings: 1 });
    expect(live.verifiedRevenueNGN).not.toBe(historical.historicalSuccessfulRevenueNGN);
  });

  it('protects manager historical reporting from guest/staff access', async () => {
    expect((await request(app).get('/api/v1/reports/overview')).status).toBe(401);
    expect((await request(app).get('/api/v1/reports/overview').set('Authorization', token('guest'))).status).toBe(403);
    expect((await request(app).get('/api/v1/reports/historical/guests').set('Authorization', token('staff'))).status).toBe(403);
    expect((await request(app).get('/api/v1/reports/historical/unknown').set('Authorization', token('manager'))).status).toBe(400);
    const response = await request(app).get('/api/v1/reports/overview').set('Authorization', token('manager'));
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveProperty('historical');
    expect(response.body.data).toHaveProperty('live');
    expect(response.headers['cache-control']).toContain('no-store');
  });

  it('scores only gateway-verified guest reservations and aggregated historical popularity', async () => {
    Booking.find.mockReturnValue({
      sort: () => ({ limit: async () => [booking(), { ...booking(), _id: '507f1f77bcf86cd799439088', status: 'pending' }] }),
    });
    Payment.find.mockReturnValue({ select: async () => [{ booking: bookingId }] });
    const suggestions = await recommend(guestId, 3);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      room: { id: 'standard-cozy-haven' },
      source: 'verified-guest-stays', availabilityConfirmed: false,
    });
    expect(Booking.find).toHaveBeenCalledWith({ guest: guestId, status: 'confirmed' });
    expect(Payment.find).toHaveBeenCalledWith(expect.objectContaining({ guest: guestId, status: 'success' }));
    expect((await request(app).get('/api/v1/recommendations/me').set('Authorization', token('manager'))).status).toBe(403);
    expect((await request(app).get('/api/v1/recommendations/me?limit=99').set('Authorization', token('guest'))).status).toBe(400);
  });
});
