// src/controllers/hidden.controller.js
import { pool } from '../db.js';
import bcrypt from 'bcryptjs';

// GET /api/hidden/direct-status?otherUserId=...
// (Giữ nguyên để dùng cho các màn direct nếu cần)
export async function getDirectStatus(req, res) {
  try {
    const userId = req.user?.sub;
    const { otherUserId } = req.query;

    if (!userId || !otherUserId) {
      return res.json({ hidden: false, conversationId: null });
    }

    const sql = `
      SELECT h.user_id AS hidden_by, c.id AS conversation_id
      FROM conversations c
      JOIN conversation_members cm1
        ON cm1.conversation_id = c.id
       AND cm1.user_id = $1
      JOIN conversation_members cm2
        ON cm2.conversation_id = c.id
       AND cm2.user_id = $2
      LEFT JOIN hidden_conversations h
        ON h.conversation_id = c.id
       AND h.user_id = $1
      WHERE c.type = 'direct'
      LIMIT 1
    `;

    const { rows } = await pool.query(sql, [userId, otherUserId]);

    if (rows.length === 0) {
      return res.json({ hidden: false, conversationId: null });
    }

    const row = rows[0];
    return res.json({
      hidden: !!row.hidden_by,
      conversationId: row.conversation_id,
    });
  } catch (e) {
    console.error('getDirectStatus error:', e);
    return res.status(500).json({ hidden: false, conversationId: null });
  }
}

