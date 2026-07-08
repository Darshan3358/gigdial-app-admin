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

app.listen(PORT, () => {
  console.log(`GigDial Admin API Server running at http://localhost:${PORT}`);
});
