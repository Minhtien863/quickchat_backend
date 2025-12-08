// src/controllers/notes.controller.js
import { pool } from '../db.js';

// Lấy ghi chú hiện tại của user
export async function getMyNote(req, res) {
  const userId = req.user.sub;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        n.id,
        n.owner_id,
        n.text,
        n.music_title,
        n.created_at,
        n.expires_at,
        n.visibility,
        u.display_name,
        a.url AS avatar_url
      FROM user_notes_24h n
      JOIN users u ON u.id = n.owner_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE n.owner_id = $1
      ORDER BY n.created_at DESC
      LIMIT 1
      `,
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Chưa có ghi chú' });
    }

    const n = rows[0];

    return res.json({
      note: {
        id: n.id,
        ownerId: n.owner_id,
        ownerName: n.display_name,
        ownerAvatarUrl: n.avatar_url,
        text: n.text ?? '',
        musicTitle: n.music_title,
        createdAt: n.created_at,
        expiresAt: n.expires_at,
        visibility: n.visibility,
        isMine: true,
      },
    });
  } catch (err) {
    console.error('getMyNote error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// Tạo / cập nhật ghi chú 24h của mình
export async function upsertMyNote(req, res) {
  const userId = req.user.sub;
  const { text } = req.body || {};

  const trimmed = (typeof text === 'string' ? text.trim() : '');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    const { rows } = await pool.query(
      `
      INSERT INTO user_notes_24h (owner_id, text, music_title, created_at, expires_at, visibility)
      VALUES ($1, $2, NULL, now(), $3, 'friends')
      ON CONFLICT (owner_id)
      DO UPDATE SET
        text        = EXCLUDED.text,
        music_title = EXCLUDED.music_title,
        created_at  = now(),
        expires_at  = EXCLUDED.expires_at,
        visibility  = EXCLUDED.visibility
      RETURNING *
      `,
      [userId, trimmed, expiresAt],
    );

    const n = rows[0];

        try {
      await pool.query(
        `
        INSERT INTO user_note_notifications (user_id, kind, actor_user_id, note_id, message)
        SELECT
          f.friend_id,                       -- bạn của owner
          'new_note_from_friend',
          $1::uuid,                          -- owner
          $2::uuid,                          -- note id
          'vừa đăng một ghi chú mới.'
        FROM user_friends f
        WHERE f.user_id = $1
        `,
        [userId, n.id],
      );
    } catch (notifyErr) {
      console.error('upsertMyNote notify friends error:', notifyErr);
      // không throw, tránh làm hỏng logic chính
    }

    // lấy thêm info user
    const uRes = await pool.query(
      `
      SELECT display_name, avatar_asset_id
      FROM users
      WHERE id = $1
      `,
      [userId],
    );
    const u = uRes.rows[0] || {};
    let avatarUrl = null;
    if (u.avatar_asset_id) {
      const aRes = await pool.query(
        `SELECT url FROM assets WHERE id = $1`,
        [u.avatar_asset_id],
      );
      avatarUrl = aRes.rows[0]?.url || null;
    }

    return res.json({
      note: {
        id: n.id,
        ownerId: n.owner_id,
        ownerName: u.display_name,
        ownerAvatarUrl: avatarUrl,
        text: n.text ?? '',
        musicTitle: n.music_title,
        createdAt: n.created_at,
        expiresAt: n.expires_at,
        visibility: n.visibility,
        isMine: true,
      },
    });
  } catch (err) {
    console.error('upsertMyNote error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// Feed ghi chú (bạn bè + mình)
export async function getNotesFeed(req, res) {
  const userId = req.user.sub;

  try {
    const { rows } = await pool.query(
      `
      SELECT
        n.id,
        n.owner_id,
        n.text,
        n.music_title,
        n.created_at,
        n.expires_at,
        n.visibility,
        u.display_name,
        a.url AS avatar_url,
        (n.owner_id = $1) AS is_mine
      FROM user_notes_24h n
      JOIN users u ON u.id = n.owner_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE n.expires_at > now()
        AND (
          n.owner_id = $1
          OR n.visibility = 'public'
          OR (
            n.visibility = 'friends'
            AND EXISTS (
              SELECT 1 FROM user_friends f
              WHERE f.user_id = $1 AND f.friend_id = n.owner_id
            )
          )
        )
      ORDER BY n.created_at DESC
      `,
      [userId],
    );

    const list = rows.map(n => ({
      id: n.id,
      ownerId: n.owner_id,
      ownerName: n.display_name,
      ownerAvatarUrl: n.avatar_url,
      text: n.text ?? '',
      musicTitle: n.music_title,
      createdAt: n.created_at,
      expiresAt: n.expires_at,
      visibility: n.visibility,
      isMine: n.is_mine,
    }));

    return res.json(list);
  } catch (err) {
    console.error('getNotesFeed error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// Xoá ghi chú 24h của chính mình
export async function deleteMyNote(req, res) {
  const userId = req.user.sub;

  try {
    const { rows } = await pool.query(
      `
      DELETE FROM user_notes_24h
      WHERE owner_id = $1
      RETURNING id
      `,
      [userId],
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Không có ghi chú để xoá' });
    }

    return res.json({ success: true, noteId: rows[0].id });
  } catch (err) {
    console.error('deleteMyNote error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

// Ghi nhận view + tạo thông báo cho owner (chỉ lần đầu 1 user xem)
export async function markNoteViewed(req, res, next) {
  try {
    const noteId = req.params.id;
    const viewerId = req.user.sub;

    // tìm owner của note
    const noteRes = await pool.query(
      `SELECT owner_id FROM user_notes_24h WHERE id = $1`,
      [noteId],
    );
    if (!noteRes.rowCount) {
      return res.status(404).json({ message: 'Ghi chú không tồn tại' });
    }
    const ownerId = noteRes.rows[0].owner_id;

    // owner tự xem note thì bỏ qua (frontend vốn không gọi, nhưng phòng hờ)
    if (ownerId === viewerId) {
      return res.json({ success: true });
    }

    const viewRes = await pool.query(
      `
      INSERT INTO user_note_views (note_id, user_id, first_viewed_at, last_viewed_at, view_count)
      VALUES ($1, $2, now(), now(), 1)
      ON CONFLICT (note_id, user_id)
      DO UPDATE SET
        last_viewed_at = now(),
        view_count     = user_note_views.view_count + 1
      RETURNING view_count
      `,
      [noteId, viewerId],
    );

    const viewCount = viewRes.rows[0]?.view_count ?? 1;

    // chỉ tạo noti khi đây là lần đầu user này xem ghi chú
    if (viewCount === 1) {
      try {
        await pool.query(
          `
          INSERT INTO user_note_notifications (user_id, kind, actor_user_id, note_id, message)
          VALUES ($1, 'activity_on_my_note', $2, $3, 'đã xem ghi chú của bạn.')
          `,
          [ownerId, viewerId, noteId],
        );
      } catch (notifyErr) {
        console.error('markNoteViewed notify error:', notifyErr);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('markNoteViewed error:', err);
    return next(err);
  }
}


// Thả / đổi reaction (chỉ giữ reaction gần nhất) + tạo thông báo cho owner
export async function setNoteReaction(req, res, next) {
  try {
    const noteId = req.params.id;
    const userId = req.user.sub;
    const { emoji } = req.body;

    if (!emoji || typeof emoji !== 'string') {
      return res.status(400).json({ message: 'Emoji không hợp lệ' });
    }

    // Lấy owner của note
    const noteRes = await pool.query(
      `SELECT owner_id FROM user_notes_24h WHERE id = $1`,
      [noteId],
    );
    if (!noteRes.rowCount) {
      return res.status(404).json({ message: 'Ghi chú không tồn tại' });
    }
    const ownerId = noteRes.rows[0].owner_id;

    await pool.query(
      `
      INSERT INTO user_note_reactions (note_id, user_id, emoji)
      VALUES ($1, $2, $3)
      ON CONFLICT (note_id, user_id)
      DO UPDATE SET
        emoji      = EXCLUDED.emoji,
        created_at = now()
      `,
      [noteId, userId, emoji],
    );

    // Không gửi thông báo nếu owner tự thả reaction
    if (ownerId !== userId) {
      try {
        await pool.query(
          `
          INSERT INTO user_note_notifications (user_id, kind, actor_user_id, note_id, message)
          VALUES ($1, 'activity_on_my_note', $2, $3, $4)
          `,
          [
            ownerId,
            userId,
            noteId,
            `đã thả ${emoji} vào ghi chú của bạn.`,
          ],
        );
      } catch (notifyErr) {
        console.error('setNoteReaction notify error:', notifyErr);
      }
    }

    return res.json({ success: true });
  } catch (err) {
    console.error('setNoteReaction error:', err);
    return next(err);
  }
}

// Lấy danh sách người xem + reaction
export async function getNoteActivity(req, res, next) {
  try {
    const noteId = req.params.id;
    const userId = req.user.sub;   // <-- đổi sang sub

    // chỉ owner note mới xem được activity
    const noteRes = await pool.query(
      `SELECT owner_id FROM user_notes_24h WHERE id = $1 AND expires_at > now()`,
      [noteId],
    );
    if (!noteRes.rowCount || noteRes.rows[0].owner_id !== userId) {
      return res.status(403).json({ message: 'Không có quyền xem hoạt động' });
    }

    const viewsRes = await pool.query(
      `
      SELECT v.user_id,
             u.display_name,
             a.url AS avatar_url,
             v.first_viewed_at,
             v.last_viewed_at,
             v.view_count
      FROM user_note_views v
      JOIN users u ON u.id = v.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE v.note_id = $1
      ORDER BY v.last_viewed_at DESC
      `,
      [noteId],
    );

    const reactionsRes = await pool.query(
      `
      SELECT r.user_id,
             u.display_name,
             a.url AS avatar_url,
             r.emoji,
             r.created_at
      FROM user_note_reactions r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE r.note_id = $1
      ORDER BY r.created_at DESC
      `,
      [noteId],
    );

    return res.json({
      views: viewsRes.rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        firstViewedAt: r.first_viewed_at,
        lastViewedAt: r.last_viewed_at,
        viewCount: r.view_count,
      })),
      reactions: reactionsRes.rows.map((r) => ({
        userId: r.user_id,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
        emoji: r.emoji,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('getNoteActivity error:', err);
    return next(err);
  }
}

// Lấy danh sách thông báo về ghi chú của user
export async function listNoteNotifications(req, res, next) {
  try {
    const userId = req.user.sub;
    const limit = Number(req.query.limit) || 50;

    // Auto sinh thông báo "ghi chú đã hết hạn" nếu chưa tạo
    try {
      await pool.query(
        `
        INSERT INTO user_note_notifications (user_id, kind, note_id, message)
        SELECT
          $1::uuid,
          'my_note_expired',
          n.id,
          'Ghi chú của bạn đã hết 24 giờ, hãy tạo ghi chú mới.'
        FROM user_notes_24h n
        WHERE n.owner_id = $1
          AND n.expires_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM user_note_notifications un
            WHERE un.user_id = $1
              AND un.kind    = 'my_note_expired'
              AND un.note_id = n.id
          )
        `,
        [userId],
      );
    } catch (expiredErr) {
      console.error('listNoteNotifications create expired noti error:', expiredErr);
    }

    const { rows } = await pool.query(
      `
      SELECT
        un.id,
        un.kind,
        un.message,
        un.created_at,
        un.is_read,
        un.actor_user_id,
        u.display_name AS actor_name,
        a.url          AS actor_avatar_url,
        un.note_id
      FROM user_note_notifications un
      LEFT JOIN users  u ON u.id = un.actor_user_id
      LEFT JOIN assets a ON a.id = u.avatar_asset_id
      WHERE un.user_id = $1
      ORDER BY un.created_at DESC
      LIMIT $2
      `,
      [userId, limit],
    );

    return res.json(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        message: r.message,
        createdAt: r.created_at,
        isRead: r.is_read,
        actorUserId: r.actor_user_id,
        actorName: r.actor_name,
        actorAvatarUrl: r.actor_avatar_url,
        noteId: r.note_id,
      })),
    );
  } catch (err) {
    console.error('listNoteNotifications error:', err);
    return next(err);
  }
}

// Đánh dấu 1 thông báo là đã đọc
export async function markNoteNotificationRead(req, res, next) {
  try {
    const userId = req.user.sub;
    const id = req.params.id;

    await pool.query(
      `
      UPDATE user_note_notifications
      SET is_read = true
      WHERE id = $1 AND user_id = $2
      `,
      [id, userId],
    );

    return res.json({ success: true });
  } catch (err) {
    console.error('markNoteNotificationRead error:', err);
    return next(err);
  }
}
