import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

// Root Test
app.get("/", (req, res) => {
  res.json({ message: "Backend Running..." });
});

// Daily Check-in
app.post("/daily-checkin", async (req, res) => {
  try {
    const { student_id, quiz_score, focus_minutes } = req.body;

    if (!student_id || quiz_score == null || focus_minutes == null) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Ensure student exists
    const studentExists = await pool.query(
      `SELECT id FROM students WHERE id = $1`,
      [student_id]
    );

    if (studentExists.rowCount === 0) {
      await pool.query(
        `INSERT INTO students (id, name, email, status)
         VALUES ($1, 'Unknown', $2, 'ON_TRACK')`,
        [student_id, `${student_id}@example.com`]
      );
      console.log("New student created:", student_id);
    }

    // Determine outcome
    const outcome = quiz_score > 7 && focus_minutes > 60 ? "PASS" : "FAIL";

    // Insert daily log
    const logResult = await pool.query(
      `INSERT INTO daily_logs (student_id, quiz_score, focus_minutes, outcome)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [student_id, quiz_score, focus_minutes, outcome]
    );

    const dailyLogId = logResult.rows[0].id;

    if (outcome === "PASS") {
      await pool.query(
        `UPDATE students SET status = 'ON_TRACK' WHERE id = $1`,
        [student_id]
      );
      return res.json({ status: "On Track" });
    }

    // Create intervention on FAIL
    const interventionResult = await pool.query(
      `INSERT INTO interventions (student_id, daily_log_id, status)
       VALUES ($1, $2, 'PENDING_MENTOR')
       RETURNING id`,
      [student_id, dailyLogId]
    );

    const interventionId = interventionResult.rows[0].id;

    await pool.query(
      `UPDATE students SET status = 'NEEDS_INTERVENTION' WHERE id = $1`,
      [student_id]
    );

    // Trigger n8n
    if (N8N_WEBHOOK_URL) {
      axios.post(N8N_WEBHOOK_URL, {
        student_id,
        daily_log_id: dailyLogId,
        intervention_id: interventionId,
        quiz_score,
        focus_minutes,
      }).catch(() => console.log("Webhook failed"));
    }

    return res.json({ status: "Pending Mentor Review" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server Error" });
  }
});

// Approve intervention (EMAIL LINK)
app.get("/assign-intervention", async (req, res) => {
  try {
    const { student_id, intervention_id } = req.query;

    if (!student_id || !intervention_id) {
      return res.status(400).send("Missing required query params");
    }

    const result = await pool.query(
      `UPDATE interventions 
       SET status = 'ASSIGNED'
       WHERE id = $1 AND student_id = $2 
       RETURNING id`,
      [intervention_id, student_id]
    );

    if (result.rowCount === 0) {
      return res.status(400).send("No intervention found to assign");
    }

    await pool.query(
      `UPDATE students SET status = 'REMEDIAL' WHERE id = $1`,
      [student_id]
    );

    res.send("Intervention Approved! Task Assigned Successfully 🎯");

  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Complete intervention
app.post("/complete-intervention", async (req, res) => {
  const { student_id } = req.body;

  if (!student_id) return res.status(400).json({ error: "Missing student_id" });

  try {
    const result = await pool.query(
      `UPDATE interventions 
       SET status = 'RESOLVED'
       WHERE student_id = $1 AND status = 'ASSIGNED'
       RETURNING id`,
      [student_id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: "No active intervention found" });
    }

    await pool.query(
      `UPDATE students SET status = 'ON_TRACK' WHERE id = $1`,
      [student_id]
    );

    res.json({ status: "Unlocked. Back on Track!" });

  } catch (err) {
    res.status(500).json({ error: "Server Error" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
