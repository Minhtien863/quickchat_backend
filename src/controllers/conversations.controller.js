// src/controllers/conversations.controller.js
import { pool } from '../db.js';

export async function listConversations(req, res) {
  const userId = req.user.sub;
  const limit  = Math.max(1, Math.min(100, Number(req.query.limit || 30)));

    const q = `
    WITH user_clears AS (
      SELECT conversation_id, cleared_at
      FROM user_conversation_clears
      WHERE user_id = $1
    ),
    last_msg AS (
      SELECT
        m.*,
        ROW_NUMBER() OVER (
          PARTITION BY m.conversation_id
          ORDER BY m.created_at DESC
        ) AS rn
      FROM messages m
      LEFT JOIN user_clears uc
        ON uc.conversation_id = m.conversation_id
      WHERE m.deleted_at IS NULL
        AND (uc.cleared_at IS NULL OR m.created_at > uc.cleared_at)
    ),
    other_user AS (
      SELECT
        cm.conversation_id,
        u.id               AS other_id,
        u.display_name     AS other_name,
        u.avatar_asset_id  AS other_avatar_asset_id
      FROM conversation_members cm
      JOIN conversation_members cm2
        ON cm2.conversation_id = cm.conversation_id
       AND cm2.user_id <> cm.user_id
      JOIN users u ON u.id = cm2.user_id
      WHERE cm.user_id = $1
    ),
    group_collage AS (
      SELECT
        cm.conversation_id,
        ARRAY_REMOVE(ARRAY_AGG(a.url), NULL) AS member_avatar_urls
      FROM (
        SELECT cm2.*
        FROM conversation_members cm2
        ORDER BY
          CASE WHEN cm2.role = 'owner' THEN 0 ELSE 1 END,
          random()
      ) cm
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      GROUP BY cm.conversation_id
    ),
    unread_counts AS (
      SELECT
        cm.conversation_id,
        cm.user_id,
        COUNT(m.id) AS unread_count
      FROM conversation_members cm
      LEFT JOIN user_clears uc
        ON uc.conversation_id = cm.conversation_id
      LEFT JOIN messages m
        ON m.conversation_id = cm.conversation_id
       AND m.deleted_at IS NULL
       AND (uc.cleared_at IS NULL OR m.created_at > uc.cleared_at)
       AND (m.sender_id IS NULL OR m.sender_id <> cm.user_id)
      LEFT JOIN messages last_read_msg
        ON last_read_msg.id = cm.last_read_message_id
      WHERE cm.user_id = $1
        AND (
          last_read_msg.id IS NULL
          OR m.created_at > last_read_msg.created_at
        )
      GROUP BY cm.conversation_id, cm.user_id
    )
    SELECT
      c.id,
      c.type,
      c.title,
      c.created_at,
      c.status,

      CASE WHEN c.type = 'group' THEN a_grp.url ELSE a_dir.url END AS avatar_url,

      CASE WHEN c.type = 'group' AND c.avatar_asset_id IS NULL
           THEN COALESCE(gc.member_avatar_urls[1:4], ARRAY[]::text[])
           ELSE ARRAY[]::text[]
      END AS member_avatar_urls,

      CASE
        WHEN c.type = 'group' THEN
          COALESCE(
            c.title,
            (
              SELECT string_agg(
                       u.display_name, ', '
                       ORDER BY CASE WHEN cm2.role = 'owner' THEN 0 ELSE 1 END, random()
                     )
              FROM (
                SELECT cm2.*
                FROM conversation_members cm2
                WHERE cm2.conversation_id = c.id
                ORDER BY CASE WHEN cm2.role = 'owner' THEN 0 ELSE 1 END, random()
                LIMIT (2 + floor(random() * 3))::int
              ) cm2
              JOIN users u ON u.id = cm2.user_id
            )
          )
        ELSE
          COALESCE(c.title, ou.other_name)
      END AS computed_title,

      lm.id         AS last_message_id,
      lm.type       AS last_message_type,
      lm.text       AS last_message_text,
      lm.created_at AS last_message_created_at,
      lm.sender_id  AS last_message_sender_id,
      last_sender.display_name AS last_message_sender_name,
      COALESCE(uc.unread_count, 0) AS unread_count

    FROM conversations c
    JOIN conversation_members me
      ON me.conversation_id = c.id AND me.user_id = $1
    LEFT JOIN last_msg lm
      ON lm.conversation_id = c.id AND lm.rn = 1
    LEFT JOIN other_user ou
      ON ou.conversation_id = c.id
    LEFT JOIN assets a_grp
      ON a_grp.id = c.avatar_asset_id
    LEFT JOIN assets a_dir
      ON a_dir.id = ou.other_avatar_asset_id
    LEFT JOIN group_collage gc
      ON gc.conversation_id = c.id
    LEFT JOIN users last_sender
      ON last_sender.id = lm.sender_id
    LEFT JOIN unread_counts uc
      ON uc.conversation_id = c.id AND uc.user_id = $1
    LEFT JOIN hidden_conversations h
      ON h.conversation_id = c.id
     AND h.user_id = $1
    WHERE h.user_id IS NULL
    ORDER BY COALESCE(lm.created_at, c.created_at) DESC
    LIMIT $2
  `;

  const { rows } = await pool.query(q, [userId, limit]);

  const conversations = rows.map(r => ({
    id: r.id,
    type: r.type,
    title: r.title || r.computed_title || null,
    avatarUrl: r.avatar_url || null,
    status: r.status || 'active',
     memberAvatarUrls: Array.isArray(r.member_avatar_urls)
      ? r.member_avatar_urls.filter(Boolean)
      : [],
    unreadCount: Number(r.unread_count || 0),
    lastSenderName: r.last_message_sender_name || null,
    lastMessage: r.last_message_id
      ? {
          id: r.last_message_id,
          conversationId: r.id,
          senderId: r.last_message_sender_id || '',
          type: r.last_message_type,
          text: r.last_message_text,
          asset: null,
          replyTo: null,
          reactions: [],
          createdAt: r.last_message_created_at,
          editedAt: null,
          deleted: false,
        }
      : null,
    createdAt: r.last_message_created_at || r.created_at,
  }));

  return res.json({ conversations });
}

