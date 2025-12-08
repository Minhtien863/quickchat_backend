// src/controllers/notifications.controller.js
import { pool } from '../db.js';

export async function listAppNotifications(req, res) {
  const userId = req.user?.sub;
  if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

  const take = Math.min(parseInt(req.query.limit || '50', 10), 100);
  const skip = Math.max(parseInt(req.query.offset || '0', 10), 0);

  const q = `
    SELECT id, kind, report_id, message, created_at, is_read
    FROM user_app_notifications
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2 OFFSET $3
  `;
  const r = await pool.query(q, [userId, take, skip]);
  res.json(r.rows.map(row => ({
    id: row.id,
    kind: row.kind,             // 'report_resolved' | 'report_rejected'
    reportId: row.report_id,
    message: row.message,
    createdAt: row.created_at,
    isRead: row.is_read
  })));
}

export async function markAppNotificationRead(req, res) {
  const userId = req.user?.sub;
  const { id } = req.params;
  if (!userId) return res.status(401).json({ message: 'Unauthenticated' });

  const q = `
    UPDATE user_app_notifications
    SET is_read = true
    WHERE id = $1 AND user_id = $2
    RETURNING id
  `;
  const r = await pool.query(q, [id, userId]);
  if (!r.rowCount) return res.status(404).json({ message: 'Không tìm thấy thông báo' });
  res.json({ ok: true });
}