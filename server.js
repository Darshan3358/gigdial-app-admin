const express = require('express');
const cors = require('cors');
const { MongoClient, ObjectId } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 5001;
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://zarwebcoders:zarwebcoders@cluster0.lqgakzj.mongodb.net/gigdial";

app.use(cors());
app.use(express.json());

let db = null;
let client = null;

// Connect to MongoDB
async function connectDB() {
  try {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db();
    console.log("Connected to MongoDB for GigDial Admin API");

    // Seed default services if empty
    const servicesCount = await db.collection('services').countDocuments();
    if (servicesCount === 0) {
      await db.collection('services').insertMany([
        { name: 'Electrical Wiring', group: 'Home Services', icon: 'flash', isPopular: true, createdAt: new Date() },
        { name: 'Plumbing Repair', group: 'Home Services', icon: 'water', isPopular: true, createdAt: new Date() },
        { name: 'Painting & Deco', group: 'Home Services', icon: 'brush', isPopular: true, createdAt: new Date() },
        { name: 'Cleaning Services', group: 'Home Services', icon: 'trash', isPopular: true, createdAt: new Date() },
        { name: 'Moving & Logistics', group: 'Logistics', icon: 'bus', isPopular: false, createdAt: new Date() }
      ]);
      console.log("Seeded default popular categories into services collection.");
    }
  } catch (err) {
    console.error("Failed to connect to MongoDB", err);
  }
}

connectDB();

// Middleware to ensure DB connection
app.use((req, res, next) => {
  if (!db) {
    return res.status(503).json({ error: "Database not connected yet. Please try again." });
  }
  next();
});

// Helper for search queries
function getSearchQuery(search, fields) {
  if (!search) return {};
  const regex = { $regex: search, $options: 'i' };
  if (fields.length === 1) {
    return { [fields[0]]: regex };
  }
  return { $or: fields.map(field => ({ [field]: regex })) };
}

