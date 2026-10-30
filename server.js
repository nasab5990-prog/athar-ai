import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import pg from 'pg';
import nodemailer from 'nodemailer';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';

const { Pool } = pg;

const app = express();
const port = Number(process.env.PORT || 3000);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required.');
}

if (
  process.env.NODE_ENV === 'production' &&
  (
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    !process.env.OTP_SECRET ||
    process.env.OTP_SECRET.length < 32
  )
) {
  throw new Error(
    'Production requires SESSION_SECRET and OTP_SECRET of at least 32 characters.'
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

const PgSession = connectPgSimple(session);

const allowedDomains = ['moe.om', 'edu.moe.om'];

const frontendOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((value) => value.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const roleNames = {
  teacher: 'المعلم',
  senior_teacher: 'المعلم الأول',
  principal: 'المدير',
  parent: 'ولي الأمر'
};

const allowedRoles = [
  'teacher',
  'senior_teacher',
  'principal',
  'parent'
];

async function initialiseDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (
        role IN ('teacher', 'senior_teacher', 'principal', 'parent')
      ),
      school_id TEXT NOT NULL,
      student_id TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS records (
      id BIGSERIAL PRIMARY KEY,
      school_id TEXT NOT NULL,
      owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS records_school_id_idx
      ON records(school_id);

    CREATE INDEX IF NOT EXISTS records_owner_id_idx
      ON records(owner_id);

    CREATE INDEX IF NOT EXISTS records_kind_idx
      ON records(kind);

    CREATE INDEX IF NOT EXISTS records_created_at_idx
      ON records(created_at DESC);
  `);

  console.log('PostgreSQL tables are ready.');
}

async function createInitialAdmin() {
  const email = String(process.env.INITIAL_ADMIN_EMAIL || '')
    .trim()
    .toLowerCase();

  const name = String(process.env.INITIAL_ADMIN_NAME || '').trim();

  const schoolId = String(
    process.env.INITIAL_ADMIN_SCHOOL || ''
  ).trim();

  if (!email && !name && !schoolId) {
    console.log('Initial administrator variables were not provided.');
    return;
  }

  if (!email || !name || !schoolId) {
    throw new Error(
      'INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_NAME and ' +
      'INITIAL_ADMIN_SCHOOL must all be provided.'
    );
  }

  if (!domainAllowed(email)) {
    throw new Error(
      'INITIAL_ADMIN_EMAIL must use @moe.om or @edu.moe.om.'
    );
  }

  await pool.query(
    `
      INSERT INTO users (
        email,
        name,
        role,
        school_id,
        active
      )
      VALUES ($1, $2, 'principal', $3, TRUE)
      ON CONFLICT (email)
      DO UPDATE SET
        name = EXCLUDED.name,
        role = 'principal',
        school_id = EXCLUDED.school_id,
        active = TRUE
    `,
    [email, name, schoolId]
  );

  console.log(`Initial principal account is ready: ${email}`);
}

function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function audit(userId, event, details = '') {
  await pool.query(
    `
      INSERT INTO audit_log (user_id, event, details)
      VALUES ($1, $2, $3)
    `,
    [userId, event, details]
  );
}

function domainAllowed(email) {
  const domain = String(email).split('@')[1]?.toLowerCase() || '';
  return allowedDomains.includes(domain);
}

const hashOtp = (email, code) =>
  crypto
    .createHmac(
      'sha256',
      process.env.OTP_SECRET ||
        process.env.SESSION_SECRET ||
        'replace-me'
    )
    .update(`${email}:${code}`)
    .digest('hex');

const safeEqual = (firstValue, secondValue) => {
  try {
    const firstBuffer = Buffer.from(firstValue, 'hex');
    const secondBuffer = Buffer.from(secondValue, 'hex');

    if (firstBuffer.length !== secondBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(firstBuffer, secondBuffer);
  } catch {
    return false;
  }
};

const requireAuth = asyncHandler(async (req, res, next) => {
  const sessionUser = req.session.user;

  if (!sessionUser) {
    return res.status(401).json({
      message: 'يلزم تسجيل الدخول.'
    });
  }

  const result = await pool.query(
    `
      SELECT
        id,
        email,
        name,
        role,
        school_id,
        student_id,
        active
      FROM users
      WHERE id = $1
    `,
    [sessionUser.id]
  );

  const user = result.rows[0];

  if (!user || !user.active) {
    req.session.destroy(() => {});

    return res.status(401).json({
      message: 'الحساب غير نشط.'
    });
  }

  req.user = user;
  next();
});

function requireRole(...roles) {
  return function roleMiddleware(req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        message: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.'
      });
    }

    next();
  };
}

app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: 'cross-origin'
    }
  })
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        return callback(null, true);
      }

      const normalisedOrigin = origin.replace(/\/+$/, '');

      if (
        frontendOrigins.length === 0 ||
        frontendOrigins.includes(normalisedOrigin)
      ) {
        return callback(null, true);
      }

      return callback(new Error('Origin not allowed'));
    },
    credentials: true
  })
);

app.use(express.json({ limit: '100kb' }));

app.use(
  session({
    name: 'athar.sid',

    secret:
      process.env.SESSION_SECRET ||
      'CHANGE_THIS_TO_A_LONG_RANDOM_SECRET_BEFORE_DEPLOYMENT',

    resave: false,
    saveUninitialized: false,

    store: new PgSession({
      pool,
      tableName: 'user_sessions',
      createTableIfMissing: true
    }),

    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.COOKIE_SAMESITE || 'none',
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'محاولات كثيرة. حاول لاحقًا.'
  }
});

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        : undefined
    })
  : null;
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'athar-api',
    message: 'خادم منصة أثر يعمل بنجاح'
  });
});
app.get(
  '/api/health',
  asyncHandler(async (req, res) => {
    const databaseResult = await pool.query(
      'SELECT CURRENT_TIMESTAMP AS time'
    );

    res.json({
      ok: true,
      service: 'athar-api',
      database: 'postgresql',
      databaseConnected: true,
      databaseTime: databaseResult.rows[0].time
    });
  })
);

app.post(
  '/api/auth/request-code',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();

    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      !domainAllowed(email)
    ) {
      return res.status(400).json({
        message:
          'استخدم البريد الرسمي ضمن @moe.om أو @edu.moe.om.'
      });
    }

    if (!transporter) {
      return res.status(503).json({
        message:
          'لم يتم إعداد خدمة البريد في الخادم بعد. ' +
          'أضف إعدادات SMTP قبل تفعيل تسجيل الدخول.'
      });
    }

    const userResult = await pool.query(
      `
        SELECT id, email, active
        FROM users
        WHERE email = $1
      `,
      [email]
    );

    const user = userResult.rows[0];

    if (user?.active) {
      const code = String(
        crypto.randomInt(0, 1000000)
      ).padStart(6, '0');

      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

      await pool.query(
        `
          INSERT INTO otp_codes (
            email,
            code_hash,
            expires_at,
            attempts,
            created_at
          )
          VALUES ($1, $2, $3, 0, CURRENT_TIMESTAMP)
          ON CONFLICT (email)
          DO UPDATE SET
            code_hash = EXCLUDED.code_hash,
            expires_at = EXCLUDED.expires_at,
            attempts = 0,
            created_at = CURRENT_TIMESTAMP
        `,
        [email, hashOtp(email, code), expiresAt]
      );

      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'رمز التحقق — أثَر',
        text:
          `رمز التحقق للدخول إلى منصة أثَر هو: ${code}\n` +
          'صالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.'
      });
    }

    res.json({
      message:
        'إذا كان البريد مسجلًا ومفعّلًا، ' +
        'فسيصلك رمز تحقق خلال لحظات.'
    });
  })
);

app.post(
  '/api/auth/verify-code',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email || '')
      .trim()
      .toLowerCase();

    const code = String(req.body?.code || '').trim();

    if (!domainAllowed(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        message: 'البريد أو رمز التحقق غير صالح.'
      });
    }

    const codeResult = await pool.query(
      `
        SELECT
          email,
          code_hash,
          expires_at,
          attempts
        FROM otp_codes
        WHERE email = $1
      `,
      [email]
    );

    const otpRow = codeResult.rows[0];

    if (
      !otpRow ||
      new Date(otpRow.expires_at).getTime() < Date.now() ||
      otpRow.attempts >= 5
    ) {
      await pool.query(
        'DELETE FROM otp_codes WHERE email = $1',
        [email]
      );

      return res.status(401).json({
        message:
          'انتهت صلاحية الرمز أو لم يعد صالحًا. ' +
          'اطلب رمزًا جديدًا.'
      });
    }

    const isMatch = safeEqual(
      otpRow.code_hash,
      hashOtp(email, code)
    );

    if (!isMatch) {
      await pool.query(
        `
          UPDATE otp_codes
          SET attempts = attempts + 1
          WHERE email = $1
        `,
        [email]
      );

      return res.status(401).json({
        message: 'رمز التحقق غير صحيح.'
      });
    }

    await pool.query(
      'DELETE FROM otp_codes WHERE email = $1',
      [email]
    );

    const userResult = await pool.query(
      `
        SELECT
          id,
          email,
          name,
          role,
          school_id,
          student_id,
          active
        FROM users
        WHERE email = $1
          AND active = TRUE
      `,
      [email]
    );

    const user = userResult.rows[0];

    if (!user) {
      return res.status(401).json({
        message: 'الحساب غير مفعّل. راجع مسؤول النظام.'
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        return res.status(500).json({
          message: 'تعذر إنشاء جلسة آمنة.'
        });
      }

      req.session.user = {
        id: user.id
      };

      req.session.save(async (saveError) => {
        if (saveError) {
          return res.status(500).json({
            message: 'تعذر حفظ جلسة الدخول.'
          });
        }

        try {
          await audit(user.id, 'login');

          return res.json({
            user: {
              ...user,
              roleName: roleNames[user.role]
            }
          });
        } catch (auditError) {
          console.error('Login audit error:', auditError);

          return res.json({
            user: {
              ...user,
              roleName: roleNames[user.role]
            }
          });
        }
      });
    });
  })
);

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({
    user: {
      ...req.user,
      roleName: roleNames[req.user.role]
    }
  });
});

app.post(
  '/api/auth/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await audit(req.user.id, 'logout');

    req.session.destroy((error) => {
      if (error) {
        return res.status(500).json({
          message: 'تعذر تسجيل الخروج.'
        });
      }

      res.clearCookie('athar.sid', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.COOKIE_SAMESITE || 'none'
      });

      res.json({ ok: true });
    });
  })
);

app.get(
  '/api/records',
  requireAuth,
  asyncHandler(async (req, res) => {
    let result;

    if (req.user.role === 'parent') {
      result = await pool.query(
        `
          SELECT id, kind, payload, created_at
          FROM records
          WHERE school_id = $1
            AND kind = 'parent_view'
            AND payload ->> 'student_id' = $2
          ORDER BY id DESC
          LIMIT 300
        `,
        [req.user.school_id, req.user.student_id || '']
      );
    } else if (
      req.user.role === 'principal' ||
      req.user.role === 'senior_teacher'
    ) {
      result = await pool.query(
        `
          SELECT id, kind, payload, created_at
          FROM records
          WHERE school_id = $1
          ORDER BY id DESC
          LIMIT 500
        `,
        [req.user.school_id]
      );
    } else {
      result = await pool.query(
        `
          SELECT id, kind, payload, created_at
          FROM records
          WHERE school_id = $1
            AND (
              owner_id = $2
              OR kind IN (
                'shared_assessment',
                'shared_intervention'
              )
            )
          ORDER BY id DESC
          LIMIT 300
        `,
        [req.user.school_id, req.user.id]
      );
    }

    res.json({
      records: result.rows
    });
  })
);

app.post(
  '/api/records',
  requireAuth,
  requireRole('teacher', 'senior_teacher', 'principal'),
  asyncHandler(async (req, res) => {
    const kind = String(req.body?.kind || '').trim();
    const payload = req.body?.payload;

    const permittedKinds = [
      'student',
      'assessment',
      'intervention',
      'impact',
      'shared_assessment',
      'shared_intervention'
    ];

    if (
      !permittedKinds.includes(kind) ||
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return res.status(400).json({
        message: 'نوع السجل أو بياناته غير صالحة.'
      });
    }

    const result = await pool.query(
      `
        INSERT INTO records (
          school_id,
          owner_id,
          kind,
          payload
        )
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING id, kind, payload, created_at
      `,
      [
        req.user.school_id,
        req.user.id,
        kind,
        JSON.stringify(payload)
      ]
    );

    await audit(req.user.id, 'record.create', kind);

    res.status(201).json(result.rows[0]);
  })
);

app.get(
  '/api/users',
  requireAuth,
  requireRole('principal'),
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `
        SELECT
          id,
          email,
          name,
          role,
          school_id,
          student_id,
          active,
          created_at
        FROM users
        WHERE school_id = $1
        ORDER BY name
      `,
      [req.user.school_id]
    );

    res.json({
      users: result.rows
    });
  })
);

app.use((error, req, res, next) => {
  console.error(error);

  if (error.message === 'Origin not allowed') {
    return res.status(403).json({
      message: 'مصدر الواجهة غير مسموح به.'
    });
  }

  res.status(500).json({
    message: 'حدث خطأ داخلي. راجع سجل الخادم.'
  });
});

async function startServer() {
  await pool.query('SELECT 1');
  console.log('Connected to PostgreSQL.');

  await initialiseDatabase();
  await createInitialAdmin();

  app.listen(port, '0.0.0.0', () => {
    console.log(`ATHAR API listening on ${port}`);
  });
}

startServer().catch((error) => {
  console.error('Application startup failed:', error);
  process.exit(1);
});
