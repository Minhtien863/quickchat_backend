import { Router } from 'express';
import {
  startRegister,
  verifyEmail,
  completeProfile,
  login,
  me,
  uploadAvatar,
  googleLogin,
  changePassword,
  selfDeleteAccount,
  logout,
} from '../controllers/auth.controller.js';
import { authRequired } from '../middlewares/auth.middleware.js';
import multer from 'multer';
import { registerDeviceToken } from '../services/fcm.service.js';


import { uploadAvatar as uploadAvatarCtrl } from '../controllers/user.controller.js';
import { sendOtpMail } from '../services/email.service.js';
import { createOrReplaceOtp, canResend, bumpResend, verifyOtp } from '../services/otp.service.js';
import { pool } from '../db.js';
import bcrypt from 'bcrypt';
import { signTokens  } from '../utils/jwt.js';

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

/** ===== Register flow (cũ) ===== */
router.post('/register/start', startRegister);
router.post('/register/verify-email', verifyEmail);
router.post('/complete-profile', authRequired, completeProfile);

/** ===== Login / Me / Avatar ===== */
router.post('/login', login);
router.get('/me', authRequired, me);
router.post('/profile/avatar', authRequired, upload.single('file'), uploadAvatarCtrl);

/** =========================================================
 * Forgot password (reset via OTP) — 3 bước
 * /api/auth/forgot         -> gửi OTP (purpose=reset)
 * /api/auth/verify-otp     -> kiểm tra OTP (KHÔNG consume)
 * /api/auth/reset-password -> kiểm tra + tiêu thụ OTP + đổi mật khẩu
 * ========================================================= */

