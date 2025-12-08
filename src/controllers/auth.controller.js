// src/controllers/auth.controller.js
import bcrypt from 'bcrypt';
import { pool } from '../db.js';
import {
  signTokens,
  signDeviceToken,
  verifyDeviceToken,
} from '../utils/jwt.js';
import cloudinary from '../config/cloudinary.js';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { createOrReplaceOtp, verifyOtp, canResend, bumpResend } from '../services/otp.service.js';
import { sendOtpMail }       from '../services/email.service.js';
import { registerDeviceToken } from '../services/fcm.service.js';

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Kiểm tra độ mạnh của mật khẩu
function validatePasswordStrength(pw, email) {
  if (typeof pw !== 'string') return "Mật khẩu không hợp lệ";
  if (pw.length < 8 || pw.length > 72) return "Độ dài 8-72 ký tự";
  if (!/[a-z]/.test(pw)) return "Cần ít nhất 1 chữ thường";
  if (!/[A-Z]/.test(pw)) return 'Cần ít nhất 1 chữ hoa';
  if (!/\d/.test(pw)) return 'Cần ít nhất 1 chữ số';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Cần ít nhất 1 ký tự đặc biệt';
  if (/\s/.test(pw)) return 'Không dùng khoảng trắng';
  if (email) {
    const local = email.split('@')[0]?.toLowerCase();
    if (local && pw.toLowerCase().includes(local)) {
      return 'Mật khẩu không được chứa phần tên email';
    }
  }
  return null;
}

// Tạo username duy nhất từ email
async function generateUniqueUsername(email) {
  const localPart = email.split('@')[0] || 'user';
  const baseRaw = localPart.replace(/[^a-zA-Z0-9._]/g, '') || 'user';
  const base = baseRaw.toLowerCase();

  let candidate = base;
  let suffix = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await pool.query('SELECT 1 FROM users WHERE username = $1', [candidate]);
    if (res.rowCount === 0) return candidate;
    suffix += 1;
    candidate = `${base}_${suffix}`;
  }
}

