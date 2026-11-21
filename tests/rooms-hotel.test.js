process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/guestly-test';
process.env.JWT_SECRET = 'local-rooms-test-secret-at-least-32-characters';

jest.mock('../src/modules/users/model', () => ({ findById: jest.fn() }));
jest.mock('../src/modules/rooms/model', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../src/modules/hotels/model', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Room = require('../src/modules/rooms/model');
const Hotel = require('../src/modules/hotels/model');
const User = require('../src/modules/users/model');
const app = require('../src/app');
const { peakOccupied, validateStay, localToday } = require('../src/modules/rooms/availability');
const { verifySignature } = require('../src/modules/rooms/photos');

const id = '507f1f77bcf86cd799439011';
const room = {
  _id: id, slug: 'standard-cozy-haven', name: 'Standard Cozy Haven', category: 'Standard',
  image: '/images/standard-cozy-haven.jpg', nightlyRate: 55000, capacity: 2,
  size: 34, bed: 'Queen bed', view: 'City view', amenities: ['Wi-Fi'],
  description: 'A welcoming room', inventory: 3, featured: true,
  save: jest.fn().mockResolvedValue(),
};
function token(role) {
  return 'Bearer ' + jwt.sign({ id, role, sessionVersion: 0 }, process.env.JWT_SECRET);
}
function dates(offset, nights = 2) {
  const today = localToday();
  const start = new Date(today + 'T12:00:00Z');
  start.setUTCDate(start.getUTCDate() + offset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + nights);
  return { checkIn: start.toISOString().slice(0, 10), checkOut: end.toISOString().slice(0, 10) };
}
function fullRoom() {
  const { _id, slug, save, ...fields } = room;
  return fields;
}
beforeEach(() => {
  jest.clearAllMocks();
  room.inventory = 3;
  room.capacity = 2;
  Room.find.mockReturnValue({ sort: jest.fn().mockResolvedValue([room]) });
  Room.findOne.mockResolvedValue(room);
  Room.create.mockImplementation(async data => ({ ...data, _id: id }));
  Hotel.findOne.mockResolvedValue(null);
  Hotel.findOneAndUpdate.mockResolvedValue({ name: 'Guestly Custom', key: 'primary', currency: 'NGN' });
  User.findById.mockResolvedValue({ _id: id, role: 'manager', isActive: true, sessionVersion: 0 });
});

describe('Hotel and room endpoints', () => {
  it('returns the single-hotel defaults before seeding', async () => {
    const response = await request(app).get('/api/v1/hotels/current');
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: 'primary', currency: 'NGN', name: 'Guestly', location: 'Lagos, Nigeria' });
  });

  it('restricts hotel updates to managers', async () => {
    expect((await request(app).patch('/api/v1/hotels/current').send({ tagline: 'New tagline' })).status).toBe(401);
    User.findById.mockResolvedValue({ _id: id, role: 'guest', isActive: true, sessionVersion: 0 });
    expect((await request(app).patch('/api/v1/hotels/current').set('Authorization', token('guest')).send({ tagline: 'New tagline' })).status).toBe(403);
    User.findById.mockResolvedValue({ _id: id, role: 'manager', isActive: true, sessionVersion: 0 });
    const edited = await request(app).patch('/api/v1/hotels/current').set('Authorization', token('manager')).send({ tagline: 'A better stay' });
    expect(edited.status).toBe(200);
    expect(Hotel.findOneAndUpdate).toHaveBeenCalledWith({ key: 'primary' }, expect.objectContaining({ $set: { tagline: 'A better stay' } }), expect.any(Object));
    expect((await request(app).patch('/api/v1/hotels/current').set('Authorization', token('manager')).send({ key: 'another' })).status).toBe(400);
  });

  it('lists rooms and retrieves stable room slugs publicly', async () => {
    const list = await request(app).get('/api/v1/rooms');
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toMatchObject({ id: room.slug, nightlyRate: 55000, inventory: 3 });
    const show = await request(app).get('/api/v1/rooms/standard-cozy-haven');
    expect(show.status).toBe(200);
    Room.findOne.mockResolvedValue(null);
    expect((await request(app).get('/api/v1/rooms/missing-room')).status).toBe(404);
  });

  it('validates a stay and filters by guest capacity', async () => {
    const stay = dates(2);
    const response = await request(app).get('/api/v1/rooms/availability').query({ ...stay, guests: 2 });
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ id: room.slug, availableInventory: 3 });
    expect(Room.find).toHaveBeenCalledWith({ capacity: { $gte: 2 }, inventory: { $gt: 0 } });
    expect((await request(app).get('/api/v1/rooms/availability').query({ ...stay, guests: 4 })).status).toBe(400);
    expect((await request(app).get('/api/v1/rooms/availability').query({ checkIn: stay.checkOut, checkOut: stay.checkIn, guests: 2 })).status).toBe(400);
    expect((await request(app).get('/api/v1/rooms/availability').query({ checkIn: '2020-01-01', checkOut: '2020-01-03', guests: 2 })).status).toBe(400);
  });

  it('uses peak overlapping inventory, not total overlapping bookings', () => {
    const stay = { checkIn: '2027-06-01', checkOut: '2027-06-05' };
    const bookings = [
      { room: id, checkIn: '2027-05-31', checkOut: '2027-06-03', quantity: 2 },
      { room: id, checkIn: '2027-06-03', checkOut: '2027-06-06', quantity: 1 },
      { room: id, checkIn: '2027-06-02', checkOut: '2027-06-04', quantity: 1 },
    ];
    expect(peakOccupied(id, stay, bookings)).toBe(3);
    expect(peakOccupied(id, { checkIn: '2027-06-05', checkOut: '2027-06-07' }, [bookings[0]])).toBe(0);
  });

  it('prevents guests and staff from creating or editing room types', async () => {
    const fields = fullRoom();
    User.findById.mockResolvedValue({ _id: id, role: 'staff', isActive: true, sessionVersion: 0 });
    expect((await request(app).post('/api/v1/rooms').set('Authorization', token('staff')).send(fields)).status).toBe(403);
    User.findById.mockResolvedValue({ _id: id, role: 'guest', isActive: true, sessionVersion: 0 });
    expect((await request(app).patch('/api/v1/rooms/standard-cozy-haven').set('Authorization', token('guest')).send({ inventory: 1 })).status).toBe(403);
  });

  it('allows managers to add and update a room type', async () => {
    const result = await request(app).post('/api/v1/rooms').set('Authorization', token('manager')).send(fullRoom());
    expect(result.status).toBe(201);
    expect(result.body.data.id).toMatch(/^standard-cozy-haven-[0-9a-f]{6}$/);
    const edited = await request(app).patch('/api/v1/rooms/standard-cozy-haven').set('Authorization', token('manager')).send({ inventory: 4 });
    expect(edited.status).toBe(200);
    expect(room.save).toHaveBeenCalled();
    expect(room.inventory).toBe(4);
    expect((await request(app).post('/api/v1/rooms').set('Authorization', token('manager')).send({ ...fullRoom(), inventory: -1 })).status).toBe(400);
  });

  it('verifies binary image signatures and manager-only upload access', async () => {
    expect(verifySignature({ mimetype: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') })).toBe(true);
    expect(verifySignature({ mimetype: 'image/jpeg', buffer: Buffer.from('not a photo') })).toBe(false);
    const image = Buffer.from('89504e470d0a1a0a', 'hex');
    expect((await request(app).post('/api/v1/rooms/photos').attach('image', image, { filename: 'test.png', contentType: 'image/png' })).status).toBe(401);
    const invalid = await request(app).post('/api/v1/rooms/photos').set('Authorization', token('manager'))
      .attach('image', Buffer.from('invalid'), { filename: 'test.png', contentType: 'image/png' });
    expect(invalid.status).toBe(400);
  });


  it('subtracts confirmed reservations and unexpired holds from available rooms', async () => {
    const bookings = [
      { room: id, checkIn: dates(1).checkIn, checkOut: dates(6).checkOut, quantity: 2, guests: 2 },
    ];
    const Booking = mongoose.model('Booking', new mongoose.Schema({}));
    Booking.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(bookings) }),
    });
    const stay = dates(2);
    const response = await request(app).get('/api/v1/rooms/availability').query({ ...stay, guests: 2 });
    expect(response.status).toBe(200);
    expect(response.body.data[0].availableInventory).toBe(1);
    expect(Booking.find).toHaveBeenCalledWith(expect.objectContaining({
      room: { $in: [id] },
      $or: expect.arrayContaining([{ status: 'confirmed' }]),
    }));
  });

  it('prevents inventory or capacity reductions below existing reservations', async () => {
    if (!mongoose.models.Booking) mongoose.model('Booking', new mongoose.Schema({}));
    mongoose.models.Booking.find = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { room: id, checkIn: dates(1).checkIn, checkOut: dates(10).checkOut, quantity: 2, guests: 2 },
        ]),
      }),
    });
    const inventory = await request(app).patch('/api/v1/rooms/standard-cozy-haven')
      .set('Authorization', token('manager')).send({ inventory: 1 });
    expect(inventory.status).toBe(409);
    const capacity = await request(app).patch('/api/v1/rooms/standard-cozy-haven')
      .set('Authorization', token('manager')).send({ capacity: 1 });
    expect(capacity.status).toBe(409);
    expect(room.save).not.toHaveBeenCalled();
  });

  it('does not permit backdated or overly long stays', () => {
    expect(() => validateStay({ checkIn: '2020-01-01', checkOut: '2020-01-03' })).toThrow();
    expect(() => validateStay({ checkIn: '2027-01-01', checkOut: '2029-01-01' })).toThrow();
  });
});
