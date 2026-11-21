# Group 3 — Hotel, rooms and availability

The current Express module layout is retained. There is one hotel profile under GET /api/v1/hotels/current. Managers may PATCH /api/v1/hotels/current with one or more of name, tagline, description, location or heroImage. Currency is fixed to NGN. If the hotel has not been seeded, the GET endpoint serves the same defaults as the frontend without writing to the database.

Room endpoints:

- GET /api/v1/rooms: public room types with stable slug IDs, inventory, photos, prices in whole NGN, category, capacity, size and amenities.
- GET /api/v1/rooms/:slug: public room details.
- GET /api/v1/rooms/availability?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&guests=2: public date-scoped available room types with availableInventory. Check-in is today or later in Africa/Lagos and stays are 1–365 nights.
- POST /api/v1/rooms: manager-only creation with all room fields.
- PATCH /api/v1/rooms/:slug: manager-only partial updates, including price, inventory and photos. Slugs do not change when names change.
- POST /api/v1/rooms/photos: manager-only multipart upload with form field image; accepts a real JPEG/PNG/WebP under 2 MB, verifies the file signature and returns {url}. Requires Cloudinary credentials.

Room image references are /images/* asset paths hosted by the frontend, or Cloudinary HTTPS image URLs. The frontend retains local asset hosting for the six starter photos. The backend should not receive base64 image data through JSON.

The backend developer can run npm run seed after configuring MongoDB to insert the Guestly hotel and the six original room types exactly once. Existing room data, prices and photos are not overwritten; the seed does not grant any staff or admin roles. Keep any actual credentials outside version control.

Availability calculates the maximum concurrent occupancy across overlapping bookings. Check-out is exclusive, so an arrival on another reservation's check-out date does not conflict. Zero inventory and insufficient guest capacity are excluded. Group 4 will provide the live Booking model. Once registered, the availability service reads confirmed reservations and valid pending holds from that model using room ObjectIds, checkIn/checkOut ISO date strings, status, expiresAt, quantity and guests. Historical dataset records remain separate and never reserve inventory.

Until Group 4 provides atomic booking holds and Paystack confirmation, availability is advisory only. The API and frontend must not treat an availability response as a reservation or mark a payment as verified. The checkout simulator remains available only in the standalone preview, not in live-API mode.

Run npm test to check authentication, route permissions, input validation, inventory calculations, photo types and existing API behavior. Full MongoDB/Cloudinary integration against deployed credentials belongs to the final handover.
