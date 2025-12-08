// src/services/otp.service.js
import { pool } from '../db.js';

/**
 * ENV:
 *  - OTP_COOLDOWN_SEC  : mặc định 60
 *  - OTP_MAX_RESEND    : mặc định 5
 *  - OTP_TTL_MIN       : mặc định 10
 *  - OTP_DEV_DISABLE_LIMIT=true  (chỉ nên dùng non-prod)
 */
const COOLDOWN_SEC = Number(process.env.OTP_COOLDOWN_SEC || 60);
const COOLDOWN = Number(process.env.OTP_COOLDOWN_SEC || 60);
const MAX_RESEND = Number(process.env.OTP_MAX_RESEND || 5);
const TTL_MIN      = Number(process.env.OTP_TTL_MIN      || 10);
const DEV_BYPASS   = String(process.env.OTP_DEV_DISABLE_LIMIT || '')
  .toLowerCase() === 'true' && process.env.NODE_ENV !== 'production';

/**
 * Tạo mệnh đề WHERE + params cho các truy vấn OTP.
 * Ưu tiên khoá theo:
 *   - Register: (email, purpose, pending_signup_id)
 *   - Reset/2FA: (email, purpose, user_id)
 *   - Fallback:  (email, purpose)
 */
function _buildWhere({ email, purpose, userId, pendingSignupId }) {
  if (userId) {
    return { where: 'email = $1 AND user_id = $2 AND purpose = $3',
             params: [email, userId, purpose] };
  }
  if (pendingSignupId) {
    return { where: 'email = $1 AND pending_signup_id = $2 AND purpose = $3',
             params: [email, pendingSignupId, purpose] };
  }
  return { where: 'email = $1 AND purpose = $2', params: [email, purpose] };
}

// ===== helpers =====
async function _secondsSinceLastSend({ email, purpose, userId, pendingSignupId }) {
  const { where, params } = _buildWhere({ email, purpose, userId, pendingSignupId });
  const q = `
    SELECT EXTRACT(EPOCH FROM (now() - last_sent_at)) AS sec
    FROM email_otp
    WHERE ${where}
    ORDER BY last_sent_at DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, params);
  if (!rows.length || rows[0].sec == null) return Number.POSITIVE_INFINITY;
  return Number(rows[0].sec);
}

async function _currentResendCount({ email, purpose, userId, pendingSignupId }) {
  const { where, params } = _buildWhere({ email, purpose, userId, pendingSignupId });
  const q = `
    SELECT resend_count
    FROM email_otp
    WHERE ${where}
    ORDER BY last_sent_at DESC
    LIMIT 1
  `;
  const { rows } = await pool.query(q, params);
  if (!rows.length || rows[0].resend_count == null) return 0;
  return Number(rows[0].resend_count);
}

// ===== public APIs =====
export async function canResend(email, purpose, opts = {}) {
  const { userId = null, pendingSignupId = null } = opts;
  const { where, params } = _buildWhere({ email, purpose, userId, pendingSignupId });

  const q1 = `
    SELECT EXTRACT(EPOCH FROM (now() - last_sent_at)) AS sec, resend_count
    FROM email_otp
    WHERE ${where}
    ORDER BY last_sent_at DESC
    LIMIT 1`;
  const { rows } = await pool.query(q1, params);

  const sec = rows.length ? Number(rows[0].sec ?? 1e9) : 1e9;
  const count = rows.length ? Number(rows[0].resend_count ?? 0) : 0;

  if (sec < COOLDOWN) return { allow: false, reason: 'cooldown', waitSec: Math.ceil(COOLDOWN - sec) };
  if (count >= MAX_RESEND) return { allow: false, reason: 'max_resend' };
  return { allow: true };
}


// Sau khi GỬI THÀNH CÔNG: tăng resend_count + cập nhật last_sent_at trên bản ghi MỚI NHẤT của key đó
export async function bumpResend(email, purpose, opts = {}) {
  const { userId = null, pendingSignupId = null } = opts;
  if (userId) {
    await pool.query(
      `UPDATE email_otp SET resend_count = resend_count + 1, last_sent_at = now()
       WHERE email = $1 AND user_id = $2 AND purpose = $3`,
      [email, userId, purpose]
    );
  } else if (pendingSignupId) {
    await pool.query(
      `UPDATE email_otp SET resend_count = resend_count + 1, last_sent_at = now()
       WHERE email = $1 AND pending_signup_id = $2 AND purpose = $3`,
      [email, pendingSignupId, purpose]
    );
  } else {
    await pool.query(
      `UPDATE email_otp SET resend_count = resend_count + 1, last_sent_at = now()
       WHERE email = $1 AND purpose = $2`,
      [email, purpose]
    );
  }
}


// Tạo/thay thế OTP theo key (register: +pending_signup_id, reset/2FA: +user_id)
export async function createOrReplaceOtp(email, purpose, opts = {}) {
  const { userId = null, pendingSignupId = null } = opts;
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const ttlMinutes = Number(process.env.OTP_TTL_MIN || 10);

  // xoá cũ
  if (userId) {
    await pool.query(`DELETE FROM email_otp WHERE email = $1 AND user_id = $2 AND purpose = $3`,
      [email, userId, purpose]);
  } else if (pendingSignupId) {
    await pool.query(`DELETE FROM email_otp WHERE email = $1 AND pending_signup_id = $2 AND purpose = $3`,
      [email, pendingSignupId, purpose]);
  } else {
    await pool.query(`DELETE FROM email_otp WHERE email = $1 AND purpose = $2`,
      [email, purpose]);
  }

  // chèn mới
  const ins = await pool.query(
    `INSERT INTO email_otp
     (email, user_id, pending_signup_id, code, purpose, used, attempts, resend_count, last_sent_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, false, 0, 0, now(), now() + ($6 || ' minutes')::interval, now())
     RETURNING code, expires_at`,
    [email, userId, pendingSignupId, code, purpose, ttlMinutes]
  );
  return { code: ins.rows[0].code, expiresAt: ins.rows[0].expires_at };
}

// Xác minh OTP theo đúng key; consume nếu đúng
export async function verifyOtp(email, code, purpose, opts = {}) {
  const { userId = null, pendingSignupId = null, consume = false } = opts;
  const { where, params } = _buildWhere({ email, purpose, userId, pendingSignupId });

  const q = `
    SELECT id, code, used, expires_at
    FROM email_otp
    WHERE ${where} AND used = false
    ORDER BY last_sent_at DESC
    LIMIT 1`;
  const { rows } = await pool.query(q, params);
  if (!rows.length) return { ok: false, reason: 'not_found' };

  const row = rows[0];
  if (new Date(row.expires_at) < new Date()) return { ok: false, reason: 'expired' };
  if (String(row.code) !== String(code)) {
    await pool.query(`UPDATE email_otp SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, reason: 'mismatch' };
  }
  if (consume) await pool.query(`UPDATE email_otp SET used = true WHERE id = $1`, [row.id]);
  return { ok: true };
}