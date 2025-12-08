// src/controllers/admin_reports.controller.js
import { pool } from '../db.js';
import { sendForceLogoutToUser } from '../services/fcm.service.js';
const PAGESIZE_MAX = 100;
function toCamel(row) {
  if (!row) return row;
  const obj = {};
  for (const k of Object.keys(row)) {
    obj[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = row[k];
  }
  return obj;
}

// helper: preview mục tiêu báo cáo
async function loadTargetPreview(client, targetType, targetId) {
  if (targetType === 'user') {
    const q = `
      SELECT u.id, u.display_name, a.url AS avatar_url, u.status
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id = $1`;
    const r = await client.query(q, [targetId]);
    return r.rowCount ? toCamel(r.rows[0]) : null;
  }

  if (targetType === 'conversation') {
    const q = `
      SELECT c.id, c.type, c.status, gp.name AS display_name, a.url AS avatar_url
      FROM conversations c
      LEFT JOIN group_profiles gp ON gp.conversation_id = c.id
      LEFT JOIN assets a ON a.id = gp.avatar_asset_id
      WHERE c.id = $1`;
    const r = await client.query(q, [targetId]);
    return r.rowCount ? toCamel(r.rows[0]) : null;
  }

  if (targetType === 'message') {
    const q = `
      SELECT m.id, m.conversation_id, m.type, m.text, m.created_at, (m.deleted_at IS NOT NULL) AS deleted
      FROM messages m
      WHERE m.id = $1`;
    const r = await client.query(q, [targetId]);
    return r.rowCount ? toCamel(r.rows[0]) : null;
  }

  if (targetType === 'note') {
    const q = `
      SELECT
        n.id,
        n.owner_id,
        u.display_name AS owner_name,
        a.url AS owner_avatar_url,
        n.text,
        n.expires_at
      FROM user_notes_24h n
      JOIN users u ON u.id = n.owner_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE n.id = $1`;
    const r = await client.query(q, [targetId]);
    return r.rowCount ? toCamel(r.rows[0]) : null;
  }
  return null;
}

export async function adminListReports(req, res) {
  const { status, targetType, q, limit, offset } = req.query || {};
  const take = Math.min(parseInt(limit || '20', 10), PAGESIZE_MAX);
  const skip = Math.max(parseInt(offset || '0', 10), 0);

  const where = [];
  const params = [];
  if (status) {
    params.push(status);
    where.push(`r.status = $${params.length}`);
  }
  if (targetType) {
    params.push(targetType);
    where.push(`r.target_type = $${params.length}`);
  }
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where.push(`(r.description ILIKE $${params.length} OR EXISTS(
      SELECT 1 FROM unnest(r.reasons) AS x WHERE x ILIKE $${params.length}
    ))`);
  }

  params.push(take);
  params.push(skip);

  const sql = `
    SELECT
      r.*,
      u.display_name AS reporter_name,
      u.email AS reporter_email
    FROM reports r
    JOIN users u ON u.id = r.reporter_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `;

  const client = await pool.connect();
  try {
    const r = await client.query(sql, params);

    const list = [];
    for (const row of r.rows) {
      const base = toCamel(row);
      base.targetPreview = await loadTargetPreview(
        client,
        row.target_type,
        row.target_id,
      );
      list.push(base);
    }

    res.json(list);
  } finally {
    client.release();
  }
}