// ========== Đăng ký — B1 ==========
export async function startRegister(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Thiếu email hoặc mật khẩu' });
    }
    if (!email.includes('@') || !email.includes('.')) {
      return res.status(400).json({ message: 'Email không hợp lệ' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'Mật khẩu tối thiểu 6 ký tự' });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existingUser.rowCount > 0) {
      return res.status(409).json({ message: 'Email đã được đăng ký' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
   
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

     const upsert = `
      INSERT INTO pending_signups (email, password_hash, is_verified, attempts, resend_count, last_sent_at)
VALUES ($1, $2, false, 0, 0, NULL)
ON CONFLICT (email)
DO UPDATE SET password_hash = EXCLUDED.password_hash,
              is_verified   = false,
              attempts      = 0,
              resend_count  = 0,
              last_sent_at  = NULL,
              updated_at    = now()
RETURNING id, email
    `;

    const pen = await pool.query(upsert, [email,passwordHash]);
    const pending = pen.rows[0];

    const cr = await canResend(email, 'register', { pendingSignupId: pending.id });
if (!cr.allow) {
  const msg = cr.reason === 'cooldown'
    ? `Vui lòng thử lại sau ${cr.waitSec}s`
    : 'Bạn đã yêu cầu lại mã quá nhiều lần';
  return res.status(429).json({ message: msg });
}

    // Tạo OTP ở bảng email_otp (purpose=register)
    const otp = await createOrReplaceOtp(email, 'register', { pendingSignupId: pending.id, ttlMinutes: 10 });
    
    // Gửi mail
    try {
      await sendOtpMail({ to: email, code: otp.code, purpose: 'register' });
      await bumpResend(email, 'register', { pendingSignupId: pending.id });
    } catch (e) {
      if (String(process.env.EMAIL_DISABLE || '').toLowerCase() !== 'true') throw e;
      console.warn('[email] disabled, skip send register OTP', e);
    }

    return res.status(200).json({
      pendingId: pending.id,
      email,
      expiresAt: otp.expiresAt,
      message: 'Đã gửi mã OTP đến email',
    });
  } catch (err) {
    console.error('startRegister error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Đăng ký — B2 ==========
export async function verifyEmail(req, res) {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Thiếu email hoặc mã OTP' });

    const pen = await pool.query('SELECT * FROM pending_signups WHERE email = $1', [email]);
    if (pen.rowCount === 0) return res.status(400).json({ message: 'Không tìm thấy đăng ký đang chờ' });
    const pending = pen.rows[0];

    // xác minh OTP trong email_otp
const vr = await verifyOtp(email, code, 'register', {
  pendingSignupId: pending.id,
  consume: true,           // dùng xong thì đánh dấu used=true
});
if (!vr.ok) {
  const msg =
    vr.reason === 'expired'  ? 'Mã OTP đã hết hạn' :
    vr.reason === 'mismatch' ? 'Mã OTP không đúng' :
    'Không tìm thấy OTP';
  return res.status(400).json({ message: msg });
}


    const username = await generateUniqueUsername(email);
    const displayName = (email.split('@')[0] || 'user').slice(0, 60);

    const ins = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, phone, is_email_verified, username)
       VALUES ($1, $2, $3, NULL, true, $4)
       RETURNING id, email, display_name, phone, username, is_email_verified, created_at, token_version`,
      [email, pending.password_hash, displayName, username],
    );

    await pool.query('UPDATE pending_signups SET is_verified = true, updated_at = now() WHERE id = $1', [pending.id]);

    const user = ins.rows[0];
    const tokens = signTokens(user);
    return res.json({ user, tokens });
  } catch (err) {
    console.error('verifyEmail error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Hoàn tất hồ sơ ==========
export async function completeProfile(req, res) {
  try {
    const { displayName, phone, avatarAssetId } = req.body;
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    if (!displayName || displayName.trim().length < 2) {
      return res.status(400).json({ message: 'Tên hiển thị không hợp lệ' });
    }

    const updateQuery = `
      UPDATE users
      SET display_name = $1,
          phone        = $2,
          avatar_asset_id = COALESCE($3::uuid, avatar_asset_id),
          updated_at   = now()
      WHERE id = $4
      RETURNING id, email, display_name, phone, avatar_asset_id,
                is_email_verified, username, created_at
    `;
    const result = await pool.query(updateQuery, [
      displayName.trim(),
      phone || null,
      avatarAssetId || null,
      userId,
    ]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('completeProfile error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Đăng nhập ==========
export async function login(req, res) {
  try {
    const {
      email,
      password,
      fcmToken,
      platform,
      deviceModel,
      appVersion,
    } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: 'Thiếu email hoặc mật khẩu' });
    }

    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.phone,
        u.username,
        u.password_hash,
        u.is_email_verified,
        u.created_at,
        u.two_factor_enabled,
        u.token_version,
        u.status,
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.email = $1
    `;
    const result = await pool.query(q, [email]);
    if (result.rowCount === 0) {
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
    }

    const user = result.rows[0];

        // Chặn tài khoản không còn ở trạng thái active
    if (user.status && user.status !== 'active') {
      let msg  = 'Tài khoản của bạn không còn hoạt động.';
      let code = 'ACCOUNT_INACTIVE';

      if (user.status === 'banned') {
        msg  = 'Tài khoản của bạn đã bị cấm vĩnh viễn.';
        code = 'ACCOUNT_BANNED';
      } else if (user.status === 'locked') {
        msg  = 'Tài khoản của bạn đang bị tạm khoá.';
        code = 'ACCOUNT_LOCKED';
      } else if (user.status === 'self_deleted') {
        msg  = 'Tài khoản này đã bị xóa.';
      }

      return res
        .status(403)
        .json({ message: msg, code, status: user.status });
    }

    // So khớp mật khẩu (nếu user có password_hash)
    const ok = user.password_hash
      ? await bcrypt.compare(password, user.password_hash)
      : false;
    if (!ok) {
      return res.status(401).json({ message: 'Email hoặc mật khẩu không đúng' });
    }

    // Kiểm tra thiết bị tin cậy (nếu có header X-Device-Token) – phục vụ 2FA
    const deviceToken = req.headers['x-device-token'];
    let trust = false;
    if (deviceToken) {
      try {
        const decoded = verifyDeviceToken(deviceToken); // có thể ném lỗi
        trust = !!(decoded && decoded.sub === user.id);
      } catch (_) {
        trust = false;
      }
    }

    // Nếu bật 2FA và thiết bị KHÔNG tin cậy -> gửi OTP, trả 428
    if (user.two_factor_enabled && !trust) {
      const otp = await createOrReplaceOtp(user.email, 'login2fa', { userId: user.id });
      try {
        await sendOtpMail({ to: user.email, code: otp.code, purpose: 'login2fa' });
      } catch (e) {
        if (String(process.env.EMAIL_DISABLE || '').toLowerCase() !== 'true') throw e;
        console.warn('[email] disabled, skip send login2fa OTP', e);
      }
      return res
        .status(428)
        .json({ code: '2FA_REQUIRED', message: 'Yêu cầu xác minh OTP' });
    }

    // Đến đây: đăng nhập thành công (không cần OTP hoặc thiết bị đã tin cậy)

    // 1) Tăng token_version -> revoke hết phiên cũ
    const bump = await pool.query(
      `
      UPDATE users
      SET token_version = token_version + 1,
          updated_at    = now()
      WHERE id = $1
      RETURNING token_version
      `,
      [user.id],
    );
    user.token_version = bump.rows[0].token_version;

    // 2) Ghi FCM token + đá thiết bị cũ (force_logout)
    if (fcmToken) {
      try {
        await registerDeviceToken({
          userId: user.id,
          fcmToken,
          platform: platform || null,
          deviceModel: deviceModel || null,
          appVersion: appVersion || null,
        });
      } catch (e) {
        console.error('registerDeviceToken (login) error:', e);
        // Không chặn login
      }
    }

    delete user.password_hash;
    const tokens = signTokens(user);
    return res.json({ user, tokens });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}


// ========== Me ==========
export async function me(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.about,
        u.phone,
        u.birthday,
        u.avatar_asset_id,
        u.is_email_verified,
        u.created_at,
        a.url AS avatar_url
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id = $1
    `;
    const result = await pool.query(q, [userId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }

    const u = result.rows[0];
    const profile = {
      id: u.id,
      displayName: u.display_name,
      handle: u.username,
      bio: u.about,
      phone: u.phone,
      email: u.email,
      birthday: u.birthday,
      avatarUrl: u.avatar_url,
    };

    return res.json({ user: u, profile });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Upload avatar ==========
export async function uploadAvatar(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    if (!req.file) {
      return res.status(400).json({ message: 'Thiếu file' });
    }

    const buffer = req.file.buffer;

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: 'quickchat/avatars',
          transformation: [
            { width: 512, height: 512, crop: 'fill', gravity: 'face' },
          ],
        },
        (err, resUpload) => {
          if (err) reject(err);
          else resolve(resUpload);
        },
      );
      stream.end(buffer);
    });

    const insertAsset = `
      INSERT INTO assets (kind, url, thumb_url, mime, size_bytes)
      VALUES ('image', $1, $2, $3, $4)
      RETURNING id, url
    `;
    const assetRes = await pool.query(insertAsset, [
      result.secure_url,
      result.secure_url, // có thể tách thumb riêng sau
      req.file.mimetype,
      req.file.size,
    ]);

    const assetId = assetRes.rows[0].id;

    await pool.query(
      'UPDATE users SET avatar_asset_id = $1, updated_at = now() WHERE id = $2',
      [assetId, userId],
    );

    return res.json({
      avatarUrl: assetRes.rows[0].url,
      assetId,
    });
  } catch (err) {
    console.error('uploadAvatar error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Google Login ==========
export async function googleLogin(req, res) {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ message: 'Thiếu idToken' });

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    const sub = payload.sub;
    const email = payload.email;
    const emailVerified = !!payload.email_verified;
    const name = payload.name || (email ? email.split('@')[0] : 'User');
    const picture = payload.picture;

    if (!email) {
      return res.status(400).json({ message: 'Google không trả về email' });
    }

    let userRes = await pool.query('SELECT * FROM users WHERE google_sub = $1', [sub]);

    if (userRes.rowCount === 0) {
      userRes = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

      if (userRes.rowCount === 0) {
        const username = await generateUniqueUsername(email);

        let avatarAssetId = null;
        if (picture) {
          const insA = await pool.query(
            `INSERT INTO assets (kind, url, thumb_url, mime)
             VALUES ('image', $1, $1, 'image/jpeg')
             RETURNING id`,
            [picture],
          );
          avatarAssetId = insA.rows[0].id;
        }

        const insU = await pool.query(
          `INSERT INTO users (
             email, password_hash, display_name, phone,
             is_email_verified, username, avatar_asset_id, google_sub
           )
           VALUES ($1, NULL, $2, NULL, $3, $4, $5, $6)
           RETURNING id, email, display_name, phone, avatar_asset_id,
                     is_email_verified, username, created_at, google_sub, token_version`,
          [email, name, emailVerified, username, avatarAssetId, sub],
        );
        userRes = insU;
      } else {
        const existing = userRes.rows[0];
        if (!existing.google_sub) {
          await pool.query(
            `UPDATE users
             SET google_sub = $1,
                 is_email_verified = $2,
                 updated_at = now()
             WHERE id = $3`,
            [sub, emailVerified || existing.is_email_verified, existing.id],
          );
          userRes = await pool.query('SELECT * FROM users WHERE id = $1', [existing.id]);
        }
      }
    }

    const user = userRes.rows[0];

        if (user.status && user.status !== 'active') {
      let msg  = 'Tài khoản của bạn không còn hoạt động.';
      let code = 'ACCOUNT_INACTIVE';

      if (user.status === 'banned') {
        msg  = 'Tài khoản của bạn đã bị cấm vĩnh viễn.';
        code = 'ACCOUNT_BANNED';
      } else if (user.status === 'locked') {
        msg  = 'Tài khoản của bạn đang bị tạm khoá.';
        code = 'ACCOUNT_LOCKED';
      } else if (user.status === 'self_deleted') {
        msg  = 'Tài khoản này đã bị xóa.';
      }

      return res
        .status(403)
        .json({ message: msg, code, status: user.status });
    }

    delete user.password_hash;
    if (fcmToken) {
      try {
        await registerDeviceToken({
          userId: user.id,
          fcmToken,
          platform: platform || null,
          deviceModel: deviceModel || null,
          appVersion: appVersion || null,
        });
      } catch (e) {
        console.error('registerDeviceToken (googleLogin) error:', e);
      }
    }
    // Bump token_version để revoke các phiên cũ
    const bump = await pool.query(
      `
      UPDATE users
      SET token_version = token_version + 1,
          updated_at    = now()
      WHERE id = $1
      RETURNING token_version
      `,
      [user.id],
    );
    user.token_version = bump.rows[0].token_version;

    // Đăng ký thiết bị với FCM token (nếu có)
    if (fcmToken) {
      try {
        await registerDeviceToken({
          userId: user.id,
          fcmToken,
          platform: platform || null,
          deviceModel: deviceModel || null,
          appVersion: appVersion || null,
        });
      } catch (e) {
        console.error('registerDeviceToken (googleLogin) error:', e);
      }
    }

    delete user.password_hash;

    const tokens = signTokens(user);
    return res.json({ user, tokens });
  } catch (err) {
    console.error('googleLogin error:', err);
    return res.status(401).json({ message: 'Xác thực Google thất bại' });
  }
}

// Đổi mật khẩu: yêu cầu đăng nhập
export async function changePassword(req, res) {
  try {
    const userId = req.user?.sub;
    const { currentPassword, newPassword } = req.body;

    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    // kiểm tra độ mạnh
    const meRow = await pool.query('SELECT email, password_hash FROM users WHERE id = $1', [userId]);
    if (meRow.rowCount === 0) return res.status(404).json({ message: 'Không tìm thấy user' });
    const { email, password_hash: hash } = meRow.rows[0];

    const weak = validatePasswordStrength(newPassword, email);
    if (weak) return res.status(400).json({ message: `Mật khẩu mới yếu: ${weak}` });

    // rate limit
    const MAX_FAIL = 5;          // tối đa 5 lần sai
    const LOCK_MINUTES = 15;     // khoá 15 phút

    const rate = await pool.query(
      'SELECT fail_count, locked_until FROM auth_change_password_rate WHERE user_id = $1',
      [userId],
    );

    if (rate.rowCount) {
      const r = rate.rows[0];
      if (r.locked_until && new Date(r.locked_until) > new Date()) {
        const waitSec = Math.ceil((new Date(r.locked_until) - new Date()) / 1000);
        return res.status(429).json({ message: `Thử lại sau ${waitSec}s` });
      }
    }

    // xác thực currentPassword
    if (hash) {
      const ok = await bcrypt.compare(currentPassword ?? '', hash);
      if (!ok) {
        // tăng fail_count
        const cur = rate.rowCount ? rate.rows[0].fail_count : 0;
        const next = cur + 1;
        if (next >= MAX_FAIL) {
          await pool.query(
            `INSERT INTO auth_change_password_rate (user_id, fail_count, locked_until)
             VALUES ($1, 0, now() + ($2 || ' minutes')::interval)
             ON CONFLICT (user_id)
             DO UPDATE SET fail_count = EXCLUDED.fail_count,
                           locked_until = EXCLUDED.locked_until`,
            [userId, LOCK_MINUTES],
          );
          return res.status(429).json({ message: `Sai quá ${MAX_FAIL} lần. Khoá ${LOCK_MINUTES} phút.` });
        } else {
          await pool.query(
            `INSERT INTO auth_change_password_rate (user_id, fail_count, locked_until)
             VALUES ($1, $2, NULL)
             ON CONFLICT (user_id)
             DO UPDATE SET fail_count = EXCLUDED.fail_count,
                           locked_until = NULL`,
            [userId, next],
          );
          return res.status(400).json({ message: 'Mật khẩu hiện tại không đúng' });
        }
      }
    } else if ((currentPassword ?? '').trim() !== '') {
      return res.status(400).json({ message: 'Tài khoản chưa có mật khẩu, để trống ô mật khẩu hiện tại' });
    }

    // đặt/đổi mật khẩu
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           token_version = token_version + 1,  -- thu hồi tất cả phiên
           updated_at = now()
       WHERE id = $2`,
      [newHash, userId],
    );

    // reset rate limit
    await pool.query(
      `INSERT INTO auth_change_password_rate (user_id, fail_count, locked_until)
       VALUES ($1, 0, NULL)
       ON CONFLICT (user_id)
       DO UPDATE SET fail_count = 0, locked_until = NULL`,
      [userId],
    );

    return res.json({ ok: true, message: 'Đổi mật khẩu thành công (đã thu hồi các phiên cũ)' });
  } catch (err) {
    console.error('changePassword error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
// ========== Tự xóa tài khoản (giữ lịch sử chat) ==========
export async function selfDeleteAccount(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    // Kiểm tra user tồn tại + trạng thái hiện tại
    const { rows } = await pool.query(
      'SELECT status FROM users WHERE id = $1',
      [userId],
    );
    if (!rows.length) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }

    const status = rows[0].status;
    if (status === 'self_deleted') {
      return res
        .status(400)
        .json({ message: 'Tài khoản đã được xóa trước đó' });
    }

    // Gọi hàm self_delete_user trong DB
    await pool.query('SELECT self_delete_user($1)', [userId]);
    return res.json({ ok: true, status: 'self_deleted' });
  } catch (err) {
    console.error('selfDeleteAccount error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Đăng xuất ==========

export async function logout(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    // Tăng token_version để revoke mọi access/refresh token cũ
    await pool.query(
      `
      UPDATE users
      SET token_version = token_version + 1,
          updated_at    = now()
      WHERE id = $1
      `,
      [userId],
    );

    // Xóa toàn bộ device của user này
    await pool.query(
      `
      DELETE FROM user_devices
      WHERE user_id = $1
      `,
      [userId],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('logout error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}