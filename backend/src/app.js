import dotenv from "dotenv";
dotenv.config();

console.log("DB ENV VALUES LOADED:", {
  DB_USER: process.env.DB_USER,
  DB_HOST: process.env.DB_HOST,
  DB_PORT: process.env.DB_PORT,
  DB_NAME: process.env.DB_NAME
});

import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import axios from "axios";

const app = express();
app.use(cors());
app.use(express.json());

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;

app.get("/", (req, res) => {
  res.json({ message: "Backend Running..." });
});

app.post("/daily-checkin", async (req, res) => {
  const { student_id, quiz_score, focus_minutes } = req.body;

  if (!student_id || quiz_score == null || focus_minutes == null) {
    return res.status(400).json({ error: "Missing fields" });
  }

  try {
    const isSuccess = quiz_score > 7 && focus_minutes > 60;
    const outcome = isSuccess ? "SUCCESS" : "FAILURE";

    const logResult = await pool.query(
      `INSERT INTO daily_logs (student_id, quiz_score, focus_minutes, outcome)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [student_id, quiz_score, focus_minutes, outcome]
    );

    const dailyLogId = logResult.rows[0].id;

    if (isSuccess) {
      await pool.query(
        `UPDATE students SET status = 'ON_TRACK' WHERE id = $1`,
        [student_id]
      );
      return res.json({ status: "On Track" });
    } else {
      await pool.query(
        `UPDATE students SET status = 'NEEDS_INTERVENTION' WHERE id = $1`,
        [student_id]
      );

      const interventionResult = await pool.query(
        `INSERT INTO interventions (student_id, daily_log_id, status)
         VALUES ($1, $2, 'PENDING_MENTOR')
         RETURNING id`,
        [student_id, dailyLogId]
      );

      if (N8N_WEBHOOK_URL && N8N_WEBHOOK_URL !== "http://example.com") {
        axios.post(N8N_WEBHOOK_URL, {
          student_id,
          daily_log_id: dailyLogId,
          intervention_id: interventionResult.rows[0].id,
          quiz_score,
          focus_minutes
        }).catch(err => console.log("Webhook Error:", err.message));
      }

      return res.json({ status: "Pending Mentor Review" });
    }
  } catch (err) {
    console.error("Error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server started on ${PORT}`));