// ====== NEW: mở / tạo hội thoại 1:1 ======
export async function openDirectConversation(req, res) {
  const userId = req.user.sub;
  const { peerUserId } = req.body || {};

  if (!peerUserId) {
    return res.status(400).json({ message: 'peerUserId is required' });
  }
  if (peerUserId === userId) {
    return res.status(400).json({ message: 'Không thể nhắn tin với chính mình' });
  }

  try {
    // xác nhận peer tồn tại
    const peerCheck = await pool.query('SELECT 1 FROM users WHERE id = $1', [peerUserId]);
    if (peerCheck.rowCount === 0) {
      return res.status(404).json({ message: 'Người dùng không tồn tại' });
    }

    // tìm hội thoại direct đã có giữa 2 user
    const existing = await pool.query(
      `
      SELECT c.id
      FROM conversations c
      JOIN conversation_members cm1 ON cm1.conversation_id = c.id AND cm1.user_id = $1
      JOIN conversation_members cm2 ON cm2.conversation_id = c.id AND cm2.user_id = $2
      WHERE c.type = 'direct'
      LIMIT 1
      `,
      [userId, peerUserId],
    );

    if (existing.rowCount > 0) {
      return res.json({ conversationId: existing.rows[0].id });
    }

    // chưa có -> tạo mới trong transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const insConv = await client.query(
        `INSERT INTO conversations (type) VALUES ('direct') RETURNING id`,
      );
      const convId = insConv.rows[0].id;

      // dùng default role = 'member' nếu cột có default
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3)`,
        [convId, userId, peerUserId],
      );

      await client.query('COMMIT');
      return res.status(201).json({ conversationId: convId });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('openDirectConversation tx error:', e);
      return res.status(500).json({ message: 'Không tạo được cuộc trò chuyện', error: e.message });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('openDirectConversation error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
}

// ====== NEW: đánh dấu ĐÃ ĐỌC toàn bộ hội thoại ======
export async function markConversationRead(req, res) {
  const userId = req.user.sub;
  const conversationId = req.params.id;

  try {
    // kiểm tra user có trong hội thoại không
    const memRes = await pool.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (memRes.rowCount === 0) {
      return res.status(404).json({ message: 'Cuộc trò chuyện không tồn tại hoặc bạn không phải thành viên' });
    }

    // lấy message mới nhất chưa bị xóa
    const { rows } = await pool.query(
      `
      SELECT id
      FROM messages
      WHERE conversation_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [conversationId],
    );

    const lastId = rows[0]?.id || null;

    await pool.query(
      `
      UPDATE conversation_members
      SET last_read_message_id = $3
      WHERE conversation_id = $1
        AND user_id = $2
      `,
      [conversationId, userId, lastId],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('markConversationRead error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
}

// ====== NEW: ĐÁNH DẤU CHƯA ĐỌC lại ======
export async function markConversationUnread(req, res) {
  const userId = req.user.sub;
  const conversationId = req.params.id;

  try {
    // lấy membership hiện tại
    const memRes = await pool.query(
      `
      SELECT last_read_message_id
      FROM conversation_members
      WHERE conversation_id = $1
        AND user_id = $2
      `,
      [conversationId, userId],
    );

    if (memRes.rowCount === 0) {
      return res.status(404).json({ message: 'Cuộc trò chuyện không tồn tại hoặc bạn không phải thành viên' });
    }

    const currentLastRead = memRes.rows[0].last_read_message_id;

    // lấy 2 tin nhắn mới nhất
    const { rows } = await pool.query(
      `
      SELECT id
      FROM messages
      WHERE conversation_id = $1
        AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 2
      `,
      [conversationId],
    );

    if (rows.length === 0) {
      // không có tin nào -> không cần làm gì
      return res.json({ ok: true });
    }

    const lastId = rows[0].id;           // message mới nhất
    const prevId = rows[1]?.id || null;  // message liền trước (nếu có)

    // nếu hiện đã có unread (last_read không phải message mới nhất) thì thôi
    if (currentLastRead && currentLastRead !== lastId) {
      return res.json({ ok: true });
    }

    // tạo lại "1 tin chưa đọc":
    // - có >= 2 tin: đọc tới prevId -> còn 1 tin mới nhất chưa đọc
    // - chỉ có 1 tin: đọc tới NULL -> vẫn còn 1 tin duy nhất chưa đọc
    const newLastRead = prevId;

    await pool.query(
      `
      UPDATE conversation_members
      SET last_read_message_id = $3
      WHERE conversation_id = $1
        AND user_id = $2
      `,
      [conversationId, userId, newLastRead],
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('markConversationUnread error:', err);
    return res.status(500).json({ message: 'Lỗi server', error: err.message });
  }
}
// XÓA LỊCH SỬ 1 CHIỀU CHO 1 ĐOẠN CHAT
// DELETE /api/conversations/:conversationId/history
export async function clearConversationHistory(req, res) {
  const client = await pool.connect();
  try {
    const userId = req.user?.sub;
    const { conversationId } = req.params;

    if (!userId) {
      client.release();
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!conversationId) {
      client.release();
      return res
        .status(400)
        .json({ message: 'Missing conversationId' });
    }

    // đảm bảo user là thành viên cuộc trò chuyện
    const { rowCount } = await client.query(
      `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [conversationId, userId],
    );

    if (rowCount === 0) {
      client.release();
      return res.status(404).json({ message: 'Conversation not found' });
    }

    await client.query('BEGIN');

    // ghi/cập nhật thời điểm clear lịch sử 1 chiều
    await client.query(
      `
      INSERT INTO user_conversation_clears (user_id, conversation_id, cleared_at)
      VALUES ($1, $2, now())
      ON CONFLICT (user_id, conversation_id)
      DO UPDATE
        SET cleared_at = EXCLUDED.cleared_at
      `,
      [userId, conversationId],
    );

    await client.query('COMMIT');
    client.release();

    return res.json({
      ok: true,
      conversationId,
      message: 'History cleared for current user only',
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('clearConversationHistory error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}