// GET /api/hidden/conversations/:conversationId/status
// -> trả về đang ẩn hay không cho user hiện tại
export async function getConversationStatus(req, res) {
  try {
    const userId = req.user?.sub;
    const { conversationId } = req.params;

    if (!userId || !conversationId) {
      return res.status(400).json({ message: 'Missing user or conversation' });
    }

    const { rows } = await pool.query(
      `
      SELECT 1
      FROM hidden_conversations
      WHERE user_id = $1 AND conversation_id = $2
      LIMIT 1
      `,
      [userId, conversationId],
    );

    return res.json({ hidden: rows.length > 0 });
  } catch (e) {
    console.error('getConversationStatus error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/hidden/pin
// body: { pin: '123456' }
// -> thiết lập hoặc thay đổi PIN ẩn đoạn chat (lưu hash ở bảng user_hidden_chat_settings)
export async function setupHiddenPin(req, res) {
  try {
    const userId = req.user?.sub;
    const { pin } = req.body || {};

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return res
        .status(400)
        .json({ message: 'PIN phải là chuỗi 6 chữ số' });
    }

    const hash = await bcrypt.hash(pin, 10);

    await pool.query(
      `
      INSERT INTO user_hidden_chat_settings (user_id, pin_hash, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (user_id) DO UPDATE
        SET pin_hash = EXCLUDED.pin_hash,
            updated_at = NOW()
      `,
      [userId, hash],
    );

    return res.json({ hasPin: true });
  } catch (e) {
    console.error('setupHiddenPin error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/hidden/pin/verify
// body: { pin: '123456' }
// -> kiểm tra PIN, dùng khi user mở đoạn chat bị ẩn
export async function verifyHiddenPin(req, res) {
  try {
    const userId = req.user?.sub;
    const { pin } = req.body || {};

    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      return res
        .status(400)
        .json({ message: 'PIN phải là chuỗi 6 chữ số' });
    }

    const { rows } = await pool.query(
      `SELECT pin_hash FROM user_hidden_chat_settings WHERE user_id = $1`,
      [userId],
    );
    if (rows.length === 0) {
      return res
        .status(400)
        .json({ message: 'Chưa thiết lập PIN ẩn đoạn chat', ok: false });
    }

    const { pin_hash: pinHash } = rows[0];

    const ok = await bcrypt.compare(pin, pinHash);
    if (!ok) {
      return res.status(401).json({ message: 'PIN không đúng', ok: false });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error('verifyHiddenPin error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// GET /api/hidden/pin/status
// -> trả về user hiện tại đã có PIN ẩn chat hay chưa
export async function getHiddenPinStatus(req, res) {
  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { rowCount } = await pool.query(
      `
      SELECT 1
      FROM user_hidden_chat_settings
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId],
    );

    return res.json({ hasPin: rowCount > 0 });
  } catch (e) {
    console.error('getHiddenPinStatus error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// POST /api/hidden/conversations/:conversationId/hide
export async function hideConversation(req, res) {
  try {
    const userId = req.user?.sub;
    const { conversationId } = req.params;

    if (!userId || !conversationId) {
      return res.status(400).json({ message: 'Missing user or conversation' });
    }

    // kiểm tra user có trong hội thoại
    const { rowCount } = await pool.query(
      `
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = $1 AND user_id = $2
      LIMIT 1
      `,
      [conversationId, userId],
    );

    if (rowCount === 0) {
      return res.status(404).json({ message: 'Conversation not found' });
    }

    // chèn flag ẩn (nếu đã có thì bỏ qua)
    await pool.query(
      `
      INSERT INTO hidden_conversations (user_id, conversation_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, conversation_id) DO NOTHING
      `,
      [userId, conversationId],
    );

    return res.json({ hidden: true });
  } catch (e) {
    console.error('hideConversation error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/hidden/conversations/:conversationId/hide
// DELETE /api/hidden/conversations/:conversationId/hide
export async function unhideConversation(req, res) {
  try {
    const userId = req.user?.sub;
    const { conversationId } = req.params;

    if (!userId || !conversationId) {
      return res.status(400).json({ message: 'Missing user or conversation' });
    }

    // Bỏ ẩn đoạn chat hiện tại
    await pool.query(
      `
      DELETE FROM hidden_conversations
      WHERE user_id = $1 AND conversation_id = $2
      `,
      [userId, conversationId],
    );

    // Sau khi bỏ ẩn, nếu user KHÔNG còn đoạn chat nào đang ẩn
    // thì xoá luôn PIN ẩn trò chuyện.
    const { rowCount: remainingHidden } = await pool.query(
      `
      SELECT 1
      FROM hidden_conversations
      WHERE user_id = $1
      LIMIT 1
      `,
      [userId],
    );

    if (remainingHidden === 0) {
      await pool.query(
        `
        DELETE FROM user_hidden_chat_settings
        WHERE user_id = $1
        `,
        [userId],
      );
    }

    return res.json({
      hidden: false,
      pinCleared: remainingHidden === 0,
    });
  } catch (e) {
    console.error('unhideConversation error:', e);
    return res.status(500).json({ message: 'Server error' });
  }
}

// DELETE /api/hidden/pin
// -> Xóa mã PIN Ẩn trò chuyện + clear lịch sử các đoạn chat đang ẩn cho user hiện tại
export async function clearHiddenPinAndData(req, res) {
  const client = await pool.connect();

  try {
    const userId = req.user?.sub;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Lấy danh sách các đoạn chat đang ẩn TRƯỚC khi mở transaction
    const { rows } = await client.query(
      `
      SELECT conversation_id
      FROM hidden_conversations
      WHERE user_id = $1
      `,
      [userId],
    );

    const conversationIds = rows.map((r) => r.conversation_id);

    // Không có đoạn chat nào đang ẩn -> không cho xóa PIN
    if (conversationIds.length === 0) {
      return res.status(400).json({
        code: 'NO_HIDDEN_CHATS',
        message: 'Không có đoạn chat nào đang được ẩn để xóa PIN.',
      });
    }

    await client.query('BEGIN');

    // Mark clear lịch sử 1 chiều cho các đoạn chat đang ẩn
    await client.query(
      `
      INSERT INTO user_conversation_clears (user_id, conversation_id, cleared_at)
      SELECT $1, c.id, now()
      FROM conversations c
      WHERE c.id = ANY($2::uuid[])
      ON CONFLICT (user_id, conversation_id)
      DO UPDATE SET cleared_at = EXCLUDED.cleared_at
      `,
      [userId, conversationIds],
    );

    // Xóa toàn bộ flag ẩn của user này
    await client.query(
      `
      DELETE FROM hidden_conversations
      WHERE user_id = $1
      `,
      [userId],
    );

    // Xóa luôn mã PIN ẩn trò chuyện
    await client.query(
      `
      DELETE FROM user_hidden_chat_settings
      WHERE user_id = $1
      `,
      [userId],
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      clearedConversations: conversationIds,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('clearHiddenPinAndData error:', e);
    return res.status(500).json({ message: 'Server error' });
  } finally {
    client.release();
  }
}