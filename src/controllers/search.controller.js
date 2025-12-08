// src/controllers/search.controller.js
import { pool } from '../db.js';

function norm(q) {
  const s = (q || '').trim();
  return s.length ? s : null;
}

function isEmail(q) {
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(q);
}

function isHandle(q) {
  return /^@?[a-z0-9_.]{3,30}$/.test(q);
}

function onlyDigits(s) {
  return (s || '').replace(/\D/g, '');
}

function isPhoneLike(q) {
  const d = onlyDigits(q);
  return d.length >= 9 && d.length <= 15;
}

// GET /api/search/global?q=...&limit=20
export async function searchGlobal(req, res) {
  try {
    const userId = req.user?.sub;
    const q = norm(req.query.q);
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 50);

    if (!userId || !q) {
      return res.json({
        people: { friends: [], contacted: [] },
        groups: [],
        messages: [],
      });
    }

    const emailMode = isEmail(q);
    const handleMode = !emailMode && isHandle(q);
    const phoneMode = !emailMode && !handleMode && isPhoneLike(q);

    // ------- PEOPLE: FRIENDS -------
    let friendsRes;
    if (emailMode) {
      const sql = `
        WITH f AS ( SELECT friend_id FROM user_friends WHERE user_id = $1 )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN f ON f.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE u.email ILIKE $2
          AND u.id <> $1
        LIMIT $3
      `;
      friendsRes = await pool.query(sql, [userId, q, limit]);
    } else if (handleMode) {
      const handle = q.startsWith('@') ? q.slice(1) : q;
      const sql = `
        WITH f AS ( SELECT friend_id FROM user_friends WHERE user_id = $1 )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN f ON f.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE u.username ILIKE $2 || '%'
          AND u.id <> $1
        LIMIT $3
      `;
      friendsRes = await pool.query(sql, [userId, handle, limit]);
    } else if (phoneMode) {
      const digits = onlyDigits(q);
      const sql = `
        WITH f AS ( SELECT friend_id FROM user_friends WHERE user_id = $1 )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN f ON f.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE regexp_replace(coalesce(u.phone,''), '\\D', '', 'g') LIKE '%' || $2 || '%'
          AND u.id <> $1
        LIMIT $3
      `;
      friendsRes = await pool.query(sql, [userId, digits, limit]);
    } else {
      const sql = `
        WITH f AS ( SELECT friend_id FROM user_friends WHERE user_id = $1 )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url,
               ts_rank(u.search_tsv, plainto_tsquery('simple', unaccent($2))) AS rank
        FROM users u
        JOIN f ON f.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE (
          u.search_tsv @@ plainto_tsquery('simple', unaccent($2))
          OR unaccent(lower(u.email)) LIKE unaccent(lower($3))
        )
          AND u.id <> $1
        ORDER BY rank DESC NULLS LAST, u.display_name ASC
        LIMIT $4
      `;
      friendsRes = await pool.query(sql, [userId, q, `%${q}%`, limit]);
    }

    // ------- PEOPLE: CONTACTED (đã chat 1-1 nhưng chưa là bạn) -------
    let contactedRes;
    if (emailMode) {
      const sql = `
        WITH my_friends AS ( 
          SELECT friend_id FROM user_friends WHERE user_id = $1 
        ),
        directs AS (
          SELECT cm2.user_id AS other_id
          FROM conversations c
          JOIN conversation_members cm1 
            ON cm1.conversation_id = c.id 
           AND cm1.user_id = $1
          JOIN conversation_members cm2 
            ON cm2.conversation_id = c.id 
           AND cm2.user_id <> $1
          WHERE c.type = 'direct'
        )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN directs d ON d.other_id = u.id
        LEFT JOIN my_friends mf ON mf.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE mf.friend_id IS NULL
          AND u.email ILIKE $2
          AND u.id <> $1
        GROUP BY u.id, a.url
        LIMIT $3
      `;
      contactedRes = await pool.query(sql, [userId, q, limit]);
    } else if (handleMode) {
      const handle = q.startsWith('@') ? q.slice(1) : q;
      const sql = `
        WITH my_friends AS ( 
          SELECT friend_id FROM user_friends WHERE user_id = $1 
        ),
        directs AS (
          SELECT cm2.user_id AS other_id
          FROM conversations c
          JOIN conversation_members cm1 
            ON cm1.conversation_id = c.id 
           AND cm1.user_id = $1
          JOIN conversation_members cm2 
            ON cm2.conversation_id = c.id 
           AND cm2.user_id <> $1
          WHERE c.type = 'direct'
        )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN directs d ON d.other_id = u.id
        LEFT JOIN my_friends mf ON mf.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE mf.friend_id IS NULL
          AND u.username ILIKE $2 || '%'
          AND u.id <> $1
        GROUP BY u.id, a.url
        LIMIT $3
      `;
      contactedRes = await pool.query(sql, [userId, handle, limit]);
    } else if (phoneMode) {
      const digits = onlyDigits(q);
      const sql = `
        WITH my_friends AS ( 
          SELECT friend_id FROM user_friends WHERE user_id = $1 
        ),
        directs AS (
          SELECT cm2.user_id AS other_id
          FROM conversations c
          JOIN conversation_members cm1 
            ON cm1.conversation_id = c.id 
           AND cm1.user_id = $1
          JOIN conversation_members cm2 
            ON cm2.conversation_id = c.id 
           AND cm2.user_id <> $1
          WHERE c.type = 'direct'
        )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url
        FROM users u
        JOIN directs d ON d.other_id = u.id
        LEFT JOIN my_friends mf ON mf.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE mf.friend_id IS NULL
          AND regexp_replace(coalesce(u.phone,''), '\\D', '', 'g') LIKE '%' || $2 || '%'
          AND u.id <> $1
        GROUP BY u.id, a.url
        LIMIT $3
      `;
      contactedRes = await pool.query(sql, [userId, digits, limit]);
    } else {
      const sql = `
        WITH my_friends AS ( 
          SELECT friend_id FROM user_friends WHERE user_id = $1 
        ),
        directs AS (
          SELECT cm2.user_id AS other_id
          FROM conversations c
          JOIN conversation_members cm1 
            ON cm1.conversation_id = c.id 
           AND cm1.user_id = $1
          JOIN conversation_members cm2 
            ON cm2.conversation_id = c.id 
           AND cm2.user_id <> $1
          WHERE c.type = 'direct'
        )
        SELECT u.id, u.display_name, u.username, u.email, u.phone, a.url AS avatar_url,
               ts_rank(u.search_tsv, plainto_tsquery('simple', unaccent($2))) AS rank
        FROM users u
        JOIN directs d ON d.other_id = u.id
        LEFT JOIN my_friends mf ON mf.friend_id = u.id
        LEFT JOIN assets a ON a.id = u.avatar_asset_id
        WHERE mf.friend_id IS NULL
          AND (
            u.search_tsv @@ plainto_tsquery('simple', unaccent($2))
            OR unaccent(lower(u.email)) LIKE unaccent(lower($3))
          )
          AND u.id <> $1
        GROUP BY u.id, a.url, rank
        ORDER BY rank DESC NULLS LAST, u.display_name ASC
        LIMIT $4
      `;
      contactedRes = await pool.query(sql, [userId, q, `%${q}%`, limit]);
    }

    // ------- MESSAGES -------
    const messagesSql = `
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.text,
        m.created_at,
        su.display_name AS sender_display_name,
        sa.url AS sender_avatar_url,
        c.type          AS conversation_type,
        c.title         AS conversation_title,
        ca.url          AS conversation_avatar_url
      FROM messages m
      JOIN conversation_members cm
        ON cm.conversation_id = m.conversation_id
       AND cm.user_id = $1
      LEFT JOIN hidden_conversations hc
        ON hc.conversation_id = m.conversation_id
       AND hc.user_id = $1
      LEFT JOIN user_conversation_clears ucc
        ON ucc.conversation_id = m.conversation_id
       AND ucc.user_id = $1
      LEFT JOIN users su ON su.id = m.sender_id
      LEFT JOIN assets sa ON sa.id = su.avatar_asset_id
      LEFT JOIN conversations c
        ON c.id = m.conversation_id
      LEFT JOIN assets ca
        ON ca.id = c.avatar_asset_id
      WHERE m.type = 'text'
        AND m.deleted_at IS NULL
        AND hc.user_id IS NULL
        AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
        AND unaccent(lower(m.text)) LIKE unaccent(lower($2))
      ORDER BY m.created_at DESC
      LIMIT $3
    `;
    const messagesRes = await pool.query(messagesSql, [userId, `%${q}%`, limit]);

    // ------- GROUPS -------
    const groupsSql = `
      SELECT
        c.id,
        c.type,
        c.title,
        ca.url AS avatar_url
      FROM conversations c
      JOIN conversation_members cm
        ON cm.conversation_id = c.id
       AND cm.user_id = $1
      LEFT JOIN assets ca
        ON ca.id = c.avatar_asset_id
      WHERE c.type = 'group'
        AND unaccent(lower(c.title)) LIKE unaccent(lower($2))
      ORDER BY c.title ASC
      LIMIT $3
    `;
    const groupsRes = await pool.query(groupsSql, [userId, `%${q}%`, limit]);

    return res.json({
      people: {
        friends: friendsRes.rows,
        contacted: contactedRes.rows,
      },
      groups: groupsRes.rows,
      messages: messagesRes.rows,
    });
  } catch (err) {
    console.error('searchGlobal error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}

/**
 * GET /api/search/conversation/:conversationId?q=xxx&limit=50
 */
export async function searchConversationMessages(req, res) {
  try {
    const userId = req.user?.sub;
    const { conversationId } = req.params;
    const q = norm(req.query.q);
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);

    if (!userId || !conversationId || !q) {
      return res.json({ items: [] });
    }

    const mres = await pool.query(
      `SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
      [conversationId, userId],
    );
    if (mres.rowCount === 0) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const sql = `
      SELECT m.id, m.conversation_id, m.sender_id, m.text, m.created_at
      FROM messages m
      LEFT JOIN user_conversation_clears ucc
        ON ucc.conversation_id = m.conversation_id
       AND ucc.user_id = $2
      WHERE m.conversation_id = $1
        AND m.type = 'text'
        AND m.deleted_at IS NULL
        AND (ucc.cleared_at IS NULL OR m.created_at > ucc.cleared_at)
        AND unaccent(lower(m.text)) LIKE unaccent(lower($3))
      ORDER BY m.created_at ASC
      LIMIT $4
    `;
    const rs = await pool.query(sql, [conversationId, userId, `%${q}%`, limit]);
    return res.json({ items: rs.rows });
  } catch (err) {
    console.error('searchConversationMessages error:', err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
}
