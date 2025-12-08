// src/middlewares/lastSeen.middleware.js
import { pool } from '../db.js';

// Cập nhật thời điểm truy cập cuối cho user đang đăng nhập
export function touchLastSeen(req, res, next) {
  const userId = req.user?.sub;
  if (!userId) return next();

  // Không chờ kết quả để tránh làm chậm response
  pool
    .query(
      'UPDATE users SET last_seen_at = NOW() WHERE id = $1',
      [userId],
    )
    .catch(err => {
      console.error('touchLastSeen error:', err);
    });

  return next();
}
