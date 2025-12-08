// src/controllers/reports.controller.js
import { pool } from '../db.js';

const VALID_TARGET_TYPES = ['user', 'conversation', 'message', 'note'];


// helper: preview đối tượng bị báo cáo cho phía USER
async function loadTargetPreview(client, targetType, targetId, reporterId) {
  if (targetType === 'user') {
    const q = `
      SELECT u.id, u.display_name, a.url AS avatar_url, u.status
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE u.id = $1`;
    const r = await client.query(q, [targetId]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      status: row.status,
    };
  }

  if (targetType === 'conversation') {
    // Lấy info nhóm + (nếu direct) tên người còn lại trong đoạn chat
    const q = `
      SELECT
        c.id,
        c.type,
        c.status,
        gp.name AS group_name,
        u.display_name AS peer_name,
        a.url AS peer_avatar_url
      FROM conversations c
      LEFT JOIN group_profiles gp ON gp.conversation_id = c.id
      LEFT JOIN conversation_members cm
        ON cm.conversation_id = c.id
       AND cm.user_id <> $2                  -- người còn lại (khác reporter)
      LEFT JOIN users u ON u.id = cm.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE c.id = $1
      LIMIT 1
    `;
    const r = await client.query(q, [targetId, reporterId]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      groupName: row.group_name,
      peerName: row.peer_name,
      peerAvatarUrl: row.peer_avatar_url,
    };
  }

  if (targetType === 'message') {
    const q = `
      SELECT m.id, m.conversation_id, m.type, m.text, m.created_at,
             (m.deleted_at IS NOT NULL) AS deleted
      FROM messages m
      WHERE m.id = $1`;
    const r = await client.query(q, [targetId]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      conversationId: row.conversation_id,
      type: row.type,
      text: row.text,
      createdAt: row.created_at,
      deleted: row.deleted,
    };
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
    if (!r.rowCount) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      ownerAvatarUrl: row.owner_avatar_url,
      text: row.text,
      expiresAt: row.expires_at,
    };
  }

  return null;
}
// POST /api/reports
export async function createReport(req, res) {
  const userId = req.user?.sub;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated' });
  }

  const {
    targetType,
    targetId,
    conversationId,
    reasons,
    description,
    attachmentAssetIds,
  } = req.body || {};

  // validate targetType
  if (!VALID_TARGET_TYPES.includes(targetType)) {
    return res.status(400).json({
      message: 'Loại đối tượng báo cáo không hợp lệ',
    });
  }

  if (!targetId || typeof targetId !== 'string') {
    return res.status(400).json({
      message: 'Thiếu targetId',
    });
  }

  // reasons: mảng string, 1..3
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return res.status(400).json({
      message: 'Vui lòng chọn ít nhất 1 lý do',
    });
  }

  const normalizedReasons = reasons
    .map(r => (typeof r === 'string' ? r.trim() : ''))
    .filter(r => r.length > 0);

  if (normalizedReasons.length === 0) {
    return res.status(400).json({
      message: 'Lý do không hợp lệ',
    });
  }

  if (normalizedReasons.length > 3) {
    return res.status(400).json({
      message: 'Chỉ chọn tối đa 3 lý do',
    });
  }

  const desc =
    typeof description === 'string' && description.trim().length
      ? description.trim()
      : null;

  const hasAttachments =
    Array.isArray(attachmentAssetIds) && attachmentAssetIds.length > 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertReportQ = `
      INSERT INTO reports (
        reporter_id,
        target_type,
        target_id,
        conversation_id,
        reasons,
        description,
        status
      )
      VALUES ($1, $2, $3, $4, $5::text[], $6, 'pending')
      RETURNING id, created_at, status
    `;

    const { rows } = await client.query(insertReportQ, [
      userId,
      targetType,
      targetId,
      conversationId || null,
      normalizedReasons,
      desc,
    ]);

    const report = rows[0];

    if (hasAttachments) {
      const insertAttachQ = `
        INSERT INTO report_attachments (report_id, asset_id)
        VALUES ($1, $2)
      `;
      for (const rawId of attachmentAssetIds) {
        if (!rawId || typeof rawId !== 'string') continue;
        await client.query(insertAttachQ, [report.id, rawId]);
      }
    }

    await client.query('COMMIT');

    return res.status(201).json({
      id: report.id,
      status: report.status,
      createdAt: report.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('createReport error:', err);
    return res.status(500).json({ message: 'Lỗi khi gửi báo cáo' });
  } finally {
    client.release();
  }
}
// GET /api/reports/:id
export async function getMyReport(req, res) {
  const userId = req.user?.sub;
  const { id } = req.params;

  if (!userId) {
    return res.status(401).json({ message: 'Unauthenticated' });
  }

  const client = await pool.connect();
  try {
    const r = await client.query(
      `
      SELECT
        r.id,
        r.reporter_id,
        r.target_type,
        r.target_id,
        r.conversation_id,
        r.reasons,
        r.description,
        r.status,
        r.created_at,
        r.resolved_at,
        r.resolved_by_admin,
        r.resolution_note
      FROM reports r
      WHERE r.id = $1 AND r.reporter_id = $2
      `,
      [id, userId],
    );

    if (!r.rowCount) {
      return res
        .status(404)
        .json({ message: 'Không tìm thấy báo cáo của bạn' });
    }

    const report = r.rows[0];

    // attachments ...
    const att = await client.query(
      `
      SELECT ra.id, ra.asset_id, a.url, a.thumb_url
      FROM report_attachments ra
      JOIN assets a ON a.id = ra.asset_id
      WHERE ra.report_id = $1
      `,
      [id],
    );

    // preview đối tượng bị báo cáo — truyền luôn reporter_id
    const targetPreview = await loadTargetPreview(
      client,
      report.target_type,
      report.target_id,
      report.reporter_id,
    );

    return res.json({
      id: report.id,
      target_type: report.target_type,
      target_id: report.target_id,
      conversation_id: report.conversation_id,
      reasons: report.reasons,
      description: report.description,
      status: report.status,
      created_at: report.created_at,
      resolved_at: report.resolved_at,
      resolution_note: report.resolution_note,
      target_preview: targetPreview || null,
      attachments: att.rows.map(a => ({
        id: a.id,
        asset_id: a.asset_id,
        url: a.url,
        thumb_url: a.thumb_url,
      })),
    });
  } catch (e) {
    console.error('getMyReport error:', e);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}