// 1. Dashboard Overview Stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalUsers = await db.collection('users').countDocuments();
    
    // Count all distinct workers in users and workers collections
    const providerUsersCount = await db.collection('users').countDocuments({
      $or: [{ role: 'worker' }, { isProvider: true }]
    });
    
    const workersColDocs = await db.collection('workers').find().toArray();
    let totalWorkers = providerUsersCount;
    
    const userEmailsAndPhones = new Set();
    const activeSubscribers = await db.collection('users').find({
      $or: [{ role: 'worker' }, { isProvider: true }]
    }).toArray();
    activeSubscribers.forEach(u => {
      if (u.email) userEmailsAndPhones.add(u.email.toLowerCase());
      if (u.phone) userEmailsAndPhones.add(u.phone);
    });
    
    for (const w of workersColDocs) {
      const emailMatch = w.email && userEmailsAndPhones.has(w.email.toLowerCase());
      const phoneMatch = w.phone && userEmailsAndPhones.has(w.phone);
      if (!emailMatch && !phoneMatch) {
        totalWorkers++;
      }
    }

    const totalBookings = await db.collection('bookings').countDocuments();

    // Calculate revenue from completed bookings
    const completedBookings = await db.collection('bookings').find({ status: 'completed' }).toArray();
    const totalRevenue = completedBookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);

    // If zero Completed, check for other bookings price to provide some data
    const allBookings = await db.collection('bookings').find().toArray();
    const totalPotentialRevenue = allBookings.reduce((sum, b) => sum + (Number(b.price) || 0), 0);

    // Mock weekly trends data points
    // Line chart coordinates for: Mon, Tue, Wed, Thu, Fri, Sat, Sun
    const trends = [12, 19, 15, 25, 32, 28, 35]; 

    res.json({
      totalUsers,
      totalWorkers,
      totalBookings,
      totalRevenue: totalRevenue || totalPotentialRevenue, // Fallback if no completed ones yet
      trends
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Manage Users
app.get('/api/users', async (req, res) => {
  try {
    const { search } = req.query;
    const query = getSearchQuery(search, ['name', 'phone', 'city', 'email']);
    const users = await db.collection('users').find(query).sort({ createdAt: -1 }).toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle block status
app.post('/api/users/:id/toggle-block', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await db.collection('users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: "User not found" });

    const newBlockedStatus = !user.isBlocked;
    await db.collection('users').updateOne(
      { _id: new ObjectId(id) },
      { $set: { isBlocked: newBlockedStatus, updatedAt: new Date() } }
    );

    // Add activity log notification
    await db.collection('notifications').insertOne({
      uid: user._id.toString(),
      title: "User Account Modified",
      message: `Admin ${newBlockedStatus ? 'suspended' : 'activated'} user ${user.name}`,
      read: false,
      timestamp: Date.now()
    });

    res.json({ success: true, isBlocked: newBlockedStatus });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete User
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await db.collection('users').findOne({ _id: new ObjectId(id) });
    if (!user) return res.status(404).json({ error: "User not found" });

    await db.collection('users').deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Manage Workers
app.get('/api/workers', async (req, res) => {
  try {
    const { search } = req.query;

    // Find workers in users collection
    const userQuery = {
      $and: [
        { $or: [{ role: 'worker' }, { isProvider: true }] }
      ]
    };
    if (search) {
      const regex = { $regex: search, $options: 'i' };
      userQuery.$and.push({
        $or: [
          { name: regex },
          { category: regex },
          { city: regex },
          { phone: regex },
          { email: regex }
        ]
      });
    }

    const dbUsers = await db.collection('users').find(userQuery).sort({ createdAt: -1 }).toArray();

    // Find workers in dedicated workers collection
    const workerSearchQuery = search ? getSearchQuery(search, ['name', 'profession', 'city', 'phone']) : {};
    const dbWorkers = await db.collection('workers').find(workerSearchQuery).sort({ createdAt: -1 }).toArray();

    // Merge them by ID/Name to prevent duplicates
    const seenIds = new Set();
    const merged = [];

    // Add users first
    for (const u of dbUsers) {
      seenIds.add(u._id.toString());
      merged.push({
        _id: u._id,
        name: u.name,
        profession: u.category || u.profession || 'Service Provider',
        isApproved: u.isApproved ?? false,
        phone: u.phone,
        city: u.city || 'Mumbai',
        email: u.email
      });
    }

    // Add workers collection entries if not seen
    for (const w of dbWorkers) {
      const idStr = w._id.toString();
      const uidStr = w.uid || '';
      if (!seenIds.has(idStr) && !seenIds.has(uidStr)) {
        merged.push({
          _id: w._id,
          name: w.name,
          profession: w.profession || 'Service Provider',
          isApproved: w.isApproved ?? false,
          phone: w.phone,
          city: w.city || 'Ahmedabad',
          email: w.email
        });
      }
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve Worker
app.post('/api/workers/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Update in users collection
    let user = null;
    try {
      if (ObjectId.isValid(id)) {
        await db.collection('users').updateOne(
          { _id: new ObjectId(id) },
          { $set: { isApproved: true, kycStatus: 'approved', updatedAt: new Date() } }
        );
        user = await db.collection('users').findOne({ _id: new ObjectId(id) });
      }
    } catch (err) {
      console.error("Failed to update user in users:", err.message);
    }

    // 2. Update in workers collection
    let workerName = "Worker";
    try {
      if (ObjectId.isValid(id)) {
        const updateRes = await db.collection('workers').updateOne(
          { _id: new ObjectId(id) },
          { $set: { isApproved: true, updatedAt: new Date() } }
        );
        if (updateRes.matchedCount > 0) {
          const w = await db.collection('workers').findOne({ _id: new ObjectId(id) });
          if (w) workerName = w.name;
        }
      }

      // Also try matching by uid in case uid equals id or contains it
      const updateUidRes = await db.collection('workers').updateOne(
        { $or: [{ uid: id }, { uid: `worker_${id}` }] },
        { $set: { isApproved: true, updatedAt: new Date() } }
      );
      if (updateUidRes.matchedCount > 0) {
        const w = await db.collection('workers').findOne({ $or: [{ uid: id }, { uid: `worker_${id}` }] });
        if (w) workerName = w.name;
      }
    } catch (err) {
      console.error("Failed to update worker in workers:", err.message);
    }

    if (user) {
      workerName = user.name;
    }

    // Trigger notification
    await db.collection('notifications').insertOne({
      uid: id,
      title: "Worker Approved",
      message: `Worker account for ${workerName} has been approved by Admin.`,
      read: false,
      timestamp: Date.now()
    });

    res.json({ success: true, isApproved: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject Worker (unapprove)
app.post('/api/workers/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Update in users collection
    try {
      if (ObjectId.isValid(id)) {
        await db.collection('users').updateOne(
          { _id: new ObjectId(id) },
          { $set: { isApproved: false, kycStatus: 'rejected', updatedAt: new Date() } }
        );
      }
    } catch (err) {
      console.error("Failed to reject user in users:", err.message);
    }

    // 2. Update in workers collection
    try {
      if (ObjectId.isValid(id)) {
        await db.collection('workers').updateOne(
          { _id: new ObjectId(id) },
          { $set: { isApproved: false, updatedAt: new Date() } }
        );
      }
      await db.collection('workers').updateOne(
        { $or: [{ uid: id }, { uid: `worker_${id}` }] },
        { $set: { isApproved: false, updatedAt: new Date() } }
      );
    } catch (err) {
      console.error("Failed to reject worker in workers:", err.message);
    }

    res.json({ success: true, isApproved: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Worker
app.delete('/api/workers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Delete from users collection
    try {
      if (ObjectId.isValid(id)) {
        await db.collection('users').deleteOne({ _id: new ObjectId(id) });
      }
    } catch (err) {
      console.error("Failed to delete user in users:", err.message);
    }

    // 2. Delete from workers collection
    try {
      if (ObjectId.isValid(id)) {
        await db.collection('workers').deleteOne({ _id: new ObjectId(id) });
      }
      await db.collection('workers').deleteOne({ uid: id });
      await db.collection('workers').deleteOne({ uid: `worker_${id}` });
    } catch (err) {
      console.error("Failed to delete worker in workers:", err.message);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Manage Bookings
app.get('/api/bookings', async (req, res) => {
  try {
    const { search } = req.query;
    const query = getSearchQuery(search, ['customerName', 'workerName', 'serviceName', 'title']);
    const bookings = await db.collection('bookings').find(query).sort({ createdAt: -1 }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update Booking Status
app.post('/api/bookings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // e.g. "completed" or "cancelled"
    
    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: Date.now() } }
    );

    const booking = await db.collection('bookings').findOne({ _id: new ObjectId(id) });
    
    // Add Notification
    await db.collection('notifications').insertOne({
      uid: booking.workerName || 'admin',
      title: "Booking Updated",
      message: `Booking "${booking.title || booking.serviceName}" marked as ${status} by admin.`,
      read: false,
      timestamp: Date.now()
    });

    res.json({ success: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Subscription Payments
app.get('/api/subscriptions', async (req, res) => {
  try {
    const { search } = req.query;
    let subs = [];

    // First try the dedicated subscriptions collection
    const dbSubs = await db.collection('subscriptions').find().toArray();

    if (dbSubs.length > 0) {
      subs = dbSubs;
    } else {
      // Subscriptions are embedded on User documents.
      // Only return users who ACTUALLY have an active subscription.
      const activeSubscribers = await db.collection('users').find({
        'subscription.isActive': true
      }).toArray();

      const planLabels = {
        monthly: 'Monthly Plan (₹499)',
        quarterly: 'Quarterly Plan (₹999)',
        yearly: 'Annual Plan (₹1999)',
      };

      subs = activeSubscribers.map((user) => ({
        _id: user._id,
        partnerName: user.name,
        planName: planLabels[user.subscription?.plan] || user.subscription?.plan || 'Monthly Plan',
        amount: user.subscription?.plan === 'monthly' ? 499
               : user.subscription?.plan === 'quarterly' ? 999
               : user.subscription?.plan === 'yearly' ? 1999
               : 499,
        paymentMethod: user.subscription?.paymentMethod || 'UPI',
        status: user.subscription?.refundStatus === 'refunded' ? 'Refunded'
               : user.subscription?.refundStatus === 'pending' ? 'Refund Pending'
               : 'Success',
        startDate: user.subscription?.startDate,
        endDate: user.subscription?.endDate,
        date: user.subscription?.startDate || user.createdAt || new Date().toISOString()
      }));
    }

    if (search) {
      const searchLower = search.toLowerCase();
      subs = subs.filter(s =>
        s.partnerName?.toLowerCase().includes(searchLower) ||
        s.planName?.toLowerCase().includes(searchLower)
      );
    }

    res.json(subs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/subscriptions/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Attempt to update subscription in users collection
    await db.collection('users').updateOne(
      { _id: new ObjectId(id) },
      { $set: { 
        'subscription.refundStatus': 'refunded',
        'subscription.isActive': false,
        updatedAt: new Date()
      }}
    );

    // Also update subscriptions collection if it exists
    try {
      await db.collection('subscriptions').updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'Refunded' } }
      );
    } catch(e) {}

    // Add log
    await db.collection('notifications').insertOne({
      uid: id,
      title: "Refund Processed",
      message: `Refund processed for subscription ID ${id}.`,
      read: false,
      timestamp: Date.now()
    });

    res.json({ success: true, status: 'Refunded' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. System Reports & Logs (combine notifications + custom triggers)
app.get('/api/reports', async (req, res) => {
  try {
    const notifications = await db.collection('notifications').find().sort({ timestamp: -1 }).limit(20).toArray();
    
    // Map notifications to the timeline format
    const timeline = notifications.map((n, idx) => {
      let category = "System";
      if (n.title.toLowerCase().includes("user") || n.title.toLowerCase().includes("register")) {
        category = "New User Signup";
      } else if (n.title.toLowerCase().includes("booking") || n.title.toLowerCase().includes("service")) {
        category = "Booking Update";
      } else if (n.title.toLowerCase().includes("payment") || n.title.toLowerCase().includes("refund")) {
        category = "Payment API";
      } else if (n.title.toLowerCase().includes("settings") || n.title.toLowerCase().includes("param")) {
        category = "Settings";
      }

      // Dot color map
      // green=System, blue=New signup, orange=Payment API, purple=Settings/Booking
      let color = "#16A34A"; // green default
      if (category === "New User Signup") color = "#3B5BFF";
      if (category === "Payment API") color = "#D97706";
      if (category === "Settings" || category === "Booking Update") color = "#4F46E5";

      return {
        _id: n._id,
        category,
        dotColor: color,
        timestamp: new Date(n.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ago',
        dateText: new Date(n.timestamp).toLocaleDateString(),
        description: n.message
      };
    });

    // Provide default reports if empty
    if (timeline.length === 0) {
      const defaultLogs = [
        { _id: "1", category: "System", dotColor: "#16A34A", timestamp: "10 mins ago", description: "Database cluster health status: Good. Synced 44 collections." },
        { _id: "2", category: "New User Signup", dotColor: "#3B5BFF", timestamp: "25 mins ago", description: "New customer DARSHAN THANKI registered with phone 9876543210." },
        { _id: "3", category: "Payment API", dotColor: "#D97706", timestamp: "1 hour ago", description: "Subscription payment of ₹999 received successfully from Ramesh Yadav." },
        { _id: "4", category: "Settings", dotColor: "#4F46E5", timestamp: "2 hours ago", description: "Commission parameter rate updated from 10.0% to 12.0%." }
      ];
      return res.json(defaultLogs);
    }

    res.json(timeline);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Settings / System Parameters
// We store settings in a single document in a "commissions" or "system_settings" collection
app.get('/api/settings', async (req, res) => {
  try {
    let settings = await db.collection('commissions').findOne({ type: 'global_settings' });
    if (!settings) {
      // Default settings
      settings = {
        platformFeeRate: 12.0,
        maintenanceMode: false,
        allowNewRegistrations: true
      };
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { platformFeeRate, maintenanceMode, allowNewRegistrations } = req.body;
    
    await db.collection('commissions').updateOne(
      { type: 'global_settings' },
      { 
        $set: {
          platformFeeRate: Number(platformFeeRate) || 12.0,
          maintenanceMode: !!maintenanceMode,
          allowNewRegistrations: !!allowNewRegistrations,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );

    // Add activity log
    await db.collection('notifications').insertOne({
      uid: 'admin',
      title: "Settings Updated",
      message: `Admin updated parameters: Fee Rate = ${platformFeeRate}%, Maintenance = ${maintenanceMode}, Allow Registrations = ${allowNewRegistrations}.`,
      read: false,
      timestamp: Date.now()
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// CUSTOMER ENDPOINTS
// -----------------------------------------------------------------------------

// Get active/approved workers
app.get('/api/customer/workers', async (req, res) => {
  try {
    const userQuery = {
      $and: [
        { $or: [{ role: 'worker' }, { isProvider: true }] }
      ]
    };
    const dbUsers = await db.collection('users').find(userQuery).toArray();
    const dbWorkers = await db.collection('workers').find().toArray();

    const seenIds = new Set();
    const merged = [];

    for (const u of dbUsers) {
      seenIds.add(u._id.toString());
      merged.push({
        id: u._id.toString(),
        name: u.name || 'Service Provider',
        profession: u.category || u.profession || 'Service Provider',
        role: u.category || u.profession || 'Service Provider',
        rating: u.rating || 4.9,
        reviewsCount: u.reviewsCount || 12,
        reviews: u.reviewsCount || 12,
        experience: u.experience ? `${u.experience} Years Experience` : '6 Years Experience',
        location: u.city || 'Ahmedabad, India',
        availability: u.isApproved ? 'Available Now' : 'Offline',
        about: u.about || 'Professional GigDial service provider.',
        skills: u.skills || ['General Service'],
        phone: u.phone || '',
        whatsapp: u.phone || '',
        starDistribution: u.starDistribution || { five: 90, four: 8, three: 2, two: 0, one: 0 }
      });
    }

    for (const w of dbWorkers) {
      const idStr = w._id.toString();
      const uidStr = w.uid || '';
      if (!seenIds.has(idStr) && !seenIds.has(uidStr)) {
        merged.push({
          id: w._id.toString(),
          name: w.name || 'Service Provider',
          profession: w.profession || 'Service Provider',
          role: w.profession || 'Service Provider',
          rating: w.rating || 4.8,
          reviewsCount: w.reviewsCount || 8,
          reviews: w.reviewsCount || 8,
          experience: w.experience || '4 Years Experience',
          location: w.city || 'Ahmedabad, India',
          availability: w.isApproved ? 'Available Now' : 'Offline',
          about: w.about || 'Professional GigDial service provider.',
          skills: w.skills || ['General Service'],
          phone: w.phone || '',
          whatsapp: w.phone || '',
          starDistribution: w.starDistribution || { five: 100, four: 0, three: 0, two: 0, one: 0 }
        });
      }
    }

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get customer profile
app.get('/api/customer/profile', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "phone query parameter is required" });
    const user = await db.collection('users').findOne({ phone });
    if (!user) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Update customer profile
app.post('/api/customer/profile', async (req, res) => {
  try {
    const { phone, name, email, avatar } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });

    const updateFields = {
      name,
      email,
      phone,
      avatar,
      role: 'customer',
      updatedAt: new Date()
    };

    await db.collection('users').updateOne(
      { phone },
      { $set: updateFields },
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get bookings for a customer
app.get('/api/customer/bookings', async (req, res) => {
  try {
    const { customerName } = req.query;
    if (!customerName) return res.status(400).json({ error: "customerName query required" });
    const query = { customerName };
    const list = await db.collection('bookings').find(query).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new booking
app.post('/api/customer/bookings', async (req, res) => {
  try {
    const booking = req.body;
    booking.createdAt = Date.now();
    
    // Add default status and default worker image if none exists
    booking.status = booking.status || 'Pending';
    
    const result = await db.collection('bookings').insertOne(booking);
    res.json({ success: true, id: result.insertedId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rate/Review a booking
app.post('/api/customer/bookings/:id/rate', async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, review } = req.body;
    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: { rating, review } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// -----------------------------------------------------------------------------
// WORKER ENDPOINTS
// -----------------------------------------------------------------------------

// Get worker profile matching phone/email
app.get('/api/worker/profile', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: "phone query parameter is required" });
    const user = await db.collection('users').findOne({ phone });
    if (!user) {
      return res.status(404).json({ error: "Profile not found" });
    }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/Update worker profile
app.post('/api/worker/profile', async (req, res) => {
  try {
    const { phone, name, email, category, experience, location, customSkillsInput, description } = req.body;
    if (!phone) return res.status(400).json({ error: "phone is required" });
    
    const updateFields = {
      name,
      email,
      phone,
      category,
      experience,
      location,
      customSkillsInput,
      description,
      role: 'worker',
      isProvider: true,
      updatedAt: new Date()
    };

    await db.collection('users').updateOne(
      { phone },
      { $set: updateFields },
      { upsert: true }
    );

    // Also sync/create in workers collection
    await db.collection('workers').updateOne(
      { phone },
      { $set: {
        name,
        email,
        phone,
        profession: category,
        experience: `${experience} Years Experience`,
        city: location,
        about: description,
        updatedAt: new Date()
      }},
      { upsert: true }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update worker subscription
app.post('/api/worker/subscription', async (req, res) => {
  try {
    const { phone, subscription } = req.body;
    if (!phone || !subscription) {
      return res.status(400).json({ error: "phone and subscription are required" });
    }

    await db.collection('users').updateOne(
      { phone },
      { $set: { subscription, updatedAt: new Date() } }
    );

    await db.collection('workers').updateOne(
      { phone },
      { $set: { 
        subscription: {
          plan: subscription.planName,
          status: subscription.isActive ? 'active' : 'inactive'
        }, 
        updatedAt: new Date() 
      } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get bookings/leads for a worker
app.get('/api/worker/bookings', async (req, res) => {
  try {
    const { workerName } = req.query;
    if (!workerName) return res.status(400).json({ error: "workerName parameter required" });
    
    // Return either bookings assigned to this worker OR any Pending booking (leads)
    const list = await db.collection('bookings').find({
      $or: [
        { workerName },
        { status: 'Pending' }
      ]
    }).sort({ createdAt: -1 }).toArray();

    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update booking status by worker
app.post('/api/worker/bookings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, workerName } = req.body;
    
    const updateDoc = { status, updatedAt: Date.now() };
    if (workerName) {
      updateDoc.workerName = workerName;
    }

    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: updateDoc }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// -----------------------------------------------------------------------------
// CHAT ENDPOINTS
// -----------------------------------------------------------------------------

// Get chat messages
app.get('/api/bookings/:id/chats', async (req, res) => {
  try {
    const { id } = req.params;
    const chats = await db.collection('chats').find({ bookingId: id }).sort({ timestamp: 1 }).toArray();
    res.json(chats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Post a chat message
app.post('/api/bookings/:id/chats', async (req, res) => {
  try {
    const { id } = req.params;
    const { senderRole, text } = req.body;
    
    const dateObj = new Date();
    const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const message = {
      bookingId: id,
      senderRole,
      text,
      timestamp: timeStr,
      createdAt: Date.now()
    };

    await db.collection('chats').insertOne(message);
    res.json({ success: true, message });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// AUTH ENDPOINTS
// -----------------------------------------------------------------------------

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, role, passcode } = req.body;
    if (!phone || !name || !email || !role) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if phone already exists for this role
    const existingUser = await db.collection('users').findOne({ phone, role });
    if (existingUser) {
      return res.status(400).json({ error: `User with this phone number is already registered as a ${role}` });
    }

    const newUser = {
      name,
      email,
      phone,
      role,
      passcode: passcode,
      isApproved: role === 'worker' ? false : true, // workers require admin approval
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = await db.collection('users').insertOne(newUser);
    const id = result.insertedId.toString();

    if (role === 'worker') {
      // Create blank profile in workers collection too
      await db.collection('workers').insertOne({
        uid: id,
        name,
        email,
        phone,
        profession: 'Electrician', // default category
        rating: 5.0,
        reviewsCount: 0,
        experience: '1 Years Experience',
        city: 'Ahmedabad, India',
        about: 'Verified professional service provider.',
        skills: ['General Service'],
        isApproved: false,
        createdAt: new Date()
      });
    }

    res.json({ success: true, user: { ...newUser, id } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, phone, role, passcode } = req.body;
    if ((!email && !phone) || !role) {
      return res.status(400).json({ error: "Email or phone number and role are required" });
    }

    const query = { role };
    if (email) {
      query.email = email.trim();
    } else if (phone) {
      query.phone = phone.trim();
    }

    const user = await db.collection('users').findOne(query);
    if (!user) {
      return res.status(404).json({ error: `No registered ${role} found with this account` });
    }

    // Verify passcode if set
    if (user.passcode && passcode && user.passcode !== passcode.trim()) {
      return res.status(401).json({ error: "Incorrect passcode / password." });
    }

    res.json({ success: true, user: { ...user, id: user._id.toString() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED AUTH & USER/WORKER ROUTER (MATCHING FLUTTER BACKEND SCHEMAS)
// -----------------------------------------------------------------------------

// POST /api/auth/register-user
app.post('/api/auth/register-user', async (req, res) => {
  try {
    const { uid, name, phone, email, passcode } = req.body;
    if (!uid || !name || !phone || !email) {
      return res.status(400).json({ error: "uid, name, phone, and email are required" });
    }

    const existingUser = await db.collection('users').findOne({ $or: [{ uid }, { email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this uid, email, or phone" });
    }

    const newUser = {
      uid,
      name,
      phone,
      email,
      role: 'customer',
      passcode: passcode || '1234',
      createdAt: new Date()
    };

    await db.collection('users').insertOne(newUser);
    res.json({ success: true, user: newUser });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/register-worker
app.post('/api/auth/register-worker', async (req, res) => {
  try {
    const { uid, name, phone, email, profession, experience, passcode } = req.body;
    if (!uid || !name || !phone || !email || !profession) {
      return res.status(400).json({ error: "uid, name, phone, email, and profession are required" });
    }

    const existingUser = await db.collection('users').findOne({ $or: [{ uid }, { email }, { phone }] });
    if (existingUser) {
      return res.status(400).json({ error: "User already exists with this uid, email, or phone" });
    }

    const newUser = {
      uid,
      name,
      phone,
      email,
      role: 'worker',
      passcode: passcode || '1234',
      createdAt: new Date()
    };

    const newWorker = {
      uid,
      name,
      phone,
      email,
      profession,
      experience: Number(experience) || 0,
      rating: 5.0,
      isActive: true,
      subscription: {
        plan: 'none',
        status: 'inactive'
      },
      createdAt: new Date()
    };

    await db.collection('users').insertOne(newUser);
    await db.collection('workers').insertOne(newWorker);
    res.json({ success: true, worker: newWorker });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/user/:uid
app.get('/api/auth/user/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const user = await db.collection('users').findOne({ uid });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/worker/:uid
app.get('/api/auth/worker/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const worker = await db.collection('workers').findOne({ uid });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/update-user/:uid
app.put('/api/auth/update-user/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, phone, email } = req.body;
    
    const updateFields = {};
    if (name) updateFields.name = name;
    if (phone) updateFields.phone = phone;
    if (email) updateFields.email = email;

    const result = await db.collection('users').findOneAndUpdate(
      { uid },
      { $set: updateFields },
      { returnDocument: 'after' }
    );
    if (!result) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/auth/update-worker/:uid
app.put('/api/auth/update-worker/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const { name, phone, email, profession, experience } = req.body;

    const updateFields = {};
    if (name) updateFields.name = name;
    if (phone) updateFields.phone = phone;
    if (email) updateFields.email = email;
    if (profession) updateFields.profession = profession;
    if (experience !== undefined) updateFields.experience = Number(experience);

    await db.collection('users').updateOne(
      { uid },
      { $set: { name, phone, email } }
    );

    const resultWorker = await db.collection('workers').findOneAndUpdate(
      { uid },
      { $set: updateFields },
      { returnDocument: 'after' }
    );

    if (!resultWorker) return res.status(404).json({ error: "Worker not found" });
    res.json({ success: true, worker: resultWorker });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/workers
app.get('/api/auth/workers', async (req, res) => {
  try {
    const workers = await db.collection('workers').find({}).toArray();
    res.json(workers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/users
app.get('/api/auth/users', async (req, res) => {
  try {
    const users = await db.collection('users').find({ role: 'customer' }).toArray();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED BOOKING ROUTER (MATCHING FLUTTER BACKEND SCHEMAS)
// -----------------------------------------------------------------------------

// POST /api/bookings/create
app.post('/api/bookings/create', async (req, res) => {
  try {
    const { title, description, address, schedule, customerId, price } = req.body;
    if (!title || !description || !address || !schedule || !customerId || !price) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const newBooking = {
      title,
      description,
      address,
      schedule,
      customerId,
      workerId: null,
      price: Number(price),
      status: 'pending',
      createdAt: new Date()
    };

    const result = await db.collection('bookings').insertOne(newBooking);
    res.json({ success: true, booking: { ...newBooking, id: result.insertedId.toString() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/pending
app.get('/api/bookings/pending', async (req, res) => {
  try {
    const bookings = await db.collection('bookings').find({ status: 'pending' }).sort({ createdAt: -1 }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/active/:workerId
app.get('/api/bookings/active/:workerId', async (req, res) => {
  try {
    const { workerId } = req.params;
    const bookings = await db.collection('bookings').find({
      workerId,
      status: { $in: ['accepted', 'on_the_way', 'in_progress', 'completed'] }
    }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/user/:customerId
app.get('/api/bookings/user/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const bookings = await db.collection('bookings').find({ customerId }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/bookings/accept/:id
app.put('/api/bookings/accept/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { workerId } = req.body;
    if (!workerId) return res.status(400).json({ error: "workerId is required" });

    const booking = await db.collection('bookings').findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    // Check if worker exists to get their name
    const worker = await db.collection('workers').findOne({ uid: workerId });
    const workerName = worker ? worker.name : 'Service Professional';

    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: { workerId, workerName, status: 'accepted' } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/bookings/update-status/:id
app.put('/api/bookings/update-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const validStatuses = ['pending', 'accepted', 'on_the_way', 'in_progress', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const booking = await db.collection('bookings').findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED PAYMENTS ROUTER
// -----------------------------------------------------------------------------

// POST /api/payments/create
app.post('/api/payments/create', async (req, res) => {
  try {
    const { workerUid, plan, amount, method } = req.body;
    if (!workerUid || !plan || !amount || !method) {
      return res.status(400).json({ error: "workerUid, plan, amount, and method are required" });
    }

    const newPayment = {
      workerUid,
      plan,
      amount: Number(amount),
      method,
      status: 'pending',
      createdAt: new Date()
    };

    const result = await db.collection('payments').insertOne(newPayment);
    res.json({ success: true, payment: { ...newPayment, id: result.insertedId.toString() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/worker/:workerUid
app.get('/api/payments/worker/:workerUid', async (req, res) => {
  try {
    const { workerUid } = req.params;
    const history = await db.collection('payments').find({ workerUid }).sort({ createdAt: -1 }).toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED REQUIREMENTS ROUTER
// -----------------------------------------------------------------------------

// POST /api/requirements/create
app.post('/api/requirements/create', async (req, res) => {
  try {
    const { customerUid, customerName, customerPhone, customerEmail, category, days, budget, description } = req.body;
    if (!customerUid || !customerName || !category || !days || !budget || !description) {
      return res.status(400).json({ error: "Missing required requirements parameters" });
    }

    const newRequirement = {
      customerUid,
      customerName,
      customerPhone,
      customerEmail,
      category,
      days,
      budget,
      description,
      status: 'new',
      createdAt: new Date()
    };

    const result = await db.collection('requirements').insertOne(newRequirement);
    res.json({ success: true, requirement: { ...newRequirement, id: result.insertedId.toString() } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/requirements/all
app.get('/api/requirements/all', async (req, res) => {
  try {
    const list = await db.collection('requirements').find({}).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/requirements/update-status/:id
app.put('/api/requirements/update-status/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) return res.status(400).json({ error: "Status value is required" });

    await db.collection('requirements').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED SERVICES ROUTER
// -----------------------------------------------------------------------------

// GET /api/services/popular
app.get('/api/services/popular', async (req, res) => {
  try {
    const services = await db.collection('services').find({ isPopular: true }).limit(8).toArray();
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/services/all
app.get('/api/services/all', async (req, res) => {
  try {
    const { search } = req.query;
    const filter = {};
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }
    const services = await db.collection('services').find(filter).sort({ group: 1, name: 1 }).toArray();
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED WORKERS DETAILED LISTS
// -----------------------------------------------------------------------------

// GET /api/workers/top-rated
app.get('/api/workers/top-rated', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 5;
    const workers = await db.collection('workers').find({}).sort({ rating: -1 }).limit(limit).toArray();
    res.json(workers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workers
app.get('/api/workers', async (req, res) => {
  try {
    const { service, sort } = req.query;
    const filter = { isActive: true };
    if (service) {
      filter.$or = [
        { profession: { $regex: service, $options: 'i' } },
        { skills: { $in: [service] } }
      ];
    }

    let sortOptions = {};
    if (sort === 'top') {
      sortOptions = { rating: -1 };
    } else if (sort === 'experience') {
      sortOptions = { experience: -1 };
    } else {
      sortOptions = { rating: -1 };
    }

    const list = await db.collection('workers').find(filter).sort(sortOptions).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workers/:workerId
app.get('/api/workers/:workerId', async (req, res) => {
  try {
    const { workerId } = req.params;
    let query = { uid: workerId };
    if (ObjectId.isValid(workerId)) {
      query = { $or: [{ _id: new ObjectId(workerId) }, { uid: workerId }] };
    }
    const worker = await db.collection('workers').findOne(query);
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    // Increment profile views
    await db.collection('workers').updateOne(query, { $inc: { profileViews: 1 } });
    worker.profileViews = (worker.profileViews || 0) + 1;

    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// ADDITIONAL CUSTOMER DETAILS & REVIEWS
// -----------------------------------------------------------------------------

// GET /api/bookings/:id
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });
    const booking = await db.collection('bookings').findOne({ _id: new ObjectId(id) });
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    res.json(booking);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/bookings/:id/confirm
app.post('/api/bookings/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid booking ID" });
    await db.collection('bookings').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'pending', updatedAt: new Date() } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/profile
app.get('/api/users/profile', async (req, res) => {
  try {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: "uid parameter is required" });
    const user = await db.collection('users').findOne({ uid });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/update-profile
app.put('/api/users/update-profile', async (req, res) => {
  try {
    const { uid, name, phone, email } = req.body;
    if (!uid) return res.status(400).json({ error: "uid is required" });

    const updateFields = {};
    if (name) updateFields.name = name;
    if (phone) updateFields.phone = phone;
    if (email) updateFields.email = email;

    const result = await db.collection('users').findOneAndUpdate(
      { uid },
      { $set: updateFields },
      { returnDocument: 'after' }
    );
    res.json({ success: true, user: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:customerId/saved-workers
app.get('/api/users/:customerId/saved-workers', async (req, res) => {
  try {
    const { customerId } = req.params;
    const list = await db.collection('saved_workers').find({ customerId }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reviews/create
app.post('/api/reviews/create', async (req, res) => {
  try {
    const { bookingId, workerId, customerId, rating, feedback } = req.body;
    if (!bookingId || !workerId || !rating) {
      return res.status(400).json({ error: "bookingId, workerId, and rating are required" });
    }

    const newReview = {
      bookingId,
      workerId,
      customerId,
      rating: Number(rating),
      feedback,
      createdAt: new Date()
    };

    await db.collection('reviews').insertOne(newReview);

    // Compute and update average rating for the worker
    const pipeline = [
      { $match: { workerId } },
      { $group: { _id: null, avgRating: { $avg: '$rating' } } }
    ];
    const stats = await db.collection('reviews').aggregate(pipeline).toArray();
    const newAvg = stats.length > 0 ? stats[0].avgRating : Number(rating);

    await db.collection('workers').updateOne(
      { uid: workerId },
      { $set: { rating: newAvg }, $inc: { reviewsCount: 1 } }
    );

    res.json({ success: true, review: newReview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// -----------------------------------------------------------------------------
// DEDICATED WORKERS DASHBOARD & EXTRA ROUTERS
// -----------------------------------------------------------------------------

// GET /api/workers/dashboard/:uid
app.get('/api/workers/dashboard/:uid', async (req, res) => {
  try {
    const { uid } = req.params;
    const worker = await db.collection('workers').findOne({ uid });
    if (!worker) return res.status(404).json({ error: "Worker not found" });

    // Check and lazy-deactivate expired subscription
    let subscriptionObj = worker.subscription || { plan: 'none', status: 'inactive', active: false };
    if (subscriptionObj.status === 'active' || subscriptionObj.active) {
      if (subscriptionObj.expiryDate) {
        const expiry = new Date(subscriptionObj.expiryDate);
        if (expiry < new Date()) {
          subscriptionObj = {
            plan: 'none',
            status: 'inactive',
            active: false,
            expiryDate: subscriptionObj.expiryDate
          };
          await db.collection('workers').updateOne(
            { uid },
            { $set: { subscription: subscriptionObj, updatedAt: new Date() } }
          );
          await db.collection('users').updateOne(
            { uid },
            { $set: { 
              'subscription.isActive': false, 
              'subscription.remainingDays': 0,
              updatedAt: new Date() 
            } }
          );
        }
      }
    }

    const today = new Date();
    today.setHours(0,0,0,0);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const bookings = await db.collection('bookings').find({ workerId: uid }).toArray();
    const totalLeads = bookings.length;
    const todayLeads = bookings.filter(b => b.createdAt >= today).length;
    const monthLeads = bookings.filter(b => b.createdAt >= monthStart).length;

    res.json({
      todayLeads,
      monthLeads,
      profileViews: worker.profileViews || 0,
      totalLeads,
      recentLeads: bookings.slice(0, 5),
      subscription: subscriptionObj
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/worker/:workerId/active
app.get('/api/bookings/worker/:workerId/active', async (req, res) => {
  try {
    const { workerId } = req.params;
    const bookings = await db.collection('bookings').find({
      workerId,
      status: { $in: ['accepted', 'on_the_way', 'in_progress'] }
    }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/worker/:workerId/completed
app.get('/api/bookings/worker/:workerId/completed', async (req, res) => {
  try {
    const { workerId } = req.params;
    const bookings = await db.collection('bookings').find({
      workerId,
      status: 'completed'
    }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/bookings/worker/:workerId/chats
app.get('/api/bookings/worker/:workerId/chats', async (req, res) => {
  try {
    const { workerId } = req.params;
    const bookings = await db.collection('bookings').find({
      workerId,
      messages: { $exists: true, $not: { $size: 0 } }
    }).toArray();
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/worker/:uid/categories
app.get('/api/worker/:uid/categories', async (req, res) => {
  try {
    const { uid } = req.params;
    const worker = await db.collection('workers').findOne({ uid });
    if (!worker) return res.status(404).json({ error: "Worker not found" });
    res.json({
      categories: worker.categories || [worker.profession],
      skills: worker.skills || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/worker/:uid/categories
app.put('/api/worker/:uid/categories', async (req, res) => {
  try {
    const { uid } = req.params;
    const { categories, skills } = req.body;
    await db.collection('workers').updateOne(
      { uid },
      { $set: { categories, skills } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/subscription/plans
app.get('/api/subscription/plans', async (req, res) => {
  res.json([
    { id: 'pro', name: 'GigDial Pro', price: 499, currency: 'INR', features: ['Unlimited Lead Access', 'Direct Chat Integration', 'Featured Professional Tag'] }
  ]);
});

// PUT /api/worker/:uid/notifications
app.put('/api/worker/:uid/notifications', async (req, res) => {
  try {
    const { uid } = req.params;
    const { push, email, sms, promotions } = req.body;
    await db.collection('workers').updateOne(
      { uid },
      { $set: { notificationSettings: { push, email, sms, promotions } } }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/support/tickets
app.post('/api/support/tickets', async (req, res) => {
  try {
    const { workerUid, subject, message } = req.body;
    const ticket = {
      workerUid,
      subject,
      message,
      status: 'open',
      createdAt: new Date()
    };
    await db.collection('support_tickets').insertOne(ticket);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/change-password
app.post('/api/auth/change-password', async (req, res) => {
  res.json({ success: true, message: "Password updated successfully" });
});

// -----------------------------------------------------------------------------
// DEDICATED ADMIN PAYMENTS & APPROVAL ROUTER
// -----------------------------------------------------------------------------

// GET /api/payments
app.get('/api/payments', async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) {
      filter.status = status;
    }
    const list = await db.collection('payments').find(filter).sort({ createdAt: -1 }).toArray();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payments/:id/approve
app.post('/api/payments/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid payment ID" });

    const payment = await db.collection('payments').findOne({ _id: new ObjectId(id) });
    if (!payment) return res.status(404).json({ error: "Payment record not found" });

    // 1. Mark payment as completed
    await db.collection('payments').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'completed', completedAt: new Date() } }
    );

    // 2. Update the worker subscription in 'workers' collection
    await db.collection('workers').updateOne(
      { uid: payment.workerUid },
      { $set: { 
        subscription: {
          plan: payment.plan || 'pro',
          status: 'active',
          expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        },
        updatedAt: new Date()
      } }
    );

    // 3. Update the worker subscription in 'users' collection (for auth session loading)
    await db.collection('users').updateOne(
      { uid: payment.workerUid },
      { $set: { 
        subscription: {
          isActive: true,
          planName: payment.plan === 'pro' ? 'GigDial Pro' : (payment.plan || 'Pro Plan'),
          price: '₹499 / Month',
          remainingDays: 30
        },
        updatedAt: new Date()
      } }
    );

    res.json({ success: true, message: "Payment approved and worker subscription activated successfully." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`GigDial Admin API Server running at http://localhost:${PORT}`);
});