router.post('/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Thiếu email' });

    // kiểm tra user tồn tại
    const { rows } = await pool.query(`SELECT id, email FROM users WHERE email = $1`, [email]);
    if (!rows.length) return res.status(404).json({ message: 'Email không tồn tại' });

    const user = rows[0];

    // rate limit resend
    const cr = await canResend(email, 'reset');
    if (!cr.allow) {
      if (cr.reason === 'cooldown') {
        return res.status(429).json({ message: `Vui lòng thử lại sau ${cr.waitSec}s` });
      }
      if (cr.reason === 'max_resend') {
        return res.status(429).json({ message: 'Bạn đã yêu cầu lại mã quá nhiều lần' });
      }
    }

    // tạo OTP mới (gắn user_id)
    const otp = await createOrReplaceOtp(email, 'reset', { userId: user.id });

    // gửi email
    try {
      await sendOtpMail({ to: email, code: otp.code, purpose: 'reset' });
      await bumpResend(email, 'reset');
    } catch (e) {
      // dev mode có thể bỏ qua gửi thật
      if (String(process.env.EMAIL_DISABLE || '').toLowerCase() === 'true') {
        console.warn('[email] send failed but EMAIL_DISABLE=true → continue flow', e);
      } else {
        throw e;
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('forgot error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ message: 'Thiếu email hoặc mã OTP' });

    const v = await verifyOtp(email, code, 'reset', { consume: false }); // KHÔNG consume
    if (!v.ok) {
      const map = {
        not_found: 'Không tìm thấy mã OTP',
        expired: 'Mã OTP đã hết hạn',
        mismatch: 'Mã OTP không đúng',
      };
      return res.status(400).json({ message: map[v.reason] || 'OTP không hợp lệ' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('verify-otp error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword } = req.body;
    if (!email || !code || !newPassword) {
      return res.status(400).json({ message: 'Thiếu email, mã OTP hoặc mật khẩu mới' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'Mật khẩu tối thiểu 6 ký tự' });
    }

    // Tiêu thụ OTP ở bước này
    const v = await verifyOtp(email, code, 'reset', { consume: true });
    if (!v.ok) {
      const map = {
        not_found: 'Không tìm thấy mã OTP',
        expired: 'Mã OTP đã hết hạn',
        mismatch: 'Mã OTP không đúng',
      };
      return res.status(400).json({ message: map[v.reason] || 'OTP không hợp lệ' });
    }

    // Đổi mật khẩu
    const passwordHash = await bcrypt.hash(newPassword, 10);
    const upd = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = now()
       WHERE email = $2
       RETURNING id`,
      [passwordHash, email]
    );
    if (upd.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy người dùng' });
    }

    // Tùy chọn: mark used tất cả OTP reset còn sống cho email
    await pool.query(
      `UPDATE email_otp SET used = true WHERE email = $1 AND purpose = 'reset' AND used = false`,
      [email]
    );

    return res.json({ ok: true, message: 'Đổi mật khẩu thành công' });
  } catch (err) {
    console.error('reset-password error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// Google login
router.post('/google', googleLogin);

// Change password
router.post('/change-password', authRequired ,changePassword)

// Two-Factor Auth (email OTP) =====

//GET    /api/auth/2fa/status          -> { enabled: boolean }
router.get('/2fa/status', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT two_factor_enabled FROM users WHERE id = $1`, [req.user.sub]);
    if (!rows.length) return res.status(404).json({ message: 'Không tìm thấy user' });
    return res.json({ enabled: !!rows[0].two_factor_enabled });
  } catch (err) {
    console.error('2fa/status error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

//POST   /api/auth/2fa/start           -> body { action: 'enable'|'disable' } => gửi OTP
router.post('/2fa/start', authRequired, async (req, res) => {
  try {
    const { action } = req.body || {};
    if (!['enable', 'disable'].includes(action)) {
      return res.status(400).json({ message: 'Thiếu hoặc sai action' });
    }
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.user.sub]);
    if (!rows.length) return res.status(404).json({ message: 'Không tìm thấy user' });
    const email = rows[0].email;
    if (!email) return res.status(400).json({ message: 'Tài khoản chưa liên kết email' });

    const purpose = action === 'enable' ? '2fa_enable' : '2fa_disable';

    // rate limit gửi lại
    const cr  = await canResend(email, purpose, { userId: req.user.sub });
    if (!cr.allow) {
      const msg = cr.reason === 'cooldown'
        ? `Vui lòng thử lại sau ${cr.waitSec}s`
        : 'Bạn đã yêu cầu lại mã quá nhiều lần';
      return res.status(429).json({ message: msg });
    }

    // tạo OTP
    const otp = await createOrReplaceOtp(email, purpose, { userId: req.user.sub });

    // gửi mail
    try {
      await sendOtpMail({ to: email, code: otp.code, purpose });
      await bumpResend(email, purpose, { userId: req.user.sub });
    } catch (e) {
      if (String(process.env.EMAIL_DISABLE || '').toLowerCase() === 'true') {
        console.warn('[email] send failed but EMAIL_DISABLE=true → continue flow', e);
      } else {
        throw e;
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('2fa/start error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

//POST   /api/auth/2fa/verify          -> body { action, code } => xác minh và bật/tắt
router.post('/2fa/verify', authRequired, async (req, res) => {
  try {
    const { action, code } = req.body || {};
    if (!['enable', 'disable'].includes(action) || !code) {
      return res.status(400).json({ message: 'Thiếu action hoặc mã OTP' });
    }
    const { rows } = await pool.query(`SELECT email FROM users WHERE id = $1`, [req.user.sub]);
    if (!rows.length) return res.status(404).json({ message: 'Không tìm thấy user' });
    const email = rows[0].email;
    const purpose = action === 'enable' ? '2fa_enable' : '2fa_disable';

    const v = await verifyOtp(email, code, purpose, { consume: true, userId: req.user.sub });
    if (!v.ok) {
      const map = { not_found: 'Không tìm thấy mã OTP', expired: 'Mã OTP đã hết hạn', mismatch: 'Mã OTP không đúng' };
      return res.status(400).json({ message: map[v.reason] || 'OTP không hợp lệ' });
    }

    const enabled = action === 'enable';
    await pool.query(
      `UPDATE users SET two_factor_enabled = $1, updated_at = now() WHERE id = $2`,
      [enabled, req.user.sub],
    );

    return res.json({ ok: true, enabled });
  } catch (err) {
    console.error('2fa/verify error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// sau router.post('/login', login);
router.post('/login-2fa/verify', async (req, res) => {
  try {
    const { email, code, fcmToken, platform, deviceModel, appVersion } = req.body || {};
    if (!email || !code) {
      return res.status(400).json({ message: 'Thiếu email hoặc mã OTP' });
    }

    // tìm user theo email
    const ures = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
    if (!ures.rowCount) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }
    const user = ures.rows[0];

    // Chặn tài khoản inactive
    if (user.status && user.status !== 'active') {
      let msg = 'Tài khoản của bạn không còn hoạt động';
      if (user.status === 'banned') {
        msg = 'Tài khoản của bạn đã bị khóa';
      } else if (user.status === 'locked') {
        msg = 'Tài khoản của bạn đang tạm khóa';
      } else if (user.status === 'self_deleted') {
        msg = 'Tài khoản này đã bị xóa';
      }
      return res
        .status(403)
        .json({ message: msg, code: 'ACCOUNT_INACTIVE', status: user.status });
    }

    // xác minh OTP purpose login2fa
    const v = await verifyOtp(email, code, 'login2fa', { consume: true });
    if (!v.ok) {
      const map = {
        not_found: 'Không tìm thấy mã OTP',
        expired: 'Mã OTP đã hết hạn',
        mismatch: 'Mã OTP không đúng',
      };
      return res.status(400).json({ message: map[v.reason] || 'OTP không hợp lệ' });
    }

    // 1) Bump token_version để revoke phiên cũ
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

    // 2) Ghi FCM token + đá thiết bị cũ
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
        console.error('registerDeviceToken (login-2fa) error:', e);
      }
    }

    // 3) Cấp tokens mới
    delete user.password_hash;
    const tokens = signTokens(user);
    return res.json({ user, tokens });
  } catch (err) {
    console.error('login-2fa/verify error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// Tự xóa tài khoản (user tự xóa, giữ lịch sử chat của người khác)
router.delete('/self-delete', authRequired, selfDeleteAccount);

router.post('/logout', authRequired, logout);

export default router;