// GET /api/admin/reports/:id
export async function adminGetReport(req, res) {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT r.*, u.display_name AS reporter_name, u.email AS reporter_email
      FROM reports r
      JOIN users u ON u.id = r.reporter_id
      WHERE r.id = $1
    `, [id]);

    if (!r.rowCount) return res.status(404).json({ message: 'Không tìm thấy báo cáo' });

    const report = toCamel(r.rows[0]);

    // attachments
    const att = await client.query(`
      SELECT ra.id, ra.asset_id, a.url, a.thumb_url
      FROM report_attachments ra
      JOIN assets a ON a.id = ra.asset_id
      WHERE ra.report_id = $1
    `, [id]);

    report.attachments = att.rows.map(toCamel);

    // load preview mục tiêu
    report.targetPreview = await loadTargetPreview(client, report.targetType, report.targetId);

    res.json(report);
  } finally {
    client.release();
  }
}

// PATCH /api/admin/reports/:id
// helper: tìm user đích để áp dụng action (lock/ban/active)
async function getTargetUserId(client, report) {
  // Nếu target_type = user => target chính là user
  if (report.target_type === 'user') {
    return report.target_id;
  }

  // Nếu report vào note => lấy owner của note
  if (report.target_type === 'note') {
    const r = await client.query(
      `SELECT owner_id FROM user_notes_24h WHERE id = $1`,
      [report.target_id],
    );
    if (r.rowCount) return r.rows[0].owner_id;
    return null;
  }

  // Nếu report vào conversation => với direct thì lấy user còn lại
  if (report.target_type === 'conversation') {
    const r = await client.query(
      `
      SELECT c.type, cm.user_id
      FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id
      WHERE c.id = $1
        AND cm.user_id <> $2
      LIMIT 1
      `,
      [report.target_id, report.reporter_id],
    );
    if (!r.rowCount) return null;
    const row = r.rows[0];
    if (row.type !== 'direct') return null; // group sẽ xử lý riêng
    return row.user_id;
  }

  return null;
}

// helper: áp dụng trạng thái user + revoke token
async function applyUserStatus(client, userId, status) {
  if (!userId) return;
  await client.query(
    `
    UPDATE users
    SET status = $2,
        updated_at = now(),
        token_version = COALESCE(token_version, 0) + 1
    WHERE id = $1
    `,
    [userId, status],
  );
}

// helper: áp dụng trạng thái nhóm (conversation)
async function applyGroupStatus(client, conversationId, status) {
  if (!conversationId) return;

  if (status === 'banned') {
    await client.query(
      `DELETE FROM messages WHERE conversation_id = $1`,
      [conversationId],
    );
  }

  await client.query(
    `
    UPDATE conversations
    SET status = $2
    WHERE id = $1
    `,
    [conversationId, status],
  );
}

export async function adminUpdateReport(req, res) {
  const adminId = req.user?.sub;
  const { id } = req.params;
  const { status, action, note } = req.body || {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const r0 = await client.query(
      `SELECT * FROM reports WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!r0.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Không tìm thấy báo cáo' });
    }
    const report = r0.rows[0];

    // Nếu đã xử lý rồi thì chặn update thêm
    if (report.status === 'resolved' || report.status === 'rejected') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: 'Báo cáo này đã được xử lý, không thể cập nhật thêm.',
      });
    }

    // thông tin để gửi thông báo cho user bị xử lý (nếu có)
    let sanctionUserId = null;
    let sanctionNewStatus = null;

    // 1) Thực thi action (nếu có)
    if (action) {
      // ---- hành động trên USER ----
      if (
        action === 'set_user_active' ||
        action === 'lock_user' ||
        action === 'ban_user'
      ) {
        const targetUserId = await getTargetUserId(client, report);
        if (targetUserId) {
          const newStatus =
            action === 'set_user_active'
              ? 'active'
              : action === 'lock_user'
                ? 'locked'
                : 'banned';

          await applyUserStatus(client, targetUserId, newStatus);

          sanctionUserId = targetUserId;
          sanctionNewStatus = newStatus;
        }
      }

      // giữ lại hỗ trợ ban_user cũ khi target_type = user
      if (action === 'ban_user' && report.target_type === 'user') {
        await client.query(
          `UPDATE users SET status='banned', updated_at = now()
           WHERE id = $1`,
          [report.target_id],
        );

        if (!sanctionUserId) {
          sanctionUserId = report.target_id;
          sanctionNewStatus = 'banned';
        }
      }

      // ---- hành động trên GROUP / CONVERSATION ----
      if (
        action === 'set_group_active' ||
        action === 'lock_group' ||
        action === 'ban_group'
      ) {
        const convId =
          report.target_type === 'conversation'
            ? report.target_id
            : report.conversation_id;
        if (convId) {
          const newStatus =
            action === 'set_group_active'
              ? 'active'
              : action === 'lock_group'
                ? 'locked'
                : 'banned';
          await applyGroupStatus(client, convId, newStatus);
        }
      }

      // giữ lại lock_group cũ (target_type = conversation)
      if (action === 'lock_group' && report.target_type === 'conversation') {
        await client.query(
          `UPDATE conversations SET status='locked' WHERE id = $1`,
          [report.target_id],
        );
      }

      // ---- xoá tin nhắn ----
      if (action === 'delete_message' && report.target_type === 'message') {
        await client.query(
          `
          UPDATE messages
          SET deleted_at = now()
          WHERE id = $1 AND deleted_at IS NULL
          `,
          [report.target_id],
        );
      }

      // ---- xoá note ----
      if (action === 'delete_note' && report.target_type === 'note') {
        await client.query(
          `DELETE FROM user_notes_24h WHERE id = $1`,
          [report.target_id],
        );
      }

      // 'warn' chỉ ghi chú, không làm gì thêm
    }

    // 2) Nếu có action mà client không chọn status -> mặc định resolved
    const nextStatus = status ?? (action ? 'resolved' : null);

    const r1 = await client.query(
      `
      UPDATE reports
      SET
        status = COALESCE($2, status),
        resolved_at = CASE
          WHEN $2 IN ('resolved','rejected') THEN now()
          ELSE resolved_at
        END,
        resolved_by_admin = CASE
          WHEN $2 IN ('resolved','rejected') THEN $3
          ELSE resolved_by_admin
        END,
        resolution_note = COALESCE($4, resolution_note)
      WHERE id = $1
      RETURNING *
      `,
      [id, nextStatus, adminId || null, note || null],
    );

    const updated = r1.rows[0];

    // 3) Thông báo cho người báo cáo khi kết thúc
    if (updated.status === 'resolved' || updated.status === 'rejected') {
      const kind =
        updated.status === 'resolved'
          ? 'report_resolved'
          : 'report_rejected';
      const msg =
        updated.status === 'resolved'
          ? 'Báo cáo của bạn đã được xử lý.'
          : 'Báo cáo của bạn đã bị từ chối.';

      await client.query(
        `
        INSERT INTO user_app_notifications (user_id, kind, report_id, message)
        VALUES ($1, $2, $3, $4)
        `,
        [updated.reporter_id, kind, updated.id, msg],
      );
    }

    // 4) Thông báo cho user bị xử lý (lock/ban/unlock) nếu có
    if (sanctionUserId && sanctionNewStatus) {
      let sanctionKind = null;
      let sanctionMessage = null;

      if (sanctionNewStatus === 'locked') {
        sanctionKind = 'admin_user_locked';
        sanctionMessage =
          'Tài khoản của bạn đã bị tạm khoá do vi phạm quy tắc sử dụng. '
          + 'Mọi thắc mắc, khiếu nại vui lòng liên hệ 2124801040041@student.tdmu.edu.vn.';
      } else if (sanctionNewStatus === 'banned') {
        sanctionKind = 'admin_user_banned';
        sanctionMessage =
          'Tài khoản của bạn đã bị cấm vĩnh viễn do vi phạm nghiêm trọng. '
          + 'Mọi thắc mắc, khiếu nại vui lòng liên hệ 2124801040041@student.tdmu.edu.vn.';
      } else if (sanctionNewStatus === 'active') {
        sanctionKind = 'admin_user_unlocked';
        sanctionMessage =
          'Tài khoản của bạn đã được mở khoá và có thể sử dụng lại bình thường.';
      }

      if (sanctionKind && sanctionMessage) {
        // app-noti trong hệ thống
        await client.query(
          `
          INSERT INTO user_app_notifications (user_id, kind, report_id, message)
          VALUES ($1, $2, $3, $4)
          `,
          [sanctionUserId, sanctionKind, updated.id, sanctionMessage],
        );

        // Nếu là lock/ban thì bắn FCM force_logout để cưỡng chế đăng xuất
        if (
          sanctionNewStatus === 'locked' ||
          sanctionNewStatus === 'banned'
        ) {
          console.log(
            '[ADMIN_REPORT] sendForceLogoutToUser user=',
            sanctionUserId,
            'status=',
            sanctionNewStatus,
          );
          await sendForceLogoutToUser({
            userId: sanctionUserId,
            reason:
              sanctionNewStatus === 'locked'
                ? 'admin_user_locked'
                : 'admin_user_banned',
            message: sanctionMessage,
          });
        }
      }
    }

    await client.query('COMMIT');

    return res.json(toCamel(updated));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('adminUpdateReport error:', e);
    return res.status(500).json({ message: 'Cập nhật báo cáo thất bại' });
  } finally {
    client.release();
  }
}