// src/middlewares/auth.middleware.js
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';

export async function authRequired(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({
        code: 'NO_TOKEN',
        message: 'Thiếu access token',
      });
    }

    let payload;
    try {
      // BỎ QUA HẾT HẠN, nhưng vẫn verify chữ ký
      payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
        ignoreExpiration: true,
      });
    } catch (err) {
      return res
        .status(401)
        .json({ code: 'TOKEN_INVALID', message: 'Access token không hợp lệ' });
    }

    // Kiểm tra token_version từ DB để thu hồi phiên cũ
    const q = 'SELECT token_version FROM users WHERE id = $1';
    const r = await pool.query(q, [payload.sub]);
    if (r.rowCount === 0) {
      return res
        .status(401)
        .json({ code: 'USER_NOT_FOUND', message: 'Tài khoản không tồn tại' });
    }
    const currentVersion = r.rows[0].token_version ?? 0;
    if ((payload.tv ?? 0) !== currentVersion) {
      return res.status(401).json({
        code: 'TOKEN_REVOKED',
        message: 'Phiên đã bị thu hồi, vui lòng đăng nhập lại',
      });
    }

    req.user = payload; // { sub, email, tv }
    next();
  } catch (e) {
    console.error('authRequired error:', e);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ========== Admin only ==========
// Dùng chung cho tất cả route /api/admin/...
export async function adminOnly(req, res, next) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail) {
      console.error('ADMIN_EMAIL chưa được cấu hình trong .env');
      return res.status(500).json({ message: 'Admin chưa được cấu hình' });
    }

    const q = `
      SELECT
        u.id,
        u.email,
        EXISTS (
          SELECT 1 FROM admins a WHERE a.user_id = u.id
        ) AS in_admins
      FROM users u
      WHERE u.id = $1
    `;
    const r = await pool.query(q, [userId]);
    if (!r.rowCount) {
      return res.status(401).json({ message: 'Tài khoản không tồn tại' });
    }

    const row = r.rows[0];
    const email = (row.email || '').toLowerCase();
    let isAdmin = !!row.in_admins;

    // Nếu email trùng ADMIN_EMAIL thì tự seed vào bảng admins (idempotent)
    if (!isAdmin && email === adminEmail) {
      await pool.query(
        `INSERT INTO admins (user_id)
         VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId],
      );
      isAdmin = true;
    }

    if (!isAdmin) {
      return res
        .status(403)
        .json({ message: 'Bạn không có quyền truy cập trang quản trị' });
    }

    req.isAdmin = true;
    next();
  } catch (e) {
    console.error('adminOnly error:', e);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}