// src/controllers/chat.controller.js
import { pool } from '../db.js';
import { getIO } from '../socket/index.js';
import { uploadBufferToCloudinary } from '../config/cloudinary.js';
import path from 'path';
import { sendChatMessagePush } from '../services/fcm.service.js';


// Helper: kiểm tra user có thuộc conversation không, đồng thời trả về conversation_id
async function ensureCanAccessMessage(userId, messageId) {
  const q = `
    SELECT m.conversation_id
    FROM messages m
    JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id
     AND cm.user_id = $1
    WHERE m.id = $2
      AND m.deleted_at IS NULL
  `;
  const { rows } = await pool.query(q, [userId, messageId]);
  return rows[0]?.conversation_id || null;
}

// Helper: kiểm tra user có thuộc conversation không
async function ensureMemberOfConversation(userId, conversationId) {
  const q = `
    SELECT 1
    FROM conversation_members
    WHERE user_id = $1 AND conversation_id = $2
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [userId, conversationId]);
  return rows.length > 0;
}

// Helper: chặn gửi tin trong cuộc trò chuyện 1-1 nếu peer bị khoá / xoá / chặn
async function ensureDirectPeerActive(userId, conversationId) {
  const q = `
    SELECT 
      c.type,
      peer.id AS peer_id,
      peer.status AS peer_status,
      EXISTS (
        SELECT 1
        FROM user_blocks b
        WHERE b.user_id = $1
          AND b.target_user_id = peer.id
      ) AS blocked_by_me,
      EXISTS (
        SELECT 1
        FROM user_blocks b
        WHERE b.user_id = peer.id
          AND b.target_user_id = $1
      ) AS blocked_by_peer
    FROM conversations c
    JOIN conversation_members self_cm
      ON self_cm.conversation_id = c.id
     AND self_cm.user_id = $1
    JOIN conversation_members peer_cm
      ON peer_cm.conversation_id = c.id
     AND peer_cm.user_id <> $1
    JOIN users peer
      ON peer.id = peer_cm.user_id
    WHERE c.id = $2
    LIMIT 1
  `;

  const { rows } = await pool.query(q, [userId, conversationId]);

  if (!rows.length) {
    const err = new Error('CONVERSATION_NOT_FOUND');
    err.httpStatus = 404;
    err.payload = { message: 'Không tìm thấy cuộc trò chuyện' };
    throw err;
  }

  const row = rows[0];

  // Chỉ kiểm tra với conversation 1-1
  if (row.type !== 'direct') {
    return;
  }

  if (row.blocked_by_me) {
    const err = new Error('BLOCKED');
    err.httpStatus = 403;
    err.payload = {
      code: 'BLOCKED',
      message: 'Bạn đã chặn người này, không thể gửi tin nhắn.',
    };
    throw err;
  }

  if (row.blocked_by_peer) {
    const err = new Error('BLOCKED_BY_PEER');
    err.httpStatus = 403;
    err.payload = {
      code: 'BLOCKED_BY_PEER',
      message: 'Người này đã chặn bạn, không thể gửi tin nhắn.',
    };
    throw err;
  }

  if (row.peer_status && row.peer_status !== 'active') {
    const err = new Error('PEER_INACTIVE');
    err.httpStatus = 403;
    err.payload = {
      code: 'PEER_INACTIVE',
      message: 'Tài khoản của người này hiện không thể nhận tin nhắn.',
    };
    throw err;
  }
}

// Helper: chặn gửi tin nếu conversation (đặc biệt là group) bị locked / banned
async function ensureConversationActiveForSend(userId, conversationId) {
  const q = `
    SELECT c.type, c.status
    FROM conversations c
    JOIN conversation_members cm
      ON cm.conversation_id = c.id
     AND cm.user_id = $1
    WHERE c.id = $2
    LIMIT 1
  `;
  const { rows } = await pool.query(q, [userId, conversationId]);

  if (!rows.length) {
    const err = new Error('CONVERSATION_NOT_FOUND');
    err.httpStatus = 404;
    err.payload = { message: 'Không tìm thấy cuộc trò chuyện' };
    throw err;
  }

  const row = rows[0];

  // Chỉ chặn với group
  if (row.type === 'group') {
    if (row.status === 'locked') {
      const err = new Error('GROUP_LOCKED');
      err.httpStatus = 403;
      err.payload = {
        code: 'GROUP_LOCKED',
        message:
          'Nhóm đã bị khoá bởi quản trị viên, tạm thời không thể gửi tin nhắn.',
      };
      throw err;
    }
    if (row.status === 'banned') {
      const err = new Error('GROUP_BANNED');
      err.httpStatus = 403;
      err.payload = {
        code: 'GROUP_BANNED',
        message:
          'Nhóm đã bị cấm bởi quản trị viên, bạn không thể gửi tin nhắn trong nhóm này.',
      };
      throw err;
    }
  }
}

// Helper: map 1 row DB → message DTO (kèm replyTo object)
function mapMessageRow(row, currentUserId) {
  let replyTo = null;

  // case reply tin nhắn thường
  if (row.reply_to_message_id) {
    replyTo = {
      messageId: row.reply_to_message_id,
      senderId: row.reply_sender_id,
      senderDisplayName: row.reply_sender_display_name,
      text: row.reply_text,
      type: row.reply_type,
    };
  }

  // case reply NOTE: lưu trong reply_to_meta
  if (!replyTo && row.reply_to_meta) {
    let meta = row.reply_to_meta;
    if (typeof meta === 'string') {
      try {
        meta = JSON.parse(meta);
      } catch (_) {
        meta = null;
      }
    }
    if (meta && typeof meta === 'object' && meta.type === 'note') {
      replyTo = meta;
    }
  }

  // reactions: { userId, emoji } -> { emoji, userId, userDisplayName, reactedByMe }
  const rawReactions = Array.isArray(row.reactions) ? row.reactions : [];
  const reactions = rawReactions
    .filter(r => r && r.emoji)
    .map(r => {
      const userId = r.userId || r.user_id || null;
      return {
        emoji: r.emoji,
        userId,
        userDisplayName:
          r.userDisplayName || r.user_display_name || null,
        reactedByMe: userId === currentUserId,
      };
    });

  // parse read_by -> readBy
  const rawReadBy = Array.isArray(row.read_by) ? row.read_by : [];
  const readBy = rawReadBy
    .filter(r => r && (r.user_id || r.userId))
    .map(r => ({
      userId: r.userId || r.user_id,
      displayName: r.display_name || r.displayName || null,
      avatarUrl: r.avatar_url || r.avatarUrl || null,
    }));

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    type: row.type,
    text: row.text,
    asset: row.asset_url
      ? {
          id: row.asset_id,
          url: row.asset_url,
        }
      : null,
    replyTo,
    reactions,
    isPinned: !!row.is_pinned,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deleted: !!row.deleted_at,
    isForwarded: !!row.is_forwarded,
    readBy,
  };
}

// Helper: lấy full message (kèm reactions + replyTo) theo id,
// dùng lại sau khi insert / update reaction
export async function fetchMessageById(userId, messageId) {
  const q = `
    SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.type,
      m.text,
      m.asset_id,
      m.reply_to_id,
      m.reply_to_meta,
      m.created_at,
      m.edited_at,
      m.deleted_at,
      m.is_forwarded,
      m.is_pinned,
      
      a.url AS asset_url,

      -- thông tin message được trả lời
      rm.id   AS reply_to_message_id,
      rm.text AS reply_text,
      rm.type AS reply_type,
      ru.id   AS reply_sender_id,
      COALESCE(ru.display_name, ru.email, ru.username) AS reply_sender_display_name,

      -- reactions: lấy từ bảng message_reactions + users
      COALESCE(
        (
          SELECT json_agg(
                   DISTINCT jsonb_build_object(
                     'userId',         mr.user_id,
                     'emoji',          mr.emoji,
                     'userDisplayName',
                       COALESCE(u2.display_name, u2.email, u2.username)
                   )
                 )
          FROM message_reactions mr
          JOIN users u2 ON u2.id = mr.user_id
          WHERE mr.message_id = m.id
        ),
        '[]'::json
      ) AS reactions,

      -- read receipts cho từng message
      COALESCE(
        (
          SELECT json_agg(
                   jsonb_build_object(
                     'user_id',      cm2.user_id,
                     'display_name', COALESCE(u3.display_name, u3.email, u3.username),
                     'avatar_url',   a3.url
                   )
                 )
          FROM conversation_members cm2
          JOIN messages last_msg
            ON last_msg.id = cm2.last_read_message_id
          JOIN users u3
            ON u3.id = cm2.user_id
          LEFT JOIN assets a3
            ON a3.id = u3.avatar_asset_id
          WHERE cm2.conversation_id = m.conversation_id
            AND cm2.user_id <> m.sender_id
            AND last_msg.created_at >= m.created_at
        ),
        '[]'::json
      ) AS read_by
    FROM messages m
    JOIN conversation_members cm
      ON cm.conversation_id = m.conversation_id
     AND cm.user_id = $1
    LEFT JOIN assets a
      ON a.id = m.asset_id
    LEFT JOIN messages rm
      ON rm.id = m.reply_to_id
    LEFT JOIN users ru
      ON ru.id = rm.sender_id
    WHERE m.id = $2
    GROUP BY
      m.id,
      m.reply_to_meta, 
      a.url,
      rm.id,
      rm.text,
      rm.type,
      ru.id,
      ru.display_name,
      ru.email,
      ru.username
  `;

  const { rows } = await pool.query(q, [userId, messageId]);
  if (rows.length === 0) return null;
  return mapMessageRow(rows[0], userId);
}

/**
 * GET /api/chat/conversations/:conversationId/messages
 * Query: ?limit=30&before=2025-01-01T00:00:00.000Z (before là created_at để phân trang lùi)
 */
export async function listMessages(req, res) {
  try {
    const userId = req.user.sub;
    const { conversationId } = req.params;

    const isMember = await ensureMemberOfConversation(userId, conversationId);
    if (!isMember) {
      return res
        .status(403)
        .json({ error: 'Not a member of this conversation' });
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 30)));
    const before = req.query.before ? new Date(req.query.before) : null;

    const params = [userId, conversationId];
    let idx = 3;

    let q = `
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.type,
        m.text,
        m.asset_id,
        m.reply_to_id,
        m.reply_to_meta,
        m.created_at,
        m.edited_at,
        m.deleted_at,
        m.is_forwarded,
        m.is_pinned,

        a.url AS asset_url,

        rm.id   AS reply_to_message_id,
        rm.text AS reply_text,
        rm.type AS reply_type,
        ru.id   AS reply_sender_id,
        COALESCE(ru.display_name, ru.email, ru.username)
          AS reply_sender_display_name,

        -- reactions
        COALESCE(
          (
            SELECT json_agg(
                     DISTINCT jsonb_build_object(
                       'userId',         mr.user_id,
                       'emoji',          mr.emoji,
                       'userDisplayName',
                         COALESCE(u2.display_name, u2.email, u2.username)
                     )
                   )
            FROM message_reactions mr
            JOIN users u2 ON u2.id = mr.user_id
            WHERE mr.message_id = m.id
          ),
          '[]'::json
        ) AS reactions,

        -- read receipts
        COALESCE(
          (
            SELECT json_agg(
                     jsonb_build_object(
                       'user_id',      cm2.user_id,
                       'display_name',
                         COALESCE(u3.display_name, u3.email, u3.username),
                       'avatar_url',   a3.url
                     )
                   )
            FROM conversation_members cm2
            JOIN messages last_msg
              ON last_msg.id = cm2.last_read_message_id
            JOIN users u3
              ON u3.id = cm2.user_id
            LEFT JOIN assets a3
              ON a3.id = u3.avatar_asset_id
            WHERE cm2.conversation_id = m.conversation_id
              AND cm2.user_id <> m.sender_id
              AND last_msg.created_at >= m.created_at
          ),
          '[]'::json
        ) AS read_by

      FROM messages m
      JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id
       AND cm.user_id = $1
      LEFT JOIN assets a
        ON a.id = m.asset_id
      LEFT JOIN messages rm
        ON rm.id = m.reply_to_id
      LEFT JOIN users ru
        ON ru.id = rm.sender_id
      LEFT JOIN user_conversation_clears ucc
        ON ucc.conversation_id = m.conversation_id
       AND ucc.user_id = $1
      WHERE m.conversation_id = $2
        -- nếu user đã clear lịch sử, chỉ thấy tin sau mốc cleared_at
        AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
    `;

    if (before) {
      q += ` AND m.created_at < $${idx}`;
      params.push(before);
      idx += 1;
    }

    q += `
      GROUP BY
        m.id,
        m.reply_to_meta,
        a.url,
        rm.id,
        rm.text,
        rm.type,
        ru.id,
        ru.display_name,
        ru.email,
        ru.username
      ORDER BY m.created_at DESC
      LIMIT $${idx}
    `;
    params.push(limit);

    const { rows } = await pool.query(q, params);

    const messages = rows.reverse().map(row => mapMessageRow(row, userId));
    return res.json({ messages });
  } catch (err) {
    console.error('listMessages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/chat/conversations/:conversationId/messages
 * Body (mới): { text: '...', replyTo?: { messageId, senderId, text, type } }
 * Body (cũ, vẫn support): { text: '...', replyToId?: 'uuid' }
 */
export async function sendText(req, res) {
  try {
    const userId = req.user.sub;
    const { conversationId } = req.params;

    // nhận thêm assetId, assetKind
    const { text, replyTo, replyToId, assetId, assetKind } = req.body || {};

    const isMember = await ensureMemberOfConversation(userId, conversationId);
    if (!isMember) {
      return res
        .status(403)
        .json({ error: 'Not a member of this conversation' });
    }

    await ensureDirectPeerActive(userId, conversationId);
    await ensureConversationActiveForSend(userId, conversationId);

    // xác định có text / có asset không
    const hasText =
      typeof text === 'string' && text.trim().length > 0;
    const hasAsset =
      typeof assetId === 'string' && assetId.trim().length > 0;

    if (!hasText && !hasAsset) {
      return res
        .status(400)
        .json({ error: 'Text or asset is required' });
    }

    // replyTo
    let replyId = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.messageId) {
      replyId = replyTo.messageId;
    } else if (replyToId) {
      replyId = replyToId;
    }

    let replyMeta = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.type === 'note') {
      replyMeta = {
        type: 'note',
        noteId: replyTo.noteId || replyTo.note_id || null,
        text: replyTo.text || null,
        senderId: replyTo.senderId || replyTo.sender_id || null,
        senderDisplayName:
          replyTo.senderDisplayName || replyTo.sender_display_name || null,
        expiresAt: replyTo.expiresAt || null,
      };
    }

    // xác định type message
    let msgType = 'text';
    if (hasAsset) {
      if (assetKind === 'video') {
        msgType = 'video';
      } else {
        msgType = 'image';
      }
    }

    const insertQ = `
      INSERT INTO messages (
        conversation_id,
        sender_id,
        type,
        text,
        asset_id,
        reply_to_id,
        reply_to_meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;

    const { rows: insertRows } = await pool.query(insertQ, [
      conversationId,
      userId,
      msgType,
      hasText ? text.trim() : null,
      hasAsset ? assetId : null,
      replyId,
      replyMeta,
    ]);

    const messageId = insertRows[0].id;
    const message = await fetchMessageById(userId, messageId);

    // broadcast qua socket
    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:new', message);
    } catch (e) {
      console.error('socket broadcast error:', e.message);
    }

    // push notification qua FCM
    try {
      const preview = hasText
        ? text.trim()
        : msgType === 'image'
          ? 'Đã gửi một ảnh'
          : msgType === 'video'
            ? 'Đã gửi một video'
            : '';
      await sendChatMessagePush({
        conversationId,
        senderId: userId,
        preview,
      });
    } catch (e) {
      console.error('sendChatMessagePush error:', e);
    }

    return res.status(201).json({ message });
  } catch (err) {
    console.error('sendText error:', err);
    if (err.httpStatus) {
      return res
        .status(err.httpStatus)
        .json(err.payload || { error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/chat/messages/:messageId/reactions
 * Body: { emoji: '👍' }
 */
export async function addReaction(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;
    const { emoji } = req.body || {};

    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    const conversationId = await ensureCanAccessMessage(userId, messageId);
    if (!conversationId) {
      return res
        .status(404)
        .json({ error: 'Message not found or not accessible' });
    }

    // ====== TOGGLE / REPLACE LOGIC (không dùng cột id) ======
    const { rows: existingRows } = await pool.query(
      `
      SELECT emoji
      FROM message_reactions
      WHERE message_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [messageId, userId],
    );

    const existing = existingRows[0];

    if (!existing) {
      // Chưa react -> insert mới
      await pool.query(
        `
        INSERT INTO message_reactions (message_id, user_id, emoji)
        VALUES ($1, $2, $3)
        `,
        [messageId, userId, emoji],
      );
    } else if (existing.emoji === emoji) {
      // Cùng emoji -> hủy reaction
      await pool.query(
        `
        DELETE FROM message_reactions
        WHERE message_id = $1 AND user_id = $2
        `,
        [messageId, userId],
      );
    } else {
      // Khác emoji -> cập nhật emoji mới
      await pool.query(
        `
        UPDATE message_reactions
        SET emoji = $3
        WHERE message_id = $1 AND user_id = $2
        `,
        [messageId, userId, emoji],
      );
    }

    // Lấy lại message + reactions đã group
    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:updated', message);
    } catch (e) {
      console.error('socket broadcast error:', e.message);
    }

    return res.json({ message });
  } catch (err) {
    console.error('addReaction error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/chat/messages/:messageId/reactions
 * Body: { emoji: '👍' }
 */
export async function removeReaction(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;
    const { emoji } = req.body || {};

    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ error: 'Emoji is required' });
    }

    const conversationId = await ensureCanAccessMessage(userId, messageId);
    if (!conversationId) {
      return res
        .status(404)
        .json({ error: 'Message not found or not accessible' });
    }

    const q = `
      DELETE FROM message_reactions
      WHERE message_id = $1 AND user_id = $2 AND emoji = $3
    `;
    await pool.query(q, [messageId, userId, emoji]);

    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:updated', message);
    } catch (e) {
      console.error('socket broadcast error:', e.message);
    }

    return res.json({ message });
  } catch (err) {
    console.error('removeReaction error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/chat/messages/forward
 * Body: { messageIds: uuid[], conversationIds: uuid[] }
 */
export async function forwardMessages(req, res) {
  try {
    const userId = req.user.sub;
    const { messageIds, conversationIds } = req.body || {};

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'messageIds is required' });
    }
    if (!Array.isArray(conversationIds) || conversationIds.length === 0) {
      return res.status(400).json({ error: 'conversationIds is required' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // chỉ cho forward các tin mà user đang xem được
      const { rows: srcMessages } = await client.query(
        `
        SELECT m.*
        FROM messages m
        JOIN conversation_members cm
          ON cm.conversation_id = m.conversation_id
         AND cm.user_id = $1
        WHERE m.id = ANY($2::uuid[])
          AND m.deleted_at IS NULL
        `,
        [userId, messageIds],
      );

      if (srcMessages.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'No messages to forward' });
      }

      // kiểm tra user có trong các cuộc trò chuyện đích hay không
      const { rows: convRows } = await client.query(
        `
        SELECT cm.conversation_id, c.type, c.status
        FROM conversation_members cm
        JOIN conversations c ON c.id = cm.conversation_id
        WHERE cm.user_id = $1
          AND cm.conversation_id = ANY($2::uuid[])
        `,
        [userId, conversationIds],
      );

      const allowedConvIds = [];
      for (const row of convRows) {
        // Bỏ qua group đã bị khoá / cấm
        if (row.type === 'group' && row.status && row.status !== 'active') {
          continue;
        }
        allowedConvIds.push(row.conversation_id);
      }

      if (allowedConvIds.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ error: 'No target conversations allowed' });
      }

      const inserted = [];

      for (const convId of allowedConvIds) {
        for (const src of srcMessages) {
          const { rows: insRows } = await client.query(
            `
            INSERT INTO messages (
              conversation_id,
              sender_id,
              type,
              text,
              asset_id,
              is_forwarded
            )
            VALUES ($1, $2, $3, $4, $5, true)
            RETURNING id
            `,
            [
              convId,
              userId,
              src.type,
              src.text,
              src.asset_id,
            ],
          );
          inserted.push({ id: insRows[0].id, conversation_id: convId });
        }
      }

      await client.query('COMMIT');

      const io = getIO();
      const resultMessages = [];

      // fetch DTO + broadcast
      for (const row of inserted) {
        const dto = await fetchMessageById(userId, row.id);
        if (!dto) continue;
        resultMessages.push(dto);
        try {
          io.to(`conv:${row.conversation_id}`).emit('message:new', dto);
        } catch (e) {
          console.error('socket broadcast error:', e.message);
        }
      }

      return res.status(201).json({ messages: resultMessages });
    } catch (e) {
      await client.query('ROLLBACK');
      console.error('forwardMessages tx error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('forwardMessages error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Thu hồi tin nhắn (delete for everyone)
// Chỉ cho phép: người gửi + thuộc conversation
export async function revokeMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;

    const qCheck = `
      SELECT m.conversation_id, m.sender_id
      FROM messages m
      JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id
       AND cm.user_id = $1
      WHERE m.id = $2
      LIMIT 1
    `;
    const { rows } = await pool.query(qCheck, [userId, messageId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Message not found or not accessible' });
    }

    const { conversation_id: conversationId, sender_id: senderId } = rows[0];

    if (senderId !== userId) {
      return res.status(403).json({ error: 'Bạn không thể thu hồi tin nhắn của người khác' });
    }

    // Đánh dấu deleted_at, để client hiển thị "Tin nhắn đã bị thu hồi"
    await pool.query(
      `UPDATE messages
       SET deleted_at = NOW()
       WHERE id = $1`,
      [messageId],
    );

    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:updated', message);
    } catch (e) {
      console.error('socket broadcast error (revoke):', e.message);
    }

    return res.json({ message });
  } catch (err) {
    console.error('revokeMessage error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Xóa tin nhắn (tạm thời hard delete, chỉ cho người gửi)
export async function deleteMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;

    const qCheck = `
      SELECT m.conversation_id, m.sender_id
      FROM messages m
      JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id
       AND cm.user_id = $1
      WHERE m.id = $2
      LIMIT 1
    `;
    const { rows } = await pool.query(qCheck, [userId, messageId]);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Message not found or not accessible' });
    }

    const { conversation_id: conversationId, sender_id: senderId } = rows[0];

    if (senderId !== userId) {
      return res.status(403).json({ error: 'Bạn chỉ có thể xóa tin nhắn của mình' });
    }

    await pool.query(`DELETE FROM message_reactions WHERE message_id = $1`, [messageId]);
    await pool.query(`DELETE FROM messages WHERE id = $1`, [messageId]);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:deleted', { id: messageId });
    } catch (e) {
      console.error('socket broadcast error (delete):', e.message);
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('deleteMessage error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Ghim tin nhắn
export async function pinMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;

    const conversationId = await ensureCanAccessMessage(userId, messageId);
    if (!conversationId) {
      return res.status(404).json({ error: 'Message not found or not accessible' });
    }

    await pool.query(
      `UPDATE messages
       SET is_pinned = TRUE
       WHERE id = $1`,
      [messageId],
    );

    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:updated', message);
    } catch (e) {
      console.error('socket broadcast error (pin):', e.message);
    }

    return res.json({ message });
  } catch (err) {
    console.error('pinMessage error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Bỏ ghim tin nhắn
export async function unpinMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { messageId } = req.params;

    const conversationId = await ensureCanAccessMessage(userId, messageId);
    if (!conversationId) {
      return res.status(404).json({ error: 'Message not found or not accessible' });
    }

    await pool.query(
      `UPDATE messages
       SET is_pinned = FALSE
       WHERE id = $1`,
      [messageId],
    );

    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:updated', message);
    } catch (e) {
      console.error('socket broadcast error (unpin):', e.message);
    }

    return res.json({ message });
  } catch (err) {
    console.error('unpinMessage error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// POST /api/chat/messages/upload
// Body: multipart/form-data với field "file"
export async function uploadMessageMedia(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthenticated' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'Thiếu file' });
    }

    const { mimetype, size, buffer, originalname } = req.file;

    // ===== Fallback MIME: nếu null / application/octet-stream thì đoán theo extension =====
    let effectiveMime = mimetype;
    if (!effectiveMime || effectiveMime === 'application/octet-stream') {
      const ext = path.extname(originalname || '').toLowerCase();
      const imgExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif'];
      const vidExt = ['.mp4', '.mov', '.m4v', '.avi', '.3gp'];

      if (imgExt.includes(ext)) {
        effectiveMime = 'image/jpeg';
      } else if (vidExt.includes(ext)) {
        effectiveMime = 'video/mp4';
      }
    }

    const isImage = effectiveMime && effectiveMime.startsWith('image/');
    const isVideo = effectiveMime && effectiveMime.startsWith('video/');

    if (!isImage && !isVideo) {
      return res
        .status(400)
        .json({ message: 'Chỉ hỗ trợ ảnh hoặc video' });
    }

    const resourceType = isVideo ? 'video' : 'image';

    const cld = await uploadBufferToCloudinary(buffer, {
      resource_type: resourceType,
      folder: `quickchat/messages/${resourceType}`,
      ...(isImage
        ? { transformation: [{ width: 1600, height: 1600, crop: 'limit' }] }
        : {}),
    });

    const kind = isVideo ? 'video' : 'image';
    const thumbUrl = cld.secure_url; // sau này có thể tách thumb riêng
    const durationMs =
      isVideo && cld.duration
        ? Math.round(cld.duration * 1000)
        : null;

    const insert = `
      INSERT INTO assets (kind, url, thumb_url, mime, size_bytes, duration_ms)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, kind, url, thumb_url, mime, size_bytes, duration_ms
    `;
    const { rows } = await pool.query(insert, [
      kind,
      cld.secure_url,
      thumbUrl,
      effectiveMime,   // dùng MIME đã fallback
      size,
      durationMs,
    ]);

    const a = rows[0];

    return res.json({
      asset: {
        id: a.id,
        kind: a.kind,
        url: a.url,
        thumbUrl: a.thumb_url,
        mime: a.mime,
        size: a.size_bytes,
        durationMs: a.duration_ms,
      },
    });
  } catch (err) {
    console.error('uploadMessageMedia error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

/**
 * POST /api/chat/conversations/:conversationId/messages/media
 * Body: { assetId: 'uuid', type?: 'image'|'video', text?: string, replyTo? }
 */
export async function sendMedia(req, res) {
  try {
    const userId = req.user.sub;
    const { conversationId } = req.params;
    const { assetId, type, text, replyTo, replyToId } = req.body || {};

    if (!assetId) {
      return res.status(400).json({ error: 'assetId is required' });
    }

    const isMember = await ensureMemberOfConversation(userId, conversationId);
    if (!isMember) {
      return res
        .status(403)
        .json({ error: 'Not a member of this conversation' });
    }

    await ensureDirectPeerActive(userId, conversationId);
    await ensureConversationActiveForSend(userId, conversationId);

    const msgType =
      typeof type === 'string' && type.trim()
        ? type.trim()
        : 'image';

    let replyId = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.messageId) {
      replyId = replyTo.messageId;
    } else if (replyToId) {
      replyId = replyToId;
    }

    let replyMeta = null;
    if (replyTo && typeof replyTo === 'object' && replyTo.type === 'note') {
      replyMeta = {
        type: 'note',
        noteId: replyTo.noteId || replyTo.note_id || null,
        text: replyTo.text || null,
        senderId: replyTo.senderId || replyTo.sender_id || null,
        senderDisplayName:
          replyTo.senderDisplayName || replyTo.sender_display_name || null,
        expiresAt: replyTo.expiresAt || null,
      };
    }

    const insertQ = `
      INSERT INTO messages (
        conversation_id,
        sender_id,
        type,
        text,
        asset_id,
        reply_to_id,
        reply_to_meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `;
    const { rows: insertRows } = await pool.query(insertQ, [
      conversationId,
      userId,
      msgType,
      text || null,
      assetId,
      replyId,
      replyMeta,
    ]);

    const messageId = insertRows[0].id;
    const message = await fetchMessageById(userId, messageId);

    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:new', message);
    } catch (e) {
      console.error('socket broadcast error:', e.message);
    }

    try {
      const preview =
        (text && text.toString().trim()) ||
        (msgType === 'video' ? 'Đã gửi một video' : 'Đã gửi một ảnh');
      await sendChatMessagePush({
        conversationId,
        senderId: userId,
        preview,
      });
    } catch (e) {
      console.error('sendChatMessagePush error:', e);
    }

    return res.status(201).json({ message });
  } catch (err) {
    console.error('sendMedia error:', err);
    if (err.httpStatus) {
      return res
        .status(err.httpStatus)
        .json(err.payload || { error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Lấy thông tin "người còn lại" trong cuộc trò chuyện 1-1
// GET /api/chat/conversations/:conversationId/peer
export async function getConversationPeer(req, res, next) {
  try {
    const { conversationId } = req.params;
    const userId = req.user.sub;

    const { rows } = await pool.query(
      `
      SELECT 
        u.id,
        u.display_name,
        u.last_seen_at,
        a.url AS avatar_url,
        EXISTS (
          SELECT 1
          FROM user_blocks b
          WHERE b.user_id = u.id
            AND b.target_user_id = $2
        ) AS blocked_by_peer
      FROM conversation_members cm
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE cm.conversation_id = $1
        AND cm.user_id <> $2
      LIMIT 1
      `,
      [conversationId, userId],
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ message: 'Không tìm thấy người dùng trong hội thoại' });
    }

    const row = rows[0];

    let lastSeenIso = null;
    let isOnline = false;

    if (row.last_seen_at) {
      const last = new Date(row.last_seen_at);
      lastSeenIso = last.toISOString();
      const diffMs = Date.now() - last.getTime();
      if (diffMs < 5 * 60 * 1000) {
        isOnline = true;
      }
    }

    return res.json({
      id: row.id,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      lastSeenAt: lastSeenIso,
      isOnline,
      blockedByPeer: row.blocked_by_peer,
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/chat/conversations/:conversationId/scheduled
// Body: { text: '...', scheduleAt: '2025-11-30T10:00:00Z', replyTo?: { ... } }
export async function scheduleMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { conversationId } = req.params;
    const { text, scheduleAt, replyTo, replyToId } = req.body || {};

    if (!scheduleAt) {
      return res.status(400).json({ message: 'Thiếu thời gian hẹn giờ (scheduleAt)' });
    }

    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ message: 'Giá trị scheduleAt không hợp lệ' });
    }

    // kiểm tra user có trong cuộc trò chuyện
    const isMember = await ensureMemberOfConversation(userId, conversationId);
    if (!isMember) {
      return res
        .status(403)
        .json({ message: 'Bạn không phải thành viên cuộc trò chuyện này' });
    }

    await ensureConversationActiveForSend(userId, conversationId);

    // chỉ cho phép hẹn giờ tin có nội dung
    if (!text || !text.toString().trim()) {
      return res.status(400).json({ message: 'Nội dung tin nhắn không được để trống' });
    }

    let replyId = null;
    let replyMeta = null;

    if (replyTo && typeof replyTo === 'object') {
      if (replyTo.messageId) {
        replyId = replyTo.messageId;
      }
      if (replyTo.type === 'note') {
        replyMeta = {
          type: 'note',
          noteId: replyTo.noteId || replyTo.note_id || null,
          text: replyTo.text || null,
          senderId: replyTo.senderId || replyTo.sender_id || null,
          senderDisplayName:
            replyTo.senderDisplayName || replyTo.sender_display_name || null,
          expiresAt: replyTo.expiresAt || null,
        };
      }
    } else if (replyToId) {
      replyId = replyToId;
    }

    const insertQ = `
      INSERT INTO scheduled_messages (
        user_id,
        conversation_id,
        text,
        asset_id,
        reply_to_id,
        reply_to_meta,
        schedule_at,
        status
      )
      VALUES ($1, $2, $3, NULL, $4, $5, $6, 'pending')
      RETURNING *
    `;

    const { rows } = await pool.query(insertQ, [
      userId,
      conversationId,
      text.toString().trim(),
      replyId,
      replyMeta,
      when,
    ]);

    const dto = mapScheduledRow(rows[0]);
    return res.status(201).json(dto);
  } catch (err) {
    console.error('scheduleMessage error:', err);
    if (err.httpStatus) {
      return res
        .status(err.httpStatus)
        .json(err.payload || { message: err.message });
    }
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// GET /api/chat/scheduled?conversationId=...
export async function listScheduledMessages(req, res) {
  try {
    const userId = req.user.sub;
    const { conversationId } = req.query;

    const params = [userId];
    let idx = 2;

    let q = `
      SELECT *
      FROM scheduled_messages
      WHERE user_id = $1
        AND status = 'pending'         -- CHỈ LẤY CÁC LỊCH ĐANG CHỜ
    `;

    if (conversationId) {
      q += ` AND conversation_id = $${idx}`;
      params.push(conversationId);
      idx += 1;
    }

    q += `
      ORDER BY schedule_at ASC, created_at DESC
      LIMIT 200
    `;

    const { rows } = await pool.query(q, params);
    const list = rows.map(mapScheduledRow);
    return res.json({ items: list });
  } catch (err) {
    console.error('listScheduledMessages error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// DELETE /api/chat/scheduled/:scheduledId
export async function cancelScheduledMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { scheduledId } = req.params;

    const { rows } = await pool.query(
      `
      UPDATE scheduled_messages
      SET status = 'canceled'
      WHERE id = $1
        AND user_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [scheduledId, userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi pending để huỷ' });
    }

    const dto = mapScheduledRow(rows[0]);
    return res.json(dto);
  } catch (err) {
    console.error('cancelScheduledMessage error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// PATCH /api/chat/scheduled/:scheduledId
// Body: { scheduleAt: '...' }
export async function rescheduleScheduledMessage(req, res) {
  try {
    const userId = req.user.sub;
    const { scheduledId } = req.params;
    const { scheduleAt } = req.body || {};

    if (!scheduleAt) {
      return res.status(400).json({ message: 'Thiếu scheduleAt' });
    }

    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime())) {
      return res.status(400).json({ message: 'scheduleAt không hợp lệ' });
    }

    const { rows } = await pool.query(
      `
      UPDATE scheduled_messages
      SET schedule_at = $3
      WHERE id = $1
        AND user_id = $2
        AND status = 'pending'
      RETURNING *
      `,
      [scheduledId, userId, when],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Không tìm thấy bản ghi pending để đổi giờ' });
    }

    const dto = mapScheduledRow(rows[0]);
    return res.json(dto);
  } catch (err) {
    console.error('rescheduleScheduledMessage error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/chat/scheduled/:scheduledId/send-now
export async function sendScheduledNow(req, res) {
  const client = await pool.connect();
  try {
    const userId = req.user.sub;
    const { scheduledId } = req.params;

    await client.query('BEGIN');

    const { rows } = await client.query(
      `
      SELECT *
      FROM scheduled_messages
      WHERE id = $1
        AND user_id = $2
      FOR UPDATE
      `,
      [scheduledId, userId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Không tìm thấy lịch hẹn' });
    }

    const s = rows[0];

    if (s.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Trạng thái không cho phép gửi ngay' });
    }

    const conversationId = s.conversation_id;

    // đảm bảo user vẫn còn trong cuộc trò chuyện
    const isMember = await ensureMemberOfConversation(userId, conversationId);
    if (!isMember) {
      await client.query('ROLLBACK');
      return res.status(403).json({ message: 'Bạn không còn trong cuộc trò chuyện' });
    }

    // không gửi nếu group đã bị khoá / cấm
    const { rows: convRows } = await client.query(
      `
      SELECT type, status
      FROM conversations
      WHERE id = $1
      `,
      [conversationId],
    );

    if (!convRows.length) {
      await client.query('ROLLBACK');
      return res
        .status(404)
        .json({ message: 'Không tìm thấy cuộc trò chuyện' });
    }

    const conv = convRows[0];
    if (conv.type === 'group' && conv.status && conv.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(403).json({
        message:
          conv.status === 'locked'
            ? 'Nhóm đã bị khoá bởi quản trị viên, không thể gửi tin nhắn.'
            : 'Nhóm đã bị cấm bởi quản trị viên, không thể gửi tin nhắn.',
      });
    }

    // chỗ này gửi như 1 tin text bình thường
    const insertMsgQ = `
      INSERT INTO messages (
        conversation_id,
        sender_id,
        type,
        text,
        asset_id,
        reply_to_id,
        reply_to_meta
      )
      VALUES ($1, $2, 'text', $3, $4, $5, $6)
      RETURNING id
    `;

    const { rows: msgRows } = await client.query(insertMsgQ, [
      conversationId,
      userId,
      s.text,
      s.asset_id,
      s.reply_to_id,
      s.reply_to_meta,
    ]);

    const messageId = msgRows[0].id;

    await client.query(
      `
      UPDATE scheduled_messages
      SET status = 'sent',
          sent_message_id = $3
      WHERE id = $1
        AND user_id = $2
      `,
      [scheduledId, userId, messageId],
    );

    await client.query('COMMIT');

    // lấy lại DTO + broadcast socket
    const message = await fetchMessageById(userId, messageId);
    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('message:new', message);
    } catch (e) {
      console.error('socket broadcast error (sendScheduledNow):', e.message);
    }

    return res.status(201).json({ message });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('sendScheduledNow error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    client.release();
  }
}

function mapScheduledRow(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    text: row.text,
    scheduleAt: row.schedule_at,
    status: row.status,
    createdAt: row.created_at,
    sentMessageId: row.sent_message_id,
  };
}

// Worker: định kỳ quét các tin nhắn hẹn giờ đã đến hạn và gửi đi
export function startScheduledMessageWorker() {
  // mỗi 15 giây quét 1 lần (muốn chậm hơn thì tăng số này)
  const INTERVAL_MS = 15 * 1000;

  setInterval(async () => {
    const client = await pool.connect();
    const toBroadcast = [];

    try {
      await client.query('BEGIN');

      // Lấy các lịch đang pending và đã tới giờ
      const { rows } = await client.query(
        `
        SELECT s.*, c.type AS conv_type, c.status AS conv_status
        FROM scheduled_messages s
        JOIN conversations c ON c.id = s.conversation_id
        WHERE s.status = 'pending'
          AND s.schedule_at <= NOW()
        ORDER BY s.schedule_at ASC
        LIMIT 20
        FOR UPDATE SKIP LOCKED
        `,
      );

      if (rows.length === 0) {
        await client.query('COMMIT');
        return;
      }

      for (const s of rows) {
        const conversationId = s.conversation_id;
        const userId = s.user_id;

        // Nếu là group đã bị khoá / cấm thì huỷ lịch, không gửi
        if (s.conv_type === 'group' && s.conv_status && s.conv_status !== 'active') {
          await client.query(
            `
            UPDATE scheduled_messages
            SET status = 'canceled'
            WHERE id = $1
            `,
            [s.id],
          );
          continue;
        }

        // Đảm bảo user vẫn còn trong đoạn chat
        const { rows: memRows } = await client.query(
          `
          SELECT 1
          FROM conversation_members
          WHERE user_id = $1 AND conversation_id = $2
          LIMIT 1
          `,
          [userId, conversationId],
        );

        if (memRows.length === 0) {
          // nếu user đã rời cuộc trò chuyện thì huỷ lịch
          await client.query(
            `
            UPDATE scheduled_messages
            SET status = 'canceled'
            WHERE id = $1
            `,
            [s.id],
          );
          continue;
        }

        // Gửi như 1 tin nhắn text bình thường
        const { rows: msgRows } = await client.query(
          `
          INSERT INTO messages (
            conversation_id,
            sender_id,
            type,
            text,
            asset_id,
            reply_to_id,
            reply_to_meta
          )
          VALUES ($1, $2, 'text', $3, $4, $5, $6)
          RETURNING id
          `,
          [
            conversationId,
            userId,
            s.text,
            s.asset_id,
            s.reply_to_id,
            s.reply_to_meta,
          ],
        );

        const messageId = msgRows[0].id;

        // Cập nhật trạng thái lịch
        await client.query(
          `
          UPDATE scheduled_messages
          SET status = 'sent',
              sent_message_id = $2
          WHERE id = $1
          `,
          [s.id, messageId],
        );

        toBroadcast.push({
          conversationId,
          userId,
          messageId,
          preview: s.text,
        });
      }

      await client.query('COMMIT');

      // Sau khi COMMIT mới broadcast + push
      for (const item of toBroadcast) {
        const { conversationId, userId, messageId, preview } = item;

        try {
          const message = await fetchMessageById(userId, messageId);
          if (!message) continue;

          // socket
          try {
            const io = getIO();
            io.to(`conv:${conversationId}`).emit('message:new', message);
          } catch (e) {
            console.error('socket broadcast error (scheduled worker):', e.message);
          }

          // push FCM
          try {
            const p =
              preview && preview.toString().trim().length
                ? preview.toString().trim()
                : 'Đã gửi một tin nhắn';
            await sendChatMessagePush({
              conversationId,
              senderId: userId,
              preview: p,
            });
          } catch (e) {
            console.error('sendChatMessagePush error (worker):', e);
          }
        } catch (e) {
          console.error('fetch/broadcast scheduled message error:', e);
        }
      }
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('scheduled worker error:', err);
    } finally {
      client.release();
    }
  }, INTERVAL_MS);
}

export async function deleteConversation(req, res) {
  const { conversationId } = req.params;
  const userId = req.user.sub; // giống các hàm khác

  try {
    // 1) Kiểm tra conversation tồn tại và là group
    const convResult = await pool.query(
      `SELECT id, type
       FROM conversations
       WHERE id = $1`,
      [conversationId],
    );

    if (convResult.rowCount === 0) {
      return res.status(404).json({
        message: 'Không tìm thấy cuộc trò chuyện',
      });
    }

    const conv = convResult.rows[0];
    if (conv.type !== 'group') {
      return res.status(400).json({
        message: 'Chỉ nhóm trò chuyện mới có thể giải tán',
      });
    }

    // 2) Kiểm tra role = owner
    const memberResult = await pool.query(
      `SELECT role
       FROM conversation_members
       WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );

    if (memberResult.rowCount === 0) {
      return res.status(403).json({
        message: 'Bạn không phải thành viên của nhóm này',
      });
    }

    const role = memberResult.rows[0].role;
    if (role !== 'owner') {
      return res.status(403).json({
        message: 'Chỉ chủ nhóm mới được giải tán nhóm',
      });
    }

    // 3) Xoá cuộc trò chuyện (các bảng con dùng FK ON DELETE CASCADE)
    await pool.query('DELETE FROM conversations WHERE id = $1', [
      conversationId,
    ]);

    // phát socket cho các client khác (optional)
    try {
      const io = getIO();
      io.to(`conv:${conversationId}`).emit('conversation:deleted', {
        id: conversationId,
      });
    } catch (e) {
      console.error('socket broadcast error (deleteConversation):', e.message);
    }

    return res.json({
      success: true,
      conversationId,
    });
  } catch (err) {
    console.error('deleteConversation error:', err);
    return res.status(500).json({
      message: 'Lỗi hệ thống khi giải tán nhóm',
    });
  }
}