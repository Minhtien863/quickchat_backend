// src/controllers/user.controller.js
import { pool } from '../db.js';
import cloudinary from '../config/cloudinary.js';

// Chuẩn hóa mọi kiểu input ngày sinh về 'YYYY-MM-DD' hoặc null
function normalizeBirthday(input) {
  if (input == null || input === '') return null;

  // Date object
  if (input instanceof Date && !isNaN(input)) {
    const y = input.getUTCFullYear();
    const m = String(input.getUTCMonth() + 1).padStart(2, '0');
    const d = String(input.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // epoch ms/sec
  if (typeof input === 'number') {
    const ms = input > 1e12 ? input : input * 1000;
    const dt = new Date(ms);
    if (!isNaN(dt)) return normalizeBirthday(dt);
  }

  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;

    // ISO: 2025-11-12 hoặc 2025-11-12T...
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    // dd-MM-yyyy
    const dash = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dash) {
      const d = String(parseInt(dash[1], 10)).padStart(2, '0');
      const m = String(parseInt(dash[2], 10)).padStart(2, '0');
      const y = dash[3];
      return `${y}-${m}-${d}`;
    }

    // dd/MM/yyyy
    const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const d = String(parseInt(slash[1], 10)).padStart(2, '0');
      const m = String(parseInt(slash[2], 10)).padStart(2, '0');
      const y = slash[3];
      return `${y}-${m}-${d}`;
    }
  }

  return null;
}

// Map 1 row user -> profile DTO gửi về client
function mapRowToProfile(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    handle: row.username,
    bio: row.about,
    phone: row.phone,
    email: row.email,
    birthday: row.birthday, // luôn là 'YYYY-MM-DD' hoặc null
    avatarUrl: row.avatar_url,
    hasPassword: !!row.has_password,
  };
}

// ====== GET /api/users/me ======
export async function getMyProfile(req, res) {
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
        to_char(u.birthday, 'YYYY-MM-DD') AS birthday,
        u.phone,
        (SELECT url FROM assets WHERE id = u.avatar_asset_id) AS avatar_url,
        (u.password_hash IS NOT NULL) AS has_password,
        COALESCE(u.two_factor_enabled, false) AS two_factor_enabled
      FROM users u
      WHERE u.id = $1
    `;
    const result = await pool.query(q, [userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }

    return res.json({ profile: mapRowToProfile(result.rows[0]) });
  } catch (err) {
    console.error('getMyProfile error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ====== GET /api/users/:id ======
export async function getUserProfile(req, res) {
  try {
    const { id } = req.params;

    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.about,
        to_char(u.birthday, 'YYYY-MM-DD') AS birthday,
        u.phone,
        (SELECT url FROM assets WHERE id = u.avatar_asset_id) AS avatar_url,
        (u.password_hash IS NOT NULL) AS has_password,
        COALESCE(u.two_factor_enabled, false) AS two_factor_enabled,
        COALESCE(ups.birthday_visibility, 'full') AS birthday_visibility
      FROM users u
      LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
      WHERE u.id = $1
    `;
    const result = await pool.query(q, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy user' });
    }

    const row = result.rows[0];

    let birthday = row.birthday;
    if (row.birthday_visibility === 'hidden') {
      birthday = null;
    }

    const profile = mapRowToProfile({
      ...row,
      birthday, // override
    });

    return res.json({ profile });
  } catch (err) {
    console.error('getUserProfile error:', err);
    return res.status(500).json({ message: 'Lỗi lấy user server' });
  }
}


// ====== PATCH /api/users/me ======
export async function updateMyProfile(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

    const { displayName, bio, phone, birthday } = req.body;

    if (!displayName || displayName.trim().length < 2) {
      return res.status(400).json({ message: 'Tên hiển thị không hợp lệ' });
    }

    const normalizedDob = normalizeBirthday(birthday);
    if (birthday && !normalizedDob) {
      return res.status(400).json({ message: 'Ngày sinh không hợp lệ. Định dạng: DD-MM-YYYY' });
    }

    const q = `
      UPDATE users
      SET display_name = $1,
          about        = $2,
          phone        = $3,
          birthday     = $4::date,
          updated_at   = now()
      WHERE id = $5
      RETURNING
        id,
        email,
        display_name,
        username,
        about,
        phone,
        to_char(birthday, 'YYYY-MM-DD') AS birthday,
        (SELECT url FROM assets WHERE id = avatar_asset_id) AS avatar_url,
        (password_hash IS NOT NULL) AS has_password,
        COALESCE(two_factor_enabled, false) AS two_factor_enabled
    `;

    const result = await pool.query(q, [
      displayName.trim(),
      bio ?? null,
      phone ?? null,
      normalizedDob,
      userId,
    ]);

    if (!result.rowCount) return res.status(404).json({ message: 'Không tìm thấy user' });
    return res.json({ profile: mapRowToProfile(result.rows[0]) });
  } catch (err) {
    console.error('updateMyProfile error:', err);
    return res.status(500).json({ message: 'Lỗi upload user server' });
  }
}

// ====== POST /api/users/me/avatar ======
export async function uploadAvatar(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ message: 'Unauthenticated' });
    if (!req.file) return res.status(400).json({ message: 'Thiếu file' });

    // Upload Cloudinary
    const buffer = req.file.buffer;
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'image',
          folder: 'quickchat/avatars',
          transformation: [{ width: 512, height: 512, crop: 'fill', gravity: 'face' }],
        },
        (err, resUpload) => (err ? reject(err) : resolve(resUpload)),
      );
      stream.end(buffer);
    });

    // Ghi assets
    const ins = `
      INSERT INTO assets (kind, url, thumb_url, mime, size_bytes)
      VALUES ('image', $1, $2, $3, $4)
      RETURNING id, url
    `;
    const ares = await pool.query(ins, [
      result.secure_url,
      result.secure_url,
      req.file.mimetype,
      req.file.size,
    ]);
    const assetId = ares.rows[0].id;

    // Cập nhật user
    await pool.query(
      `UPDATE users SET avatar_asset_id = $1, updated_at = now() WHERE id = $2`,
      [assetId, userId],
    );

    // Đọc lại hồ sơ
    const q = `
      SELECT
        u.id,
        u.email,
        u.display_name,
        u.username,
        u.about,
        u.phone,
        to_char(u.birthday, 'YYYY-MM-DD') AS birthday,
        (SELECT url FROM assets WHERE id = u.avatar_asset_id) AS avatar_url,
        (u.password_hash IS NOT NULL) AS has_password,
        COALESCE(u.two_factor_enabled, false) AS two_factor_enabled
      FROM users u
      WHERE u.id = $1
    `;
    const me = await pool.query(q, [userId]);
    const row = me.rows[0];

    const profile = mapRowToProfile(row);

    // Trả về để client cập nhật ngay
    return res.json({
      profile,
      user: {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        username: row.username,
        phone: row.phone,
        avatar_url: row.avatar_url,
      },
      avatarUrl: row.avatar_url,
      assetId,
    });
  } catch (err) {
    console.error('uploadAvatar error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
