import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import authRouter from './routes/auth.js';
import booksRouter from './routes/books.js';
import progressRouter from './routes/progress.js';
import promptsRouter from './routes/prompts.js';
import quizRouter from './routes/quiz.js';
import pomodoroRouter from './routes/pomodoro.js';
import pomodoroSettingsRouter from './routes/pomodoroSettings.js';
import revisionSheetsRouter from './routes/revisionSheets.js';
import practicePoolRouter from './routes/practicePool.js';
import aiRouter from './routes/ai.js';

for (const required of ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'SESSION_SECRET']) {
  if (!process.env[required]) {
    console.error(`Missing required env var ${required} (see .env.example)`);
    process.exit(1);
  }
}

const app = express();
const corsOrigins = (process.env.CORS_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));
app.use(authRouter);
app.use(booksRouter);
app.use(progressRouter);
app.use(promptsRouter);
app.use(quizRouter);
app.use(pomodoroRouter);
app.use(pomodoroSettingsRouter);
app.use(revisionSheetsRouter);
app.use(practicePoolRouter);
app.use(aiRouter);

const port = process.env.PORT ?? 8787;
app.listen(port, () => console.log(`bibliotheque-server listening on :${port}`));
