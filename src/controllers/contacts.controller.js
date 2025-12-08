import { pool } from '../db.js';
import { emitToUser } from '../socket/index.js';

// GET /api/contacts/friends
export async function listFriends(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const q = (req.query.q || '').toString().trim();
    const limit = Number(req.query.limit || 200);

    const params = [meId];
    let filter = '';
    if (q) {
      params.push(`%${q}%`);
      filter = ' AND (u.display_name ILIKE $2 OR u.username ILIKE $2 OR u.email ILIKE $2)';
    }

    const sql = `
      SELECT
        u.id,
        u.display_name,
        u.last_seen_at,
        COALESCE(ups.last_seen_visible, true) AS last_seen_visible,
        a.url AS avatar_url
      FROM user_friends f
      JOIN users u ON u.id = f.friend_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      LEFT JOIN user_privacy_settings ups ON ups.user_id = u.id
      WHERE f.user_id = $1
      ${filter}
      ORDER BY u.display_name ASC
      LIMIT ${limit}
    `;

    const rs = await pool.query(sql, params);

    const friends = rs.rows.map(r => {
      const lastSeenVisible = r.last_seen_visible ?? true;

      const online = !!(
        lastSeenVisible &&
        r.last_seen_at &&
        (new Date(r.last_seen_at) >= new Date(Date.now() - 5 * 60 * 1000))
      );

      return {
        id: r.id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        online,
        isNew: false,
      };
    });

    return res.json({ friends });
  } catch (err) {
    console.error('listFriends error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// GET /api/contacts/invites/received
export async function listReceivedInvites(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const sql = `
      SELECT fi.id,
             fi.sender_id AS user_id,   -- người GỬI lời mời
             fi.created_at,
             u.display_name,
             a.url AS avatar_url
      FROM friend_invites fi
      JOIN users u ON u.id = fi.sender_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE fi.receiver_id = $1
        AND fi.status = 'pending'
      ORDER BY fi.created_at DESC
      LIMIT 50
    `;
    const rs = await pool.query(sql, [meId]);

    const invites = rs.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      createdAt: r.created_at,
    }));

    return res.json({ invites });
  } catch (err) {
    console.error('listReceivedInvites error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}


// GET /api/contacts/invites/sent
export async function listSentInvites(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const sql = `
      SELECT fi.id,
             fi.receiver_id AS user_id,  -- người ĐƯỢC mời
             fi.created_at,
             u.display_name,
             a.url AS avatar_url
      FROM friend_invites fi
      JOIN users u ON u.id = fi.receiver_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE fi.sender_id = $1
        AND fi.status = 'pending'
      ORDER BY fi.created_at DESC
      LIMIT 50
    `;
    const rs = await pool.query(sql, [meId]);

    const invites = rs.rows.map(r => ({
      id: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      createdAt: r.created_at,
    }));

    return res.json({ invites });
  } catch (err) {
    console.error('listSentInvites error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/contacts/invites  { userId }
export async function sendInvite(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ message: 'Thiếu userId' });
    if (userId === meId) {
      return res.status(400).json({ message: 'Không thể tự kết bạn với chính mình' });
    }

    const f = await pool.query(
      `SELECT 1 FROM user_friends WHERE user_id = $1 AND friend_id = $2`,
      [meId, userId]
    );
    if (f.rowCount > 0) {
      return res.status(409).json({ message: 'Đã là bạn bè' });
    }

    const sql = `
      INSERT INTO friend_invites (sender_id, receiver_id, status)
      VALUES ($1, $2, 'pending')
      ON CONFLICT (sender_id, receiver_id)
      DO UPDATE SET status = 'pending', updated_at = now()
      RETURNING id
    `;
    const rs = await pool.query(sql, [meId, userId]);
    const inviteId = rs.rows[0].id; // <-- thêm dòng này

    // Thông báo realtime
    emitToUser(userId, 'contacts:invites:changed', {
      kind: 'received_new',
      inviteId,
      fromUserId: meId,
    });

    emitToUser(meId, 'contacts:invites:changed', {
      kind: 'sent_new',
      inviteId,
      toUserId: userId,
    });

    return res.status(201).json({ inviteId });
  } catch (err) {
    console.error('sendInvite error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}


// POST /api/contacts/invites/:id/accept
export async function acceptInvite(req, res) {
  const client = await pool.connect();
  try {
    const meId = req.user?.sub;
    if (!meId) {
      client.release();
      return res.status(401).json({ message: 'Unauthenticated' });
    }
    const { id } = req.params;

    await client.query('BEGIN');

    const sel = await client.query(
      `SELECT * FROM friend_invites WHERE id = $1 AND receiver_id = $2 AND status = 'pending'`,
      [id, meId],
    );
    if (sel.rowCount === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ message: 'Không tìm thấy lời mời' });
    }
    const fi = sel.rows[0];

    await client.query(
      `UPDATE friend_invites
       SET status = 'accepted', updated_at = now()
       WHERE id = $1`,
      [id],
    );

    // Tạo quan hệ bạn bè 2 chiều bằng hàm tiện ích
    await client.query(`SELECT add_friendship($1, $2)`, [fi.sender_id, fi.receiver_id]);

    emitToUser(fi.sender_id, 'contacts:invites:changed', {
  kind: 'accepted',
  inviteId: fi.id,
  byUserId: fi.receiver_id,
});
emitToUser(fi.receiver_id, 'contacts:invites:changed', {
  kind: 'accepted',
  inviteId: fi.id,
  byUserId: fi.receiver_id,
});

// Cập nhật danh sách bạn bè 2 bên
emitToUser(fi.sender_id, 'contacts:friends:changed', {
  userId: fi.receiver_id,
});
emitToUser(fi.receiver_id, 'contacts:friends:changed', {
  userId: fi.sender_id,
});
    await client.query('COMMIT');
    client.release();
    return res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('acceptInvite error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/contacts/invites/:id/decline
export async function declineInvite(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });
    const { id } = req.params;

    await pool.query(
      `UPDATE friend_invites
       SET status = 'declined', updated_at = now()
       WHERE id = $1 AND receiver_id = $2 AND status = 'pending'`,
      [id, meId],
    );
    emitToUser(meId, 'contacts:invites:changed', {
  kind: 'declined',
  inviteId: id,
});

    return res.status(204).send();
  } catch (err) {
    console.error('declineInvite error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/contacts/invites/:id/cancel (huỷ lời mời mình đã gửi)
// POST /api/contacts/invites/:id/cancel (huỷ lời mời mình đã gửi)
export async function cancelSentInvite(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });
    const { id } = req.params;

    const rs = await pool.query(
      `
      UPDATE friend_invites
      SET status = 'canceled', updated_at = now()
      WHERE id = $1 AND sender_id = $2 AND status = 'pending'
      RETURNING receiver_id
      `,
      [id, meId],
    );

    if (rs.rowCount === 0) {
      // không còn pending để huỷ
      return res.status(404).json({ message: 'Không tìm thấy lời mời' });
    }

    const receiverId = rs.rows[0].receiver_id;

    // thông báo cho người gửi
    emitToUser(meId, 'contacts:invites:changed', {
      kind: 'canceled',
      inviteId: id,
    });

    // thông báo cho người nhận 
    emitToUser(receiverId, 'contacts:invites:changed', {
      kind: 'canceled',
      inviteId: id,
    });

    return res.status(204).send();
  } catch (err) {
    console.error('cancelSentInvite error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}


// GET /api/contacts/search-users?q=...&limit=20
// Tìm người để KẾT BẠN: loại trừ chính mình, loại trừ đã là bạn,
// trả về cờ invitedByMe (đã gửi lời mời), inboundInviteId (họ mời mình)
export async function findUsersForInvite(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const raw = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);
    if (!raw) return res.json({ items: [] });

    const isEmail   = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(raw);
    const isHandle  = !isEmail && /^@[a-z0-9_.]{3,30}$/.test(raw);
    const digitsOnly = (s) => (s || '').replace(/\D/g, '');
    const isPhone   = !isEmail && !isHandle && (() => {
      const d = digitsOnly(raw);
      return d.length >= 9 && d.length <= 15;
    })();

    // Common FROM/JOIN/WHERE (loại trừ bản thân, đã là bạn, block 2 chiều)
    const baseFrom = `
      FROM users u
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      LEFT JOIN LATERAL (
        SELECT 1 FROM user_friends f
        WHERE f.user_id = $1 AND f.friend_id = u.id
        LIMIT 1
      ) lf ON TRUE
      LEFT JOIN LATERAL (
        SELECT 1 FROM user_blocks b
        WHERE (b.user_id = $1 AND b.target_user_id = u.id)
           OR (b.user_id = u.id AND b.target_user_id = $1)
        LIMIT 1
      ) lb ON TRUE
      LEFT JOIN LATERAL (
        SELECT receiver_id FROM friend_invites fi
        WHERE fi.sender_id = $1 AND fi.receiver_id = u.id AND fi.status = 'pending'
        LIMIT 1
      ) pm ON TRUE
      LEFT JOIN LATERAL (
        SELECT id, sender_id FROM friend_invites fi
        WHERE fi.receiver_id = $1 AND fi.sender_id = u.id AND fi.status = 'pending'
        LIMIT 1
      ) pt ON TRUE
      WHERE u.id <> $1
        AND lf IS NULL   -- chưa là bạn
        AND lb IS NULL   -- không bị block 2 chiều
    `;

    let sql, params;

    if (isEmail) {
      // email là citext -> '=' đã case-insensitive
      sql = `
        SELECT u.id, u.display_name, u.username, u.email, a.url AS avatar_url,
               (pm.receiver_id IS NOT NULL) AS invited_by_me,
               pt.id AS inbound_invite_id
        ${baseFrom}
          AND u.email = $2
        LIMIT 1
      `;
      params = [meId, raw];
    } else if (isHandle) {
      const handle = raw.slice(1); // bỏ '@'
      sql = `
        SELECT u.id, u.display_name, u.username, u.email, a.url AS avatar_url,
               (pm.receiver_id IS NOT NULL) AS invited_by_me,
               pt.id AS inbound_invite_id
        ${baseFrom}
          AND u.username = $2
        LIMIT 1
      `;
      params = [meId, handle];
    } else if (isPhone) {
      const d = digitsOnly(raw);
      // so khớp CHÍNH XÁC theo digits-only
      sql = `
        SELECT u.id, u.display_name, u.username, u.email, a.url AS avatar_url,
               (pm.receiver_id IS NOT NULL) AS invited_by_me,
               pt.id AS inbound_invite_id
        ${baseFrom}
          AND regexp_replace(coalesce(u.phone,''), '\\\\D', '', 'g') = $2
        LIMIT 1
      `;
      params = [meId, d];
    } else {
      // Không khớp 3 mẫu -> không tìm
      return res.json({ items: [] });
    }

    const rs = await pool.query(sql, params);
    const items = rs.rows.map(r => ({
      id: r.id,
      displayName: r.display_name,
      handle: r.username,
      email: r.email,
      avatarUrl: r.avatar_url,
      invitedByMe: !!r.invited_by_me,
      inboundInviteId: r.inbound_invite_id || null,
    }));

    return res.json({ items });
  } catch (err) {
    console.error('findUsersForInvite error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
// GET /api/contacts/relation/:id
// Trả về: { kind: 'self'|'friend'|'invitedByMe'|'invitedMePending'|'blocked'|'none', inboundInviteId?: uuid }
export async function getRelationWithUser(req, res) {
  try {
    const meId = req.user?.sub;
    const otherId = req.params.id;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });
    if (!otherId) return res.status(400).json({ message: 'Thiếu id' });

    if (meId === otherId) {
      return res.json({ kind: 'self' });
    }

    // blocked 2 chiều?
    const bq = `
      SELECT 1
      FROM user_blocks b
      WHERE (b.user_id = $1 AND b.target_user_id = $2)
         OR (b.user_id = $2 AND b.target_user_id = $1)
      LIMIT 1
    `;
    const b = await pool.query(bq, [meId, otherId]);
    if (b.rowCount > 0) {
      return res.json({ kind: 'blocked' });
    }

    // bạn bè?
    const fq = `
      SELECT 1 FROM user_friends
      WHERE user_id = $1 AND friend_id = $2
      LIMIT 1
    `;
    const f = await pool.query(fq, [meId, otherId]);
    if (f.rowCount > 0) {
      return res.json({ kind: 'friend' });
    }

    // họ đã mời mình? (pending ngược chiều)
    const invIn = await pool.query(
      `SELECT id FROM friend_invites
       WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'
       LIMIT 1`,
      [otherId, meId],
    );
    if (invIn.rowCount > 0) {
      return res.json({ kind: 'invitedMePending', inboundInviteId: invIn.rows[0].id });
    }

    // mình đã mời họ?
    const invOut = await pool.query(
      `SELECT 1 FROM friend_invites
       WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending'
       LIMIT 1`,
      [meId, otherId],
    );
    if (invOut.rowCount > 0) {
      return res.json({ kind: 'invitedByMe' });
    }

    return res.json({ kind: 'none' });
  } catch (err) {
    console.error('getRelationWithUser error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// ================= GROUPS =================

// GET /api/contacts/groups?limit=200&q=...
export async function listGroups(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
    const q = (req.query.q || '').trim();

    // last_activity = lớn nhất giữa thời điểm tạo nhóm và tin nhắn mới nhất
    // preview: text message mới nhất (nếu có)
    const sql = `
      WITH my_groups AS (
        SELECT c.id, c.title, c.created_at, c.avatar_asset_id
        FROM conversations c
        JOIN conversation_members cm ON cm.conversation_id = c.id
        WHERE cm.user_id = $1 AND c.type = 'group'
      ),
      last_msg AS (
        SELECT m.conversation_id, MAX(m.created_at) AS last_msg_at
        FROM messages m
        GROUP BY m.conversation_id
      ),
      last_text AS (
        SELECT DISTINCT ON (m.conversation_id)
               m.conversation_id, m.text, m.created_at
        FROM messages m
        WHERE m.type = 'text'
        ORDER BY m.conversation_id, m.created_at DESC
      ),
      counts AS (
        SELECT conversation_id, COUNT(*) AS member_count
        FROM conversation_members
        GROUP BY conversation_id
      )
      SELECT g.id,
             g.title,
             a.url AS avatar_url,
             COALESCE(cnt.member_count, 1) AS member_count,
             COALESCE(lt.text, NULL) AS last_text,
             GREATEST(g.created_at, COALESCE(lm.last_msg_at, g.created_at)) AS last_activity_at
      FROM my_groups g
      LEFT JOIN last_msg lm ON lm.conversation_id = g.id
      LEFT JOIN last_text lt ON lt.conversation_id = g.id
      LEFT JOIN counts cnt ON cnt.conversation_id = g.id
      LEFT JOIN assets a ON a.id = g.avatar_asset_id
      WHERE ($2 = '' OR g.title ILIKE '%' || $2 || '%')
      ORDER BY last_activity_at DESC
      LIMIT $3
    `;
    const rs = await pool.query(sql, [meId, q, limit]);

    const groups = rs.rows.map(r => ({
      id: r.id,
      title: r.title,
      avatarUrl: r.avatar_url,
      memberCount: Number(r.member_count) || 1,
      muted: false, // TODO: nếu có bảng mute thì map vào
      lastActivityAt: r.last_activity_at,
      lastMessagePreview: r.last_text || null,
      isManaged: false, // TODO: nếu có role admin/owner có thể set true
    }));

    return res.json({ groups });
  } catch (err) {
    console.error('listGroups error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/contacts/groups
// { title: string, memberIds: [userId,...], avatarAssetId?: uuid }
export async function createGroup(req, res) {
  const client = await pool.connect();
  try {
    const meId = req.user?.sub;
    if (!meId) {
      client.release();
      return res.status(401).json({ message: 'Unauthenticated' });
    }
    const { title, memberIds = [], avatarAssetId = null } = req.body || {};
    const name = (title || '').trim();

    if (!name) {
      client.release();
      return res.status(400).json({ message: 'Thiếu title' });
    }

    // đảm bảo uniqueness trong danh sách input và không tự thêm trùng meId
    const uniqueMembers = Array.from(new Set(memberIds.filter(id => id && id !== meId)));

    // phải có ít nhất 2 người (mình + 1)
    if (uniqueMembers.length < 1) {
      client.release();
      return res.status(400).json({ message: 'Cần ít nhất 2 thành viên (bao gồm bạn)' });
    }

    await client.query('BEGIN');

    // tạo conversation group
    const insConv = await client.query(
      `INSERT INTO conversations (type, title, avatar_asset_id)
       VALUES ('group', $1, $2)
       RETURNING id, title`,
      [name, avatarAssetId]
    );
    const conv = insConv.rows[0];

    // thêm thành viên: mình là owner/admin, còn lại member
    await client.query(
      `INSERT INTO conversation_members (conversation_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [conv.id, meId]
    );

    for (const uid of uniqueMembers) {
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (conversation_id, user_id) DO NOTHING`,
        [conv.id, uid]
      );
    }

    await client.query('COMMIT');
    client.release();

    return res.status(201).json({
      conversation: { id: conv.id, title: conv.title }
    });
  } catch (err) {
    await pool.query('ROLLBACK');
    console.error('createGroup error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  } finally {
    try { client.release(); } catch (_) {}
  }
}
// POST /api/contacts/block/:id
// POST /api/contacts/block/:id
export async function blockUser(req, res) {
  const client = await pool.connect();
  try {
    const meId = req.user?.sub;
    const otherId = req.params.id;
    if (!meId) {
      client.release();
      return res.status(401).json({ message: 'Unauthenticated' });
    }
    if (!otherId) {
      client.release();
      return res.status(400).json({ message: 'Thiếu id' });
    }
    if (meId === otherId) {
      client.release();
      return res.status(400).json({ message: 'Không thể tự chặn chính mình' });
    }

    await client.query('BEGIN');

    // chỉ cần 1 dòng là đủ để coi như "chặn hoàn toàn"
    await client.query(
      `
      INSERT INTO user_blocks (user_id, target_user_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, target_user_id) DO NOTHING
      `,
      [meId, otherId],
    );

    // xoá quan hệ bạn + lời mời như cũ
    await client.query(
      `
      DELETE FROM user_friends
      WHERE (user_id = $1 AND friend_id = $2)
         OR (user_id = $2 AND friend_id = $1)
      `,
      [meId, otherId],
    );

    await client.query(
      `
      UPDATE friend_invites
      SET status = 'canceled', updated_at = now()
      WHERE (
              (sender_id = $1 AND receiver_id = $2)
           OR (sender_id = $2 AND receiver_id = $1)
            )
        AND status = 'pending'
      `,
      [meId, otherId],
    );

    await client.query('COMMIT');
    client.release();

    emitToUser(meId,   'contacts:friends:changed', { userId: otherId });
    emitToUser(otherId,'contacts:friends:changed', { userId: meId   });

    return res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK');
    client.release();
    console.error('blockUser error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// POST /api/contacts/unblock/:id
export async function unblockUser(req, res) {
  try {
    const meId = req.user?.sub;
    const otherId = req.params.id;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });
    if (!otherId) return res.status(400).json({ message: 'Thiếu id' });
    if (meId === otherId) {
      return res.status(400).json({ message: 'Không thể tự bỏ chặn chính mình' });
    }

    await pool.query(
      `
      DELETE FROM user_blocks
      WHERE user_id = $1 AND target_user_id = $2
      `,
      [meId, otherId],
    );

    emitToUser(meId, 'contacts:friends:changed', { userId: otherId });

    return res.status(204).send();
  } catch (err) {
    console.error('unblockUser error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// DELETE /api/contacts/friends/:id
export async function removeFriend(req, res) {
  try {
    const meId = req.user?.sub;
    const otherId = req.params.id;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });
    if (!otherId) return res.status(400).json({ message: 'Thiếu id' });
    if (meId === otherId) {
      return res.status(400).json({ message: 'Không thể xóa chính mình' });
    }

    await pool.query(
      `
      DELETE FROM user_friends
      WHERE (user_id = $1 AND friend_id = $2)
         OR (user_id = $2 AND friend_id = $1)
      `,
      [meId, otherId],
    );

    emitToUser(meId, 'contacts:friends:changed', { userId: otherId });
    emitToUser(otherId, 'contacts:friends:changed', { userId: meId });

    return res.status(204).send();
  } catch (err) {
    console.error('removeFriend error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
// GET /api/contacts/blocks
export async function listBlockedUsers(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const sql = `
      SELECT
        ub.target_user_id AS user_id,
        ub.created_at,
        u.display_name,
        a.url AS avatar_url
      FROM user_blocks ub
      JOIN users u ON u.id = ub.target_user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE ub.user_id = $1
      ORDER BY u.display_name ASC
    `;
    const rs = await pool.query(sql, [meId]);

    const items = rs.rows.map(r => ({
      id: r.user_id,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      since: r.created_at,
    }));

    return res.json({ items });
  } catch (err) {
    console.error('listBlockedUsers error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
// GET /api/contacts/privacy
export async function getMyPrivacySettings(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    // đảm bảo có row với giá trị default
    await pool.query(
      `
      INSERT INTO user_privacy_settings (user_id)
      VALUES ($1)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [meId],
    );

    const rs = await pool.query(
      `
      SELECT
        birthday_visibility,
        last_seen_visible,
        read_receipts_enabled,
        who_can_message,
        who_can_call
      FROM user_privacy_settings
      WHERE user_id = $1
      `,
      [meId],
    );

    if (rs.rowCount === 0) {
      return res.status(404).json({ message: 'Không tìm thấy cài đặt' });
    }

    const row = rs.rows[0];

    return res.json({
      birthdayVisibility: row.birthday_visibility,        // 'hidden'|'full'|'day_month'
      lastSeenVisible: row.last_seen_visible,             // boolean
      readReceiptsEnabled: row.read_receipts_enabled,     // boolean
      whoCanMessage: row.who_can_message,                 // 'everyone'|'friends'
      whoCanCall: row.who_can_call,                       // 'everyone'|'friends'|'friends_and_previous'
    });
  } catch (err) {
    console.error('getMyPrivacySettings error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// PATCH /api/contacts/privacy
// body: {
//   birthdayVisibility?: 'hidden'|'full'|'day_month',
//   lastSeenVisible?: boolean,
//   readReceiptsEnabled?: boolean,
//   whoCanMessage?: 'everyone'|'friends',
//   whoCanCall?: 'everyone'|'friends'|'friends_and_previous'
// }
export async function updateMyPrivacySettings(req, res) {
  try {
    const meId = req.user?.sub;
    if (!meId) return res.status(401).json({ message: 'Unauthenticated' });

    const {
      birthdayVisibility,
      lastSeenVisible,
      readReceiptsEnabled,
      whoCanMessage,
      whoCanCall,
    } = req.body || {};

    if (birthdayVisibility != null) {
      const allowed = ['hidden', 'full', 'day_month'];
      if (!allowed.includes(birthdayVisibility)) {
        return res.status(400).json({ message: 'birthdayVisibility không hợp lệ' });
      }
    }

    if (whoCanMessage != null) {
      const allowed = ['everyone', 'friends'];
      if (!allowed.includes(whoCanMessage)) {
        return res.status(400).json({ message: 'whoCanMessage không hợp lệ' });
      }
    }

    if (whoCanCall != null) {
      const allowed = ['everyone', 'friends', 'friends_and_previous'];
      if (!allowed.includes(whoCanCall)) {
        return res.status(400).json({ message: 'whoCanCall không hợp lệ' });
      }
    }

    const rs = await pool.query(
      `
      INSERT INTO user_privacy_settings (
        user_id,
        birthday_visibility,
        last_seen_visible,
        read_receipts_enabled,
        who_can_message,
        who_can_call
      )
      VALUES (
        $1,
        COALESCE($2, 'full'),
        COALESCE($3, true),
        COALESCE($4, true),
        COALESCE($5, 'everyone'),
        COALESCE($6, 'everyone')
      )
      ON CONFLICT (user_id) DO UPDATE SET
        birthday_visibility   = COALESCE($2, user_privacy_settings.birthday_visibility),
        last_seen_visible     = COALESCE($3, user_privacy_settings.last_seen_visible),
        read_receipts_enabled = COALESCE($4, user_privacy_settings.read_receipts_enabled),
        who_can_message       = COALESCE($5, user_privacy_settings.who_can_message),
        who_can_call          = COALESCE($6, user_privacy_settings.who_can_call),
        updated_at            = now()
      RETURNING
        birthday_visibility,
        last_seen_visible,
        read_receipts_enabled,
        who_can_message,
        who_can_call
      `,
      [
        meId,
        birthdayVisibility ?? null,
        typeof lastSeenVisible === 'boolean' ? lastSeenVisible : null,
        typeof readReceiptsEnabled === 'boolean' ? readReceiptsEnabled : null,
        whoCanMessage ?? null,
        whoCanCall ?? null,
      ],
    );

    const row = rs.rows[0];

    return res.json({
      birthdayVisibility: row.birthday_visibility,
      lastSeenVisible: row.last_seen_visible,
      readReceiptsEnabled: row.read_receipts_enabled,
      whoCanMessage: row.who_can_message,
      whoCanCall: row.who_can_call,
    });
  } catch (err) {
    console.error('updateMyPrivacySettings error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
