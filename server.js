const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb'); 
const admin = require('firebase-admin'); 
require('dotenv').config(); 

// (⚠️ เช็คชื่อไฟล์ .json ของคุณ!)
const serviceAccount = require('./assembly-app-project-firebase-adminsdk-fbsvc-f975284913'); 
const mongoUri = process.env.MONGO_URI;

const app = express();
app.listen(PORT, '0.0.0.0', () => { // เพิ่ม '0.0.0.0' เพื่อให้ Render มองเห็น
   console.log(`✅ Server (V15) running on port ${PORT}`);

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const client = new MongoClient(mongoUri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
let db; 

app.use(cors());
app.use(express.json());

async function connectToDatabase() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected!");
    db = client.db('assembly_db'); 
  } catch (err) { console.error(err); process.exit(1); }
}

// --- /register ---
app.post('/register', async (req, res) => {
  try {
    const { username, password, full_name, role, department, employee_id } = req.body;
    if (!username || !password || !full_name) return res.status(400).send({ error: 'ข้อมูลไม่ครบ' });
    const existingUser = await db.collection('users').findOne({ username });
    if (existingUser) return res.status(400).send({ error: 'Username ซ้ำ' });

    const newUser = { username, password, full_name, role: role || 'operator', department: department || 'General', employee_id: employee_id || '', is_active: true, created_at: new Date() };
    await db.collection('users').insertOne(newUser);
    res.status(201).send({ message: 'User Created' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- /login ---
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (!user || user.password !== password || !user.is_active) return res.status(401).send({ error: 'Login Failed' });
    const token = await admin.auth().createCustomToken(user._id.toString());
    res.send({ message: 'OK', token, user: { ...user, _id: user._id } });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- /log-qc ---
app.post('/log-qc', async (req, res) => {
  try {
    await db.collection('qc_log').insertOne({ ...req.body, timestamp: new Date(), user_id: new ObjectId(req.body.userId) });
    res.status(201).send({ message: 'Saved' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- /get-stats ---
app.get('/get-stats/:userId', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const q = { user_id: new ObjectId(req.params.userId), timestamp: { $gte: today } };
    const [ok, ng, rework] = await Promise.all([
      db.collection('qc_log').countDocuments({ ...q, status: 'OK' }),
      db.collection('qc_log').countDocuments({ ...q, status: 'NG' }),
      db.collection('qc_log').countDocuments({ ...q, status: 'REWORK' })
    ]);
    res.send({ ok, ng, rework, total: ok+ng+rework });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- (V14 อัปเกรด!) /set-plan (บันทึกแยกกะ) ---
app.post('/set-plan', async (req, res) => {
  try {
    // (รับ shift มาด้วย)
    const { date_string, model, shift, target_quantity } = req.body; 
    
    if (!date_string || !model || !shift || !target_quantity) {
      return res.status(400).send({ error: 'กรุณาระบุ วันที่, รุ่น, กะ และยอดแพลน ให้ครบ' });
    }

    // (บันทึกโดยใช้ date + model + shift เป็นกุญแจ)
    await db.collection('production_plans').updateOne(
      { date_string: date_string, model: model, shift: shift }, 
      { $set: { 
          date_string, model, shift, 
          target_quantity: parseInt(target_quantity, 10) 
      }},
      { upsert: true }
    );
    console.log(`✅ Plan Saved: [${date_string}] [${model}] [${shift}] = ${target_quantity}`);
    res.status(201).send({ message: 'Plan Saved' });
  } catch (err) { 
      console.error(err);
      res.status(500).send({ error: 'Plan Error' }); 
  }
});

// --- (V14 อัปเกรด!) /get-admin-dashboard (ดึงแผนตามกะ) ---
app.get('/get-admin-dashboard', async (req, res) => {
  try {
    const { start, end, model, shift } = req.query; 
    
    let dateQuery = {};
    let planDateStr = new Date().toISOString().split('T')[0]; 
    let selectedShift = shift || 'day';

    // 1. คำนวณเวลา Actual (เหมือนเดิม)
    let startDateObj = start ? new Date(start) : new Date();
    let endDateObj = end ? new Date(end) : new Date();
    
    if (start && end) {
        planDateStr = start; 
    } else {
        startDateObj = new Date();
        endDateObj = new Date();
    }

    if (selectedShift === 'day') {
        startDateObj.setHours(8, 0, 0, 0);
        endDateObj.setHours(20, 0, 0, 0);
    } else {
        startDateObj.setHours(20, 0, 0, 0);
        endDateObj.setDate(endDateObj.getDate() + 1); 
        endDateObj.setHours(8, 0, 0, 0);
    }
    
    dateQuery = { timestamp: { $gte: startDateObj, $lt: endDateObj } };

    // 2. Query Actual & Plan
    let qcQuery = { ...dateQuery }; 
    
    // (V14) Query แพลน ต้องระบุ "กะ" ด้วย
    let planQuery = { date_string: planDateStr, shift: selectedShift }; 

    if (model && model !== "") {
        qcQuery.model = model; 
        planQuery.model = model;
    }

    // 3. ดึงข้อมูล Actual
    const totalOK = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'OK' });
    const totalNG = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'NG' });
    const totalRework = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'REWORK' });

    // 4. (V14) ดึงข้อมูล Plan (ตามกะ)
    const plans = await db.collection('production_plans').find(planQuery).toArray();
    let totalPlan = 0;
    plans.forEach(p => totalPlan += p.target_quantity);

    const defectSummary = await db.collection('qc_log').aggregate([
      { $match: { ...qcQuery, status: 'NG' } },
      { $group: { _id: "$defect", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    const hourlySummary = await db.collection('qc_log').aggregate([
      { $match: qcQuery },
      { $project: { hour: { $hour: { date: "$timestamp", timezone: "Asia/Bangkok" } }, status: "$status" } },
      { $group: { 
          _id: "$hour", 
          ok: { $sum: { $cond: [{ $eq: ["$status", "OK"] }, 1, 0] } },
          ng: { $sum: { $cond: [{ $eq: ["$status", "NG"] }, 1, 0] } },
          rework: { $sum: { $cond: [{ $eq: ["$status", "REWORK"] }, 1, 0] } }
      }},
      { $sort: { _id: 1 } }
    ]).toArray();

    res.send({
      kpi: { plan: totalPlan, ok: totalOK, ng: totalNG, rework: totalRework, variance: totalOK - totalPlan },
      defects: defectSummary,
      hourly: hourlySummary
    });

  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Dashboard Error' });
  }
});

async function startServer() {
  await connectToDatabase();
  app.listen(PORT, () => console.log(`✅ Server (V14) running on http://localhost:${PORT}`));
}

startServer();